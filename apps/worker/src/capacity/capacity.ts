// Phase 10 capacity meter + funding-pause policy.
//
// Measures current load from the store/reader (and optional evidence/review
// probes) and grades it green/amber/red against hard caps. Red means the hard
// cap is already exceeded: new funding should pause. Pause is funding-only —
// existing funded rights are preserved and immutable (P-14, P-15).
import type { Address, Hash } from "viem";
import type { ChainReader } from "@midman/chain";
import type { Store } from "@midman/store";
import { listKnownDealIds } from "@midman/store";

export const PAUSE_NOTE =
  "New funding paused only; existing funded rights are preserved and immutable (P-14/P-15: no retroactive bond increases or caps).";

/** Fraction of a cap at which capacity turns amber. */
export const AMBER_THRESHOLD = 0.8;

const MAX_RELAY_SCAN = 1_000;
const ESCALATED_PHASES = new Set([4, 5, 6, 7, 8]);

export interface CapacityLoad {
  readonly activeEscalated: number;
  readonly openRelayJobs: number;
  readonly evidenceCount: number;
  readonly reviewerPending: number;
  readonly apiWindowQps?: number;
  /**
   * Probes that could not be measured. A missing probe is reported as
   * unknown/degraded rather than silently counted as zero usage.
   */
  readonly probesMissing?: string[];
}

export interface CapacityLimits {
  readonly activeEscalated: number;
  readonly openRelayJobs: number;
  readonly evidenceCount: number;
  readonly reviewerPending: number;
  readonly apiWindowQps?: number;
}

export interface CapacityAssessment {
  readonly state: "green" | "amber" | "red";
  readonly notes: string[];
}

interface CapacityCheck {
  readonly name: string;
  readonly value: number;
  readonly limit: number;
}

function evaluate(check: CapacityCheck, notes: string[]): "green" | "amber" | "red" {
  if (check.limit <= 0) {
    if (check.value > 0) {
      notes.push(`${check.name}: ${check.value}/${check.limit} exceeds hard cap`);
      return "red";
    }
    return "green";
  }
  if (check.value > check.limit) {
    notes.push(`${check.name}: ${check.value}/${check.limit} exceeds hard cap`);
    return "red";
  }
  if (check.value / check.limit >= AMBER_THRESHOLD) {
    notes.push(`${check.name}: ${check.value}/${check.limit} at >= 80% of cap`);
    return "amber";
  }
  return "green";
}

/** Pure load grading. Red when any hard cap is exceeded, amber at >= 80%. */
export function assess(load: CapacityLoad, limits: CapacityLimits): CapacityAssessment {
  const checks: CapacityCheck[] = [
    { name: "activeEscalated", value: load.activeEscalated, limit: limits.activeEscalated },
    { name: "openRelayJobs", value: load.openRelayJobs, limit: limits.openRelayJobs },
    { name: "evidenceCount", value: load.evidenceCount, limit: limits.evidenceCount },
    { name: "reviewerPending", value: load.reviewerPending, limit: limits.reviewerPending },
  ];
  if (limits.apiWindowQps !== undefined && load.apiWindowQps !== undefined) {
    checks.push({ name: "apiWindowQps", value: load.apiWindowQps, limit: limits.apiWindowQps });
  }

  const notes: string[] = [];
  let state: CapacityAssessment["state"] = "green";
  for (const check of checks) {
    const outcome = evaluate(check, notes);
    if (outcome === "red") {
      state = "red";
    } else if (outcome === "amber" && state === "green") {
      state = "amber";
    }
  }
  // Missing probes are unknown, not zero: degrade at least to amber and say so.
  const missing = load.probesMissing ?? [];
  if (missing.length > 0) {
    notes.push(`degraded: unmeasured probes (${missing.join(", ")}); usage is unknown, not zero`);
    if (state === "green") state = "amber";
  }
  if (state === "red") notes.push(PAUSE_NOTE);
  return { state, notes };
}

/** Pause new funding only when red; funded rights are never touched. */
export function pauseRecommendation(assessment: CapacityAssessment): boolean {
  return assessment.state === "red";
}

export interface CapacityMeterDeps {
  readonly store: Pick<Store, "listQueuedRelay" | "listDealIds" | "listChainEventDealIds">;
  readonly reader?: ChainReader | null;
  readonly hub?: Address | null;
  /** Optional probes for systems outside store/reader (default 0 when absent). */
  readonly evidenceCount?: () => number | Promise<number>;
  readonly reviewerPending?: () => number | Promise<number>;
  readonly apiWindowQps?: () => number | null | Promise<number | null>;
}

/** Measures current load; chain reads are best-effort and never throw out. */
export class CapacityMeter {
  constructor(private readonly deps: CapacityMeterDeps) {}

  async measure(): Promise<CapacityLoad> {
    const openRelayJobs = (await this.deps.store.listQueuedRelay("relay", MAX_RELAY_SCAN)).length;
    const probesMissing: string[] = [];
    let activeEscalated = 0;
    if (!this.deps.reader || !this.deps.hub) {
      probesMissing.push("activeEscalated");
    } else {
      activeEscalated = await this.countActiveEscalated();
    }
    let evidenceCount = 0;
    if (this.deps.evidenceCount) evidenceCount = await this.deps.evidenceCount();
    else probesMissing.push("evidenceCount");
    let reviewerPending = 0;
    if (this.deps.reviewerPending) reviewerPending = await this.deps.reviewerPending();
    else probesMissing.push("reviewerPending");
    const base: CapacityLoad = { activeEscalated, openRelayJobs, evidenceCount, reviewerPending };
    if (this.deps.apiWindowQps) {
      const qps = await this.deps.apiWindowQps();
      if (qps !== null) return { ...base, apiWindowQps: qps, probesMissing };
    }
    return { ...base, probesMissing };
  }

  private async countActiveEscalated(): Promise<number> {
    const { reader, hub } = this.deps;
    if (!reader || !hub) return 0;
    let count = 0;
    for (const dealId of await listKnownDealIds(this.deps.store as unknown as Store)) {
      let deal: Record<string, bigint | string | boolean | number>;
      try {
        deal = await reader.getDeal(hub, dealId as Hash);
      } catch {
        continue;
      }
      if (deal["funded"] !== true) continue;
      if (!ESCALATED_PHASES.has(Number(deal["phase"]))) continue;
      if (Number(deal["escalatedAt"]) <= 0) continue;
      count += 1;
    }
    return count;
  }
}

/**
 * Durable admission context derived from chain + store (not caller-supplied):
 * protocol-wide active-escalated count and 24h pair exposure. Missing probes
 * (no reader/hub) are reported as degraded so admission can fail closed rather
 * than assume zero usage.
 */
export async function durableAdmissionContext(input: {
  readonly store: Pick<Store, "listDealIds" | "listChainEventDealIds" | "listQueuedRelay">;
  readonly reader: ChainReader | null;
  readonly hub: Address | null;
  readonly buyer: string;
  readonly seller: string;
  readonly nowSeconds: number;
}): Promise<{ activeEscalatedCount: number; pairExposure24hUnits: bigint; degraded: boolean }> {
  const { reader, hub, nowSeconds } = input;
  if (!reader || !hub) {
    return { activeEscalatedCount: 0, pairExposure24hUnits: 0n, degraded: true };
  }
  let activeEscalatedCount = 0;
  let pairExposure24hUnits = 0n;
  let readFailures = 0;
  const since = BigInt(nowSeconds) - 86_400n;
  for (const dealId of await listKnownDealIds(input.store as unknown as Store)) {
    let deal: Record<string, bigint | string | boolean | number>;
    try {
      deal = await reader.getDeal(hub, dealId as Hash);
    } catch {
      // An unreadable deal is UNKNOWN exposure, not zero: degrade so admission
      // fails closed instead of believing the pair/protocol is idle.
      readFailures += 1;
      continue;
    }
    if (deal["funded"] !== true) continue;
    if (ESCALATED_PHASES.has(Number(deal["phase"])) && Number(deal["escalatedAt"]) > 0) {
      activeEscalatedCount += 1;
    }
    const buyer = String(deal["buyer"] ?? "").toLowerCase();
    const seller = String(deal["seller"] ?? "").toLowerCase();
    const wantBuyer = input.buyer.toLowerCase();
    const wantSeller = input.seller.toLowerCase();
    const pairMatches =
      (buyer === wantBuyer && seller === wantSeller) || (buyer === wantSeller && seller === wantBuyer);
    const fundedAt = toBigUnits(deal["fundedAt"]);
    if (pairMatches && fundedAt >= since) {
      pairExposure24hUnits += toBigUnits(deal["principal"]);
    }
  }
  return { activeEscalatedCount, pairExposure24hUnits, degraded: readFailures > 0 };
}

function toBigUnits(value: bigint | string | number | boolean | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}
