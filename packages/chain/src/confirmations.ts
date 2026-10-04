// Confirmation policy (P-11 / Phase 6 gate). Base progression:
// preconfirmation -> L2 inclusion -> batch inclusion -> L1 finality.
// Display mapping: pending (relayed/signed, not included), included (L2
// block), safe (batch-backed `safe` tag), finalized (`finalized` tag).
// Irreversible off-chain shipment is recommended only at `safe` or later;
// funding is spendable by the contract at L2 inclusion.
export type ConfirmationLevel = "pending" | "included" | "safe" | "finalized";

export const CONFIRMATION_ORDER: readonly ConfirmationLevel[] = [
  "pending",
  "included",
  "safe",
  "finalized",
];

export function atLeast(level: ConfirmationLevel, minimum: ConfirmationLevel): boolean {
  return CONFIRMATION_ORDER.indexOf(level) >= CONFIRMATION_ORDER.indexOf(minimum);
}

/// @notice Resolve a transaction's display level from chain head tags.
/// `txBlock` may be null when not yet included.
export function confirmationLevel(params: {
  txBlock: bigint | null;
  safeBlock: bigint | null;
  finalizedBlock: bigint | null;
}): ConfirmationLevel {
  if (params.txBlock === null) return "pending";
  if (params.finalizedBlock !== null && params.txBlock <= params.finalizedBlock) return "finalized";
  if (params.safeBlock !== null && params.txBlock <= params.safeBlock) return "safe";
  return "included";
}

/// @notice Whether irreversible off-chain delivery may proceed.
export function mayShipIrreversible(level: ConfirmationLevel): boolean {
  return atLeast(level, "safe");
}
