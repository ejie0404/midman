// Shared deal constants and helpers for pages/components.
// Category minimums mirror apps/api/src/terms.ts CATEGORY_MINIMUMS (read-only).

export const CATEGORY_MINIMUMS: Record<string, number> = {
  INSTANT_CODE: 3_600,
  GAME_ITEM: 43_200,
  GAME_CURRENCY: 43_200,
  DIGITAL_GOOD: 43_200,
  SERVICE: 43_200,
  GAME_ACCOUNT: 86_400,
};

export const CATEGORIES: readonly string[] = Object.keys(CATEGORY_MINIMUMS);

export const FEE_ALLOCATIONS: readonly { label: string; bps: 0 | 5_000 | 10_000 }[] = [
  { label: "Seller pays (0%)", bps: 0 },
  { label: "Split 50/50", bps: 5_000 },
  { label: "Buyer pays (100%)", bps: 10_000 },
];

/** Normal-journey progress steps shown on the dashboard. */
export const PROGRESS_STEPS: readonly string[] = [
  "create",
  "share",
  "review",
  "sign",
  "fund",
  "deliver",
  "inspect",
  "settle",
  "claim",
];

/** Fixed claim kinds (contract CK_*). Recipients are fixed on-chain; the UI never redirects them. */
export const CLAIM_KINDS: readonly { kind: number; name: string; calldataKey: string }[] = [
  { kind: 0, name: "Buyer principal + fee refund", calldataKey: "claimBuyerPrincipal" },
  { kind: 1, name: "Seller principal", calldataKey: "claimSellerPrincipal" },
  { kind: 2, name: "Platform fee", calldataKey: "claimPlatformFee" },
  { kind: 3, name: "Buyer bond refund", calldataKey: "claimBuyerBond" },
  { kind: 4, name: "Seller bond refund", calldataKey: "claimSellerBond" },
  { kind: 5, name: "Arbitration cost", calldataKey: "claimArbitrationCost" },
];

export function platformFeeRecipient(fallback: string): string {
  return (typeof process !== "undefined" && process.env["NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT"]) || fallback;
}

export function arbitrationCostRecipient(fallback: string): string {
  return (typeof process !== "undefined" && process.env["NEXT_PUBLIC_ARBITRATION_COST_RECIPIENT"]) || fallback;
}

export function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isHex32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Read the invitation token from the URL fragment (#invite=...). Never logged, never sent. */
export function readInviteTokenFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  const match = /invite=([^&]+)/.exec(hash);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}
