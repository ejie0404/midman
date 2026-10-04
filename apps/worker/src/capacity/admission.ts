// P-14 (RB-09) subsidy/admission capacity controls.
//
// Pure and deterministic: no clocks, no I/O. Money stays exact bigint USDC
// smallest units. The admission signer (risk role) can deny new funding but
// cannot settle or redirect; funded deals are never rewritten by these caps.
import { MIN_PRINCIPAL_UNITS } from "@midman/shared";

/** The six V1 categories admitted at launch (policy-register P-12/P-14). */
export const V1_CATEGORIES = [
  "INSTANT_CODE",
  "GAME_ITEM",
  "GAME_CURRENCY",
  "DIGITAL_GOOD",
  "SERVICE",
  "GAME_ACCOUNT",
] as const;
export type V1Category = (typeof V1_CATEGORIES)[number];

/** Initial interim limits from P-14 (tracked for expansion in Phase 13). */
export const DEFAULT_MAX_CONCURRENT_ESCALATED_PER_POD = 5;
export const DEFAULT_MAX_CONCURRENT_ESCALATED_PROTOCOL = 20;
/** $10,000 at 6 decimals: aggregate exposure per buyer/seller pair per 24h. */
export const DEFAULT_AGGREGATE_PAIR_CAP_UNITS_PER_24H = 10_000_000_000n;

export interface AdmissionLimits {
  readonly maxConcurrentEscalatedPerPod: number;
  readonly maxConcurrentEscalatedProtocol: number;
  readonly aggregatePairCapUnitsPer24h: bigint;
  readonly categoryAllowlist: readonly string[];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number.parseInt(trimmed, 10);
  return value > 0 ? value : fallback;
}

function parseUnits(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  return BigInt(trimmed);
}

/** Env-driven limits; unset/invalid values fall back to the P-14 defaults. */
export function admissionLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AdmissionLimits {
  const allowRaw = env["CATEGORY_ALLOWLIST"];
  const categoryAllowlist =
    allowRaw === undefined || allowRaw.trim() === ""
      ? [...V1_CATEGORIES]
      : allowRaw
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
  return {
    maxConcurrentEscalatedPerPod: parsePositiveInt(
      env["MAX_CONCURRENT_ESCALATED_PER_POD"],
      DEFAULT_MAX_CONCURRENT_ESCALATED_PER_POD,
    ),
    maxConcurrentEscalatedProtocol: parsePositiveInt(
      env["MAX_CONCURRENT_ESCALATED_PROTOCOL"],
      DEFAULT_MAX_CONCURRENT_ESCALATED_PROTOCOL,
    ),
    aggregatePairCapUnitsPer24h: parseUnits(
      env["AGGREGATE_PAIR_CAP_UNITS_PER_24H"],
      DEFAULT_AGGREGATE_PAIR_CAP_UNITS_PER_24H,
    ),
    categoryAllowlist,
  };
}

/** Minimal chain deal projection used for pair exposure (principal bigint). */
export interface DealExposureRecord {
  readonly buyer: string;
  readonly seller: string;
  readonly principal: bigint | string | number;
  readonly fundedAt: bigint | string | number;
}

function toUnits(value: bigint | string | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return 0n;
    return BigInt(value);
  }
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

/**
 * Aggregate exposure for a buyer/seller pair over a window: sum of principal
 * for deals whose fundedAt is at or after `sinceUnix`. The pair is unordered
 * (a deal counts whether the requested party is buyer or seller).
 */
export function aggregateExposure(
  deals: readonly DealExposureRecord[],
  buyer: string,
  seller: string,
  sinceUnix: bigint | number,
): bigint {
  const wantBuyer = buyer.toLowerCase();
  const wantSeller = seller.toLowerCase();
  const since = toUnits(sinceUnix);
  let total = 0n;
  for (const deal of deals) {
    const dealBuyer = deal.buyer.toLowerCase();
    const dealSeller = deal.seller.toLowerCase();
    const pairMatches =
      (dealBuyer === wantBuyer && dealSeller === wantSeller) ||
      (dealBuyer === wantSeller && dealSeller === wantBuyer);
    if (!pairMatches) continue;
    if (toUnits(deal.fundedAt) < since) continue;
    total += toUnits(deal.principal);
  }
  return total;
}

export type AdmissionReason =
  | "ok"
  | "category-not-allowlisted"
  | "principal-below-minimum"
  | "per-pod-concurrency-limit"
  | "protocol-concurrency-limit"
  | "pair-exposure-limit";

export interface AdmissionContext {
  readonly category: string;
  readonly buyer: string;
  readonly seller: string;
  readonly principalUnits: bigint;
  /** Protocol-wide concurrent escalated cases at admission time. */
  readonly activeEscalatedCount: number;
  /** Already-funded exposure for this buyer/seller pair in the last 24h. */
  readonly pairExposure24hUnits: bigint;
  /** Optional per-pod concurrent escalated cases (defaults to 0). */
  readonly activeEscalatedCountPerPod?: number;
}

export interface AdmissionDecision {
  readonly ok: boolean;
  readonly reason: AdmissionReason;
  readonly limits: AdmissionLimits;
}

/**
 * Admission gate: category allowlist, 5 USDC principal floor, concurrent
 * escalation caps (per pod + protocol-wide), and the $10k/24h pair cap.
 * A limit is "reached" when the current count equals it, because admitting
 * one more deal would exceed it.
 */
export class AdmissionControls {
  readonly limits: AdmissionLimits;

  constructor(limits: AdmissionLimits = admissionLimitsFromEnv()) {
    this.limits = limits;
  }

  admit(ctx: AdmissionContext): AdmissionDecision {
    const { limits } = this;
    const reject = (reason: AdmissionReason): AdmissionDecision => ({ ok: false, reason, limits });

    const category = ctx.category.trim().toUpperCase();
    const allowlisted = limits.categoryAllowlist.some(
      (entry) => entry.trim().toUpperCase() === category,
    );
    if (!allowlisted) return reject("category-not-allowlisted");

    if (ctx.principalUnits < MIN_PRINCIPAL_UNITS) return reject("principal-below-minimum");

    const perPod = ctx.activeEscalatedCountPerPod ?? 0;
    if (perPod >= limits.maxConcurrentEscalatedPerPod) return reject("per-pod-concurrency-limit");
    if (ctx.activeEscalatedCount >= limits.maxConcurrentEscalatedProtocol) {
      return reject("protocol-concurrency-limit");
    }

    if (ctx.pairExposure24hUnits + ctx.principalUnits > limits.aggregatePairCapUnitsPer24h) {
      return reject("pair-exposure-limit");
    }

    return { ok: true, reason: "ok", limits };
  }
}
