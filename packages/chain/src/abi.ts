// Canonical on-chain ABIs — GENERATED, do not hand-edit.
// Regenerate with `node scripts/export-abi.mjs` (after `forge build` in
// packages/contracts). Full ABI lives in ./abi/generated/ as JSON envelopes
// plus TS modules (JSON imports are avoided: the chain tsconfig does not
// enable resolveJsonModule).
//
// The dispute-machine events (Delivered, Settled, ...) are emitted from the
// hub address via DELEGATECALL to the HubDispute library, so they are merged
// into HUB_ABI from the HubDispute artifact at generation time. Field order
// matches the contracts exactly; downstream EIP-712 and calldata builders
// must treat the artifacts as authoritative.
import { MIDMAN_HUB_ABI } from "./abi/generated/midmanHub.js";
import { MIDMAN_POLICIES_ABI } from "./abi/generated/midmanPolicies.js";

export const HUB_ABI = MIDMAN_HUB_ABI;
export const POLICIES_ABI = MIDMAN_POLICIES_ABI;

export const PHASE_NAMES = [
  "AWAITING_DELIVERY",
  "DELIVERED",
  "SELF_RESOLUTION",
  "AWAITING_ESCALATION",
  "EVIDENCE",
  "PRIMARY_REVIEW",
  "FALLBACK_REVIEW",
  "RULING_PENDING",
  "DEADLOCK",
  "SETTLED",
] as const;

// Minimal single-view ABI for bond-policy reads, derived from the generated
// registry ABI (not hand-written) for lightweight readers.
function isBondPoliciesView(entry: (typeof MIDMAN_POLICIES_ABI)[number]): boolean {
  return entry.type === "function" && entry.name === "bondPolicies";
}

export const BOND_POLICY_VIEW = MIDMAN_POLICIES_ABI.filter(isBondPoliciesView);
