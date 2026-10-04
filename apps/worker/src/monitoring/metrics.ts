// Operational metrics: a point-in-time, read-only projection of chain + store
// state. Nothing here mutates state and no secrets are read or logged. Every
// monetary value leaves as an exact decimal string (bigint -> string); the
// snapshot carries no floats for money.
import type { Address, Hash } from "viem";
import type { ChainEventRow } from "@midman/store";
import { listKnownDealIds } from "@midman/store";
import type { WorkerEnv } from "../index.js";
import { sponsorSpendWei } from "../reliability/hardening.js";

const CATASTROPHIC_ESCAPE_SECONDS = 5_184_000;
const FALLBACK_REVIEW_SECONDS = 604_800;

// Phase constants mirror packages/contracts/src/DealTypes.sol (MidmanDK).
const PH_EVIDENCE = 4;
const PH_PRIMARY_REVIEW = 5;
const PH_FALLBACK_REVIEW = 6;
const PH_RULING_PENDING = 7;
const PH_DEADLOCK = 8;
const PH_SETTLED = 9;

export type SolvencyStatus = "ok" | "shortfall" | "unknown";

export interface SolvencyMetrics {
  /** Accounted liabilities; "0" is only ever paired with status "unknown". */
  readonly liabilitiesUnits: string;
  /** Custody balance; "0" is only ever paired with status "unknown". */
  readonly balanceUnits: string;
  /** true = solvent, false = shortfall, null = unknown (never silently solvent). */
  readonly ok: boolean | null;
  readonly status: SolvencyStatus;
  /** Why solvency is unknown; null when status is "ok" or "shortfall". */
  readonly reason: string | null;
}

export interface EscrowMetrics {
  readonly activeDeals: number;
}

export interface RulingsMetrics {
  readonly pendingCount: number;
  readonly overdueCount: number;
  readonly queuedAgeMaxSeconds: number;
}

export interface DisputesMetrics {
  readonly inEvidence: number;
  readonly inPrimary: number;
  readonly inFallback: number;
  readonly deadlock: number;
}

export interface EscapesMetrics {
  readonly eligibleCount: number;
}

export interface LifecycleMetrics {
  readonly settledCount: number;
  readonly fundedCount: number;
  /** True when the hub is funding-paused; null when the reader cannot report it. */
  readonly fundingPaused: boolean | null;
}

export interface OpsMetrics {
  /** Relay queue depth; null when the store could not be read (never faked 0). */
  readonly relayQueued: number | null;
  readonly relayFailed: number;
  readonly relayUnsigned: number;
  /** Sponsored txs in the last 24h; null when the store could not be read. */
  readonly sponsors24h: number | null;
  /** Sponsor gas spend in wei; null when no spend source is available (never faked 0). */
  readonly sponsorSpendWeiUnits: string | null;
  /** head block timestamp - indexer tip block timestamp; null unless both known. */
  readonly indexerLagSeconds: number | null;
}

/**
 * Optional, injectable metric sources. Anything not supplied degrades to a
 * documented default rather than a fabricated zero.
 */
export interface MetricSources {
  /** Today's sponsor gas spend in wei, or null when the source is unavailable. */
  readonly sponsorSpendWei?: (() => bigint | null) | null;
}

export interface StorageMetrics {
  readonly evidenceCount: number;
}

export interface SettlementInfo {
  readonly dealId: string;
  readonly fundedUnits: string;
}

export interface MetricsSnapshot {
  readonly atUnix: number;
  readonly solvency: SolvencyMetrics;
  readonly escrow: EscrowMetrics;
  readonly rulings: RulingsMetrics;
  readonly disputes: DisputesMetrics;
  readonly escapes: EscapesMetrics;
  readonly lifecycle: LifecycleMetrics;
  readonly ops: OpsMetrics;
  readonly storage: StorageMetrics;
  /** Settled deals (principal + prepaid buyer fee) for large-settlement checks. */
  readonly settlements: readonly SettlementInfo[];
}

/**
 * Optional store capability. The base `Store` interface cannot enumerate relay
 * jobs by status, so when a backing store exposes this counter we use it for
 * accurate relayFailed/relayUnsigned numbers. When absent we fall back to a
 * best-effort scan of the worker's deterministic auto-relay keys.
 */
export interface RelayStatusCounter {
  countRelayByStatus(status: string): Promise<number>;
}

const AUTO_RELAY_ACTIONS = [
  "refundForNonDelivery",
  "finalizeAfterTimeout",
  "lapseDispute",
  "advanceToPrimary",
  "activateFallback",
  "executeRuling",
  "markDeadlock",
  "catastrophicEscape",
] as const;

const FALLBACK_DEAL_SCAN_CAP = 200;

function num(value: bigint | string | boolean | number | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function toBig(value: bigint | string | boolean | number | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return 0n;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Like `safe`, but distinguishes "unreadable" (null) from a real value. */
async function safeNullable<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Solvency is UNKNOWN unless BOTH chain reads succeed. A missing reader/hub or
 * any read failure must never masquerade as a solvent zero-balance snapshot.
 */
async function readSolvency(env: WorkerEnv): Promise<SolvencyMetrics> {
  if (!env.reader || !env.hub) {
    return {
      liabilitiesUnits: "0",
      balanceUnits: "0",
      ok: null,
      status: "unknown",
      reason: "no-reader-or-hub",
    };
  }
  try {
    const [liabilities, balance] = await Promise.all([
      env.reader.getLiabilities(env.hub),
      env.reader.getTokenBalance(env.usdc, env.hub),
    ]);
    const status: SolvencyStatus = balance >= liabilities ? "ok" : "shortfall";
    return {
      liabilitiesUnits: liabilities.toString(),
      balanceUnits: balance.toString(),
      ok: status === "ok",
      status,
      reason: null,
    };
  } catch (error) {
    return {
      liabilitiesUnits: "0",
      balanceUnits: "0",
      ok: null,
      status: "unknown",
      reason: error instanceof Error ? error.name : "read-failed",
    };
  }
}

/**
 * Sponsor spend is only reported when a source can actually attest it. The
 * process-global budget reports 0n both for "no spend" and "no budget", so a
 * bare 0 cannot be told apart from an unavailable source; report null instead.
 */
function resolveSponsorSpendWei(sources: MetricSources): string | null {
  const source = sources.sponsorSpendWei ?? null;
  if (source !== null) {
    const value = source();
    return value === null ? null : value.toString();
  }
  const spend = sponsorSpendWei();
  return spend > 0n ? spend.toString() : null;
}

async function readIndexerLag(env: WorkerEnv): Promise<number | null> {
  if (!env.reader || !env.hub) return null;
  let headTimestamp: number | null = null;
  let tipTimestamp: number | null = null;
  try {
    const tagged = await env.reader.getBlockByTag("finalized");
    if (tagged) {
      headTimestamp = tagged.timestamp;
    } else {
      const latest = await env.reader.getLatestBlockNumber();
      headTimestamp = (await env.reader.getBlock(latest)).timestamp;
    }
  } catch {
    headTimestamp = null;
  }
  try {
    const tip = await env.store.getTip(env.hub);
    if (tip) tipTimestamp = (await env.reader.getBlock(tip.blockNumber)).timestamp;
  } catch {
    tipTimestamp = null;
  }
  if (headTimestamp === null || tipTimestamp === null) return null;
  return Math.max(0, headTimestamp - tipTimestamp);
}

async function readFundingPaused(env: WorkerEnv): Promise<boolean | null> {
  if (!env.reader || !env.hub) return null;
  const probe = env.reader as unknown as {
    getFundingPaused?: (hub: Address) => Promise<boolean>;
  };
  if (typeof probe.getFundingPaused !== "function") return null;
  try {
    return await probe.getFundingPaused(env.hub);
  } catch {
    return null;
  }
}

async function relayOutcomeCounts(
  env: WorkerEnv,
  dealIds: readonly string[],
  nowSeconds: number,
): Promise<{ failed: number; unsigned: number }> {
  const counter = env.store as unknown as Partial<RelayStatusCounter>;
  if (typeof counter.countRelayByStatus === "function") {
    try {
      const [failed, unsigned] = await Promise.all([
        counter.countRelayByStatus("failed"),
        counter.countRelayByStatus("unsigned"),
      ]);
      return { failed, unsigned };
    } catch {
      // fall through to best-effort scan
    }
  }
  let failed = 0;
  let unsigned = 0;
  const day = Math.floor(nowSeconds / 86_400);
  for (const dealId of dealIds.slice(0, FALLBACK_DEAL_SCAN_CAP)) {
    for (const action of AUTO_RELAY_ACTIONS) {
      for (const window of [day, day - 1]) {
        const job = await safe(
          () => env.store.getRelay(`${dealId.toLowerCase()}:${action}:${window}`),
          null,
        );
        if (!job) continue;
        if (job.status === "failed") failed += 1;
        else if (job.status === "unsigned") unsigned += 1;
      }
    }
  }
  return { failed, unsigned };
}

async function countEvidence(env: WorkerEnv, dealIds: readonly string[]): Promise<number> {
  let evidenceCount = 0;
  for (const dealId of dealIds) {
    const events = await safe<ChainEventRow[]>(() => env.store.getEventsByDeal(dealId), []);
    evidenceCount += events.filter((event) => event.eventName === "EvidenceCommitted").length;
  }
  return evidenceCount;
}

/** Collect one operational snapshot. Unreadable deals are skipped, never faked. */
export async function collectMetrics(
  env: WorkerEnv,
  nowSeconds: number,
  sources: MetricSources = {},
): Promise<MetricsSnapshot> {
  const dealIds = await safe(() => listKnownDealIds(env.store), [] as string[]);
  const chain = env.reader && env.hub ? { reader: env.reader, hub: env.hub } : null;

  const solvency = await readSolvency(env);

  let activeDeals = 0;
  let pendingCount = 0;
  let overdueCount = 0;
  let queuedAgeMaxSeconds = 0;
  let inEvidence = 0;
  let inPrimary = 0;
  let inFallback = 0;
  let deadlock = 0;
  let eligibleCount = 0;
  let settledCount = 0;
  let fundedCount = 0;
  const settlements: SettlementInfo[] = [];

  for (const dealId of dealIds) {
    if (!chain) continue;
    let deal: Record<string, bigint | string | boolean | number>;
    try {
      deal = await chain.reader.getDeal(chain.hub, dealId as Hash);
    } catch {
      continue;
    }
    const phase = num(deal["phase"]);
    const funded = deal["funded"] === true;

    if (funded) fundedCount += 1;
    if (funded && phase !== PH_SETTLED) activeDeals += 1;
    if (phase === PH_SETTLED) {
      settledCount += 1;
      const fundedUnits = toBig(deal["principal"]) + toBig(deal["prepaidBuyerFee"]);
      settlements.push({ dealId, fundedUnits: fundedUnits.toString() });
    }

    if (phase === PH_EVIDENCE) inEvidence += 1;
    else if (phase === PH_PRIMARY_REVIEW) inPrimary += 1;
    else if (phase === PH_FALLBACK_REVIEW) inFallback += 1;
    else if (phase === PH_DEADLOCK) deadlock += 1;

    const rulingPending = phase === PH_RULING_PENDING || deal["rulingQueued"] === true;
    if (rulingPending) {
      pendingCount += 1;
      const executeAt = num(deal["rulingExecuteAt"]);
      const fallbackStartedAt = num(deal["fallbackStartedAt"]);
      const execDelay = num(deal["execDelay"]);
      const overdue =
        (executeAt > 0 && nowSeconds >= executeAt) ||
        (fallbackStartedAt > 0 && nowSeconds >= fallbackStartedAt + FALLBACK_REVIEW_SECONDS);
      if (overdue) overdueCount += 1;
      const queuedAt =
        executeAt > 0 && execDelay > 0 ? executeAt - execDelay : fallbackStartedAt;
      if (queuedAt > 0 && nowSeconds > queuedAt) {
        queuedAgeMaxSeconds = Math.max(queuedAgeMaxSeconds, nowSeconds - queuedAt);
      }
    }

    if (
      funded &&
      phase >= PH_EVIDENCE &&
      phase <= PH_DEADLOCK &&
      num(deal["escalatedAt"]) > 0 &&
      nowSeconds >= num(deal["disputeOpenedAt"]) + CATASTROPHIC_ESCAPE_SECONDS
    ) {
      eligibleCount += 1;
    }
  }

  const [evidenceCount, relayQueuedJobs, relayOutcomes, sponsors24h, indexerLagSeconds, fundingPaused] =
    await Promise.all([
      countEvidence(env, dealIds),
      safeNullable(() => env.store.listQueuedRelay("relay", 10_000)),
      relayOutcomeCounts(env, dealIds, nowSeconds),
      safeNullable(() =>
        env.store.countSponsorsSince(new Date((nowSeconds - 86_400) * 1_000).toISOString()),
      ),
      readIndexerLag(env),
      readFundingPaused(env),
    ]);

  return {
    atUnix: nowSeconds,
    solvency,
    escrow: { activeDeals },
    rulings: { pendingCount, overdueCount, queuedAgeMaxSeconds },
    disputes: { inEvidence, inPrimary, inFallback, deadlock },
    escapes: { eligibleCount },
    lifecycle: { settledCount, fundedCount, fundingPaused },
    ops: {
      relayQueued: relayQueuedJobs === null ? null : relayQueuedJobs.length,
      relayFailed: relayOutcomes.failed,
      relayUnsigned: relayOutcomes.unsigned,
      sponsors24h,
      sponsorSpendWeiUnits: resolveSponsorSpendWei(sources),
      indexerLagSeconds,
    },
    storage: { evidenceCount },
    settlements,
  };
}
