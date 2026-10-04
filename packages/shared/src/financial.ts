// Exact financial primitives. All money is bigint USDC smallest units (6 decimals).
// Mirrors specs/financial-ledger.md + policy-register.md P-01..P-04. No floats.

export const USDC_DECIMALS = 6;
export const MIN_PRINCIPAL_UNITS = 5_000_000n;
export const MIN_QUOTED_FEE_UNITS = 500_000n;
export const MIN_BOND_UNITS = 5_000_000n;
export const FEE_DENOMINATOR = 10_000n;
export const FEE_ALLOCATIONS_BPS = [0, 5_000, 10_000] as const;
export type FeeAllocationBps = (typeof FEE_ALLOCATIONS_BPS)[number];

export const SELF_RESOLUTION_SECONDS = 86_400;
export const ESCALATION_WINDOW_SECONDS = 86_400;
export const RESPONDENT_EVIDENCE_SECONDS = 86_400;
export const CATASTROPHIC_ESCAPE_SECONDS = 5_184_000;
export const PRIMARY_REVIEW_SECONDS = 604_800;
export const FALLBACK_REVIEW_SECONDS = 604_800;

export interface FeeTier {
  readonly maxSeconds: number | null; // null = unbounded
  readonly inclusive: boolean;
  readonly rateBps: number;
}

// Locked tiers; boundary semantics match validate-spec.mjs feeRate().
export const FEE_TIERS: readonly FeeTier[] = [
  { maxSeconds: 10_800, inclusive: true, rateBps: 25 },
  { maxSeconds: 86_400, inclusive: false, rateBps: 50 },
  { maxSeconds: 259_200, inclusive: true, rateBps: 70 },
  { maxSeconds: 604_800, inclusive: true, rateBps: 100 },
  { maxSeconds: null, inclusive: true, rateBps: 200 },
];

export function feeRateBps(durationSeconds: number): number {
  for (const tier of FEE_TIERS) {
    if (tier.maxSeconds === null) return tier.rateBps;
    if (tier.inclusive ? durationSeconds <= tier.maxSeconds : durationSeconds < tier.maxSeconds) {
      return tier.rateBps;
    }
  }
  throw new Error("No fee tier");
}

// P-01: F = max(500_000, ceil(P * rateBps / 10_000))
export function quoteFee(principalUnits: bigint, durationSeconds: number): bigint {
  if (principalUnits < MIN_PRINCIPAL_UNITS) throw new RangeError("Below minimum principal");
  const rate = BigInt(feeRateBps(durationSeconds));
  const ceilQuotient = (principalUnits * rate + 10_000n - 1n) / 10_000n;
  const fee = ceilQuotient > MIN_QUOTED_FEE_UNITS ? ceilQuotient : MIN_QUOTED_FEE_UNITS;
  if (fee > principalUnits) throw new RangeError("Quoted fee exceeds principal");
  return fee;
}

export interface NormalSettlement {
  readonly prepaidBuyerFee: bigint;
  readonly earnedFee: bigint;
  readonly buyerFee: bigint;
  readonly sellerFee: bigint;
  readonly buyerClaim: bigint;
  readonly sellerClaim: bigint;
  readonly funded: bigint;
}

// L-NORMAL: E = floor(F*S/P); buyerFee = floor(E*b/10_000); sellerFee = E - buyerFee.
export function normalSettlement(
  principal: bigint,
  quotedFee: bigint,
  sellerAward: bigint,
  buyerFeeBps: FeeAllocationBps,
): NormalSettlement {
  if (principal < MIN_PRINCIPAL_UNITS) throw new RangeError("Below minimum principal");
  if (quotedFee < MIN_QUOTED_FEE_UNITS || quotedFee > principal) throw new RangeError("Invalid quoted fee");
  if (sellerAward < 0n || sellerAward > principal) throw new RangeError("Invalid seller award");
  if (!FEE_ALLOCATIONS_BPS.includes(buyerFeeBps)) throw new RangeError("Invalid fee allocation");
  const b = BigInt(buyerFeeBps);
  const prepaidBuyerFee = (quotedFee * b) / FEE_DENOMINATOR;
  const earnedFee = (quotedFee * sellerAward) / principal;
  const buyerFee = (earnedFee * b) / FEE_DENOMINATOR;
  const sellerFee = earnedFee - buyerFee;
  const buyerClaim = principal - sellerAward + (prepaidBuyerFee - buyerFee);
  const sellerClaim = sellerAward - sellerFee;
  if (buyerClaim < 0n || sellerClaim < 0n) throw new Error("Negative payout");
  if (buyerFee > prepaidBuyerFee) throw new Error("Negative prepaid fee refund");
  if (buyerClaim + sellerClaim + earnedFee !== principal + prepaidBuyerFee) {
    throw new Error("Conservation failure");
  }
  return { prepaidBuyerFee, earnedFee, buyerFee, sellerFee, buyerClaim, sellerClaim, funded: principal + prepaidBuyerFee };
}

// P-03: Cb = floor(Qb*S/P); Cs = floor(Qs*(P-S)/P)
export function partialBondCosts(
  principal: bigint,
  sellerAward: bigint,
  buyerBond: bigint,
  sellerBond: bigint,
): { buyerCost: bigint; sellerCost: bigint } {
  if (sellerAward < 0n || sellerAward > principal) throw new RangeError("Invalid seller award");
  if (buyerBond < 0n || sellerBond < 0n) throw new RangeError("Negative bond");
  const buyerCost = (buyerBond * sellerAward) / principal;
  const sellerCost = (sellerBond * (principal - sellerAward)) / principal;
  return { buyerCost, sellerCost };
}

// P-02: odd unit to buyer. buyerShare = ceil(P/2), sellerShare = floor(P/2).
export function catastrophicSplit(principal: bigint): { buyerShare: bigint; sellerShare: bigint } {
  if (principal < 0n) throw new RangeError("Negative principal");
  const sellerShare = principal / 2n;
  return { buyerShare: principal - sellerShare, sellerShare };
}

// Timestamp helpers: chain seconds, never floats. Timely uses `< deadline`.
export function isTimely(nowSeconds: number, deadlineSeconds: number): boolean {
  if (!Number.isInteger(nowSeconds) || !Number.isInteger(deadlineSeconds)) {
    throw new TypeError("Timestamps must be integer seconds");
  }
  return nowSeconds < deadlineSeconds;
}

export const EIP712_DOMAIN = { name: "MidmanEscrow", version: "1" } as const;
