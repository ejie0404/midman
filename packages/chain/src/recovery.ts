// Deal recovery package: everything needed to exercise on-chain rights
// without the primary API or indexer (Phase 6/10 gate). Pure data plus
// pre-encoded emergency calldata for direct submission.
import { encodeFunctionData, type Address, type Hash } from "viem";
import { HUB_ABI } from "./abi.js";

export interface RecoveryPackage {
  readonly version: 1;
  readonly chainId: number;
  readonly hub: Address;
  readonly usdc: Address;
  readonly dealId: Hash;
  readonly agreementDigest: Hash;
  readonly canonicalTerms: Record<string, string>;
  readonly signatures: { readonly buyer: Hash; readonly seller: Hash };
  readonly policyIds: Record<string, string>;
  readonly relevantTransactions: readonly Hash[];
  readonly indexerTip: { readonly blockNumber: string; readonly blockHash: Hash } | null;
  readonly emergencyCalldata: Record<string, Hash>;
  readonly note: string;
}

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hash;

/** Build direct-submission calldata for the actions that need no auth beyond the deal itself. */
type NoArgAction =
  | "refundForNonDelivery"
  | "finalizeAfterTimeout"
  | "lapseDispute"
  | "advanceToPrimary"
  | "activateFallback"
  | "executeRuling"
  | "markDeadlock"
  | "catastrophicEscape";

function encodeNoArg(functionName: NoArgAction, dealId: Hash): Hash {
  return encodeFunctionData({ abi: HUB_ABI, functionName, args: [dealId] }) as Hash;
}

function encodeClaim(dealId: Hash, kind: number): Hash {
  return encodeFunctionData({ abi: HUB_ABI, functionName: "claimFor", args: [dealId, kind] }) as Hash;
}

export function emergencyCalldata(dealId: Hash): Record<string, Hash> {
  return {
    refundForNonDelivery: encodeNoArg("refundForNonDelivery", dealId),
    finalizeAfterTimeout: encodeNoArg("finalizeAfterTimeout", dealId),
    lapseDispute: encodeNoArg("lapseDispute", dealId),
    advanceToPrimary: encodeNoArg("advanceToPrimary", dealId),
    activateFallback: encodeNoArg("activateFallback", dealId),
    executeRuling: encodeNoArg("executeRuling", dealId),
    markDeadlock: encodeNoArg("markDeadlock", dealId),
    catastrophicEscape: encodeNoArg("catastrophicEscape", dealId),
    claimBuyerPrincipal: encodeClaim(dealId, 0),
    claimSellerPrincipal: encodeClaim(dealId, 1),
    claimPlatformFee: encodeClaim(dealId, 2),
    claimBuyerBond: encodeClaim(dealId, 3),
    claimSellerBond: encodeClaim(dealId, 4),
    claimArbitrationCost: encodeClaim(dealId, 5),
  };
}

export function buildRecoveryPackage(params: {
  chainId: number;
  hub: Address;
  usdc: Address;
  dealId: Hash;
  agreementDigest: Hash;
  canonicalTerms: Record<string, string>;
  signatures: { buyer: Hash; seller: Hash };
  policyIds: Record<string, string>;
  relevantTransactions: readonly Hash[];
  indexerTip: { blockNumber: string; blockHash: Hash } | null;
}): RecoveryPackage {
  return {
    version: 1,
    chainId: params.chainId,
    hub: params.hub,
    usdc: params.usdc,
    dealId: params.dealId,
    agreementDigest: params.agreementDigest,
    canonicalTerms: params.canonicalTerms,
    signatures: params.signatures,
    policyIds: params.policyIds,
    relevantTransactions: params.relevantTransactions,
    indexerTip: params.indexerTip,
    emergencyCalldata: emergencyCalldata(params.dealId),
    note: "Contract state is authoritative. Pending !== included: verify inclusion before acting. Authenticated actions (openDispute with signature) are submitted via wallet, not from this package.",
  };
}

export { ZERO };
