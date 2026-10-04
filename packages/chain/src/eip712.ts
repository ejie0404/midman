// Canonical EIP-712 action schemas for the Midman hub system — the SINGLE
// source of truth for every off-chain signer/verifier (API, web, worker).
//
// Source of truth for the STRINGS is the contract:
//   packages/contracts/src/DealTypes.sol (MidmanDK *_TYPEHASH constants).
// Field order matches specs/phase2-threat-model.md section 2 (order is
// signing-significant). Every TYPE_STRINGS entry below was copied
// character-for-character from DealTypes.sol; the matching ordered field
// arrays in TYPES reconstruct each string exactly (enforced by
// test/eip712-consolidation.test.mjs, plus on-chain DigestParity coverage).
//
// Domain: EIP712Domain(string name,string version,uint256 chainId,address
// verifyingContract) with name "MidmanEscrow", version "1".
//
// NOTE on VetoRuling: the EIP-712 field name is `expiresAt` (per
// VETO_TYPEHASH in DealTypes.sol AND the threat-model spec). The Solidity
// `VetoSig` struct member that carries the value is named `expiry`
// (HubDispute.veto passes vsigs[i].expiry positionally into the expiresAt
// slot). Off-chain typed-data MUST use `expiresAt` as the field name or the
// typehash — and therefore the digest — will not match the contract.
import { concat, encodeAbiParameters, keccak256, toHex, type Address, type Hash } from "viem";

/** EIP-712 domain name/version shared by every hub action. */
export const EIP712_DOMAIN = { name: "MidmanEscrow", version: "1" } as const;

/** EIP-712 domain type string (used for the domain separator). */
export const EIP712_DOMAIN_TYPE_STRING =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** Full domain for a chain + hub (verifying contract). */
export function buildDomain(
  chainId: number,
  verifyingContract: Address,
): { name: string; version: string; chainId: number; verifyingContract: Address } {
  return { name: EIP712_DOMAIN.name, version: EIP712_DOMAIN.version, chainId, verifyingContract };
}

// ---- Ordered field arrays (one per contract action) ----
// Each array reconstructs its TYPE_STRINGS entry as
// `<Type>(<type> <name>,...)` — order and spelling are consensus-critical.

export const DEAL_TERMS_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "termsVersion", type: "uint32" },
  { name: "buyerAddress", type: "address" },
  { name: "sellerAddress", type: "address" },
  { name: "sellerPayoutAddress", type: "address" },
  { name: "buyerRefundAddress", type: "address" },
  { name: "buyerBondRefundAddress", type: "address" },
  { name: "sellerBondRefundAddress", type: "address" },
  { name: "token", type: "address" },
  { name: "principal", type: "uint256" },
  { name: "quotedPlatformFee", type: "uint256" },
  { name: "buyerFeeBps", type: "uint16" },
  { name: "agreementHash", type: "bytes32" },
  { name: "feePolicyId", type: "bytes32" },
  { name: "deliveryPeriodSeconds", type: "uint32" },
  { name: "inspectionPeriodSeconds", type: "uint32" },
  { name: "categoryPolicyId", type: "bytes32" },
  { name: "readinessPolicyId", type: "bytes32" },
  { name: "readinessConsentHash", type: "bytes32" },
  { name: "evidencePolicyId", type: "bytes32" },
  { name: "bondPolicyId", type: "bytes32" },
  { name: "arbitrationPolicyId", type: "bytes32" },
  { name: "outagePolicyId", type: "bytes32" },
  { name: "catastrophicPolicyId", type: "bytes32" },
  { name: "platformFeeRecipient", type: "address" },
  { name: "arbitrationCostRecipient", type: "address" },
  { name: "fundingDeadline", type: "uint64" },
  { name: "nonce", type: "bytes32" },
  { name: "salt", type: "bytes32" },
  { name: "factory", type: "address" },
  { name: "implementation", type: "address" },
  { name: "custodyAddress", type: "address" },
] as const;

export const REVOKE_TERMS_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "revoker", type: "address" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const MARK_DELIVERED_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "actor", type: "address" },
  { name: "manifestHash", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const OPEN_DISPUTE_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "actor", type: "address" },
  { name: "reasonCode", type: "uint8" },
  { name: "initialCommitment", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const ESCALATE_DISPUTE_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "actor", type: "address" },
  { name: "collateralAmount", type: "uint256" },
  { name: "collateralSource", type: "uint8" },
  { name: "bondPolicyId", type: "bytes32" },
  { name: "claimId", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const APPROVE_SELLER_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "actor", type: "address" },
  { name: "terminalPolicyVersion", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const REFUND_BUYER_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "actor", type: "address" },
  { name: "terminalPolicyVersion", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const MUTUAL_SETTLEMENT_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "sellerAward", type: "uint256" },
  { name: "buyerBondCost", type: "uint256" },
  { name: "sellerBondCost", type: "uint256" },
  { name: "expectedPhase", type: "uint8" },
  { name: "settlementNonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const RESERVE_EXISTING_CLAIM_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "owner", type: "address" },
  { name: "sourceClaimId", type: "bytes32" },
  { name: "amount", type: "uint256" },
  { name: "party", type: "uint8" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const EVIDENCE_MANIFEST_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "uploader", type: "address" },
  { name: "sequence", type: "uint32" },
  { name: "prevCommitment", type: "bytes32" },
  { name: "fileHashes", type: "bytes32[]" },
  { name: "metadataCommitment", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const RULING_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "arbitrationPolicyId", type: "bytes32" },
  { name: "origin", type: "uint8" },
  { name: "rulingNonce", type: "bytes32" },
  { name: "sellerAward", type: "uint256" },
  { name: "buyerBondCost", type: "uint256" },
  { name: "sellerBondCost", type: "uint256" },
  { name: "evidenceCommitment", type: "bytes32" },
  { name: "authEpoch", type: "uint64" },
  { name: "queueExpiry", type: "uint64" },
] as const;

export const VETO_RULING_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "rulingDigest", type: "bytes32" },
  { name: "authority", type: "address" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const FUNDING_ADMISSION_FIELDS = [
  { name: "agreementDigest", type: "bytes32" },
  { name: "minPolicyId", type: "bytes32" },
  { name: "admissionNonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
  { name: "expectedUnfunded", type: "bool" },
] as const;

export const FUND_WITH_ALLOWANCE_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "payer", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "paymentSalt", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const BOND_INTENT_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "party", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "useExistingClaim", type: "bool" },
  { name: "claimId", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const READINESS_CONSENT_FIELDS = [
  { name: "dealId", type: "bytes32" },
  { name: "agreementDigest", type: "bytes32" },
  { name: "buyer", type: "address" },
  { name: "attestedAt", type: "uint64" },
  { name: "nonce", type: "bytes32" },
  { name: "expiresAt", type: "uint64" },
] as const;

/** Every canonical action type, keyed by EIP-712 primary type name. */
export const TYPES = {
  DealTerms: DEAL_TERMS_FIELDS,
  RevokeTerms: REVOKE_TERMS_FIELDS,
  MarkDelivered: MARK_DELIVERED_FIELDS,
  OpenDispute: OPEN_DISPUTE_FIELDS,
  EscalateDispute: ESCALATE_DISPUTE_FIELDS,
  ApproveSeller: APPROVE_SELLER_FIELDS,
  RefundBuyer: REFUND_BUYER_FIELDS,
  MutualSettlement: MUTUAL_SETTLEMENT_FIELDS,
  ReserveExistingClaim: RESERVE_EXISTING_CLAIM_FIELDS,
  EvidenceManifest: EVIDENCE_MANIFEST_FIELDS,
  Ruling: RULING_FIELDS,
  VetoRuling: VETO_RULING_FIELDS,
  FundingAdmission: FUNDING_ADMISSION_FIELDS,
  FundWithAllowance: FUND_WITH_ALLOWANCE_FIELDS,
  BondIntent: BOND_INTENT_FIELDS,
  ReadinessConsent: READINESS_CONSENT_FIELDS,
} as const;

export type Eip712Action = keyof typeof TYPES;

// ---- Canonical type strings (copied character-for-character from
// packages/contracts/src/DealTypes.sol MidmanDK *_TYPEHASH constants) ----

export const TYPE_STRINGS = {
  DealTerms:
    "DealTerms(bytes32 dealId,uint32 termsVersion,address buyerAddress,address sellerAddress,address sellerPayoutAddress,address buyerRefundAddress,address buyerBondRefundAddress,address sellerBondRefundAddress,address token,uint256 principal,uint256 quotedPlatformFee,uint16 buyerFeeBps,bytes32 agreementHash,bytes32 feePolicyId,uint32 deliveryPeriodSeconds,uint32 inspectionPeriodSeconds,bytes32 categoryPolicyId,bytes32 readinessPolicyId,bytes32 readinessConsentHash,bytes32 evidencePolicyId,bytes32 bondPolicyId,bytes32 arbitrationPolicyId,bytes32 outagePolicyId,bytes32 catastrophicPolicyId,address platformFeeRecipient,address arbitrationCostRecipient,uint64 fundingDeadline,bytes32 nonce,bytes32 salt,address factory,address implementation,address custodyAddress)",
  RevokeTerms:
    "RevokeTerms(bytes32 dealId,bytes32 agreementDigest,address revoker,bytes32 nonce,uint64 expiresAt)",
  MarkDelivered:
    "MarkDelivered(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 manifestHash,bytes32 nonce,uint64 expiresAt)",
  OpenDispute:
    "OpenDispute(bytes32 dealId,bytes32 agreementDigest,address actor,uint8 reasonCode,bytes32 initialCommitment,bytes32 nonce,uint64 expiresAt)",
  EscalateDispute:
    "EscalateDispute(bytes32 dealId,bytes32 agreementDigest,address actor,uint256 collateralAmount,uint8 collateralSource,bytes32 bondPolicyId,bytes32 claimId,bytes32 nonce,uint64 expiresAt)",
  ApproveSeller:
    "ApproveSeller(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 terminalPolicyVersion,bytes32 nonce,uint64 expiresAt)",
  RefundBuyer:
    "RefundBuyer(bytes32 dealId,bytes32 agreementDigest,address actor,bytes32 terminalPolicyVersion,bytes32 nonce,uint64 expiresAt)",
  MutualSettlement:
    "MutualSettlement(bytes32 dealId,bytes32 agreementDigest,uint256 sellerAward,uint256 buyerBondCost,uint256 sellerBondCost,uint8 expectedPhase,bytes32 settlementNonce,uint64 expiresAt)",
  ReserveExistingClaim:
    "ReserveExistingClaim(bytes32 dealId,bytes32 agreementDigest,address owner,bytes32 sourceClaimId,uint256 amount,uint8 party,bytes32 nonce,uint64 expiresAt)",
  EvidenceManifest:
    "EvidenceManifest(bytes32 dealId,bytes32 agreementDigest,address uploader,uint32 sequence,bytes32 prevCommitment,bytes32[] fileHashes,bytes32 metadataCommitment,bytes32 nonce,uint64 expiresAt)",
  Ruling:
    "Ruling(bytes32 dealId,bytes32 agreementDigest,bytes32 arbitrationPolicyId,uint8 origin,bytes32 rulingNonce,uint256 sellerAward,uint256 buyerBondCost,uint256 sellerBondCost,bytes32 evidenceCommitment,uint64 authEpoch,uint64 queueExpiry)",
  VetoRuling:
    "VetoRuling(bytes32 dealId,bytes32 rulingDigest,address authority,bytes32 nonce,uint64 expiresAt)",
  FundingAdmission:
    "FundingAdmission(bytes32 agreementDigest,bytes32 minPolicyId,bytes32 admissionNonce,uint64 expiresAt,bool expectedUnfunded)",
  FundWithAllowance:
    "FundWithAllowance(bytes32 dealId,bytes32 agreementDigest,address payer,uint256 amount,bytes32 paymentSalt,bytes32 nonce,uint64 expiresAt)",
  BondIntent:
    "BondIntent(bytes32 dealId,bytes32 agreementDigest,address party,uint256 amount,bool useExistingClaim,bytes32 claimId,bytes32 nonce,uint64 expiresAt)",
  ReadinessConsent:
    "ReadinessConsent(bytes32 dealId,bytes32 agreementDigest,address buyer,uint64 attestedAt,bytes32 nonce,uint64 expiresAt)",
} as const;

// ---- Helpers (viem encodeAbiParameters + keccak256) ----

type LooseParams = readonly { type: string }[];

/** Untyped ABI encoder (dynamic param lists cannot satisfy viem's generics). */
function encodeParams(params: LooseParams, values: readonly unknown[]): Hash {
  const encode = encodeAbiParameters as unknown as (
    p: LooseParams,
    v: readonly unknown[],
  ) => Hash;
  return encode(params, values);
}

/** keccak256 of a canonical type string (the on-chain *_TYPEHASH value). */
export function typeHash(action: Eip712Action): Hash {
  return keccak256(toHex(TYPE_STRINGS[action]));
}

/**
 * EIP-712 struct hash: keccak256(abi.encode(typeHash, ...values)).
 * `params` are the ABI types in field order (without the leading bytes32
 * typehash); `values` are the already-encoded field values in the same order.
 */
export function structHash(action: Eip712Action, params: LooseParams, values: readonly unknown[]): Hash {
  return keccak256(encodeParams([{ type: "bytes32" }, ...params], [typeHash(action), ...values]));
}

/** EIP-712 domain separator (identical to OpenZeppelin EIP712 construction). */
export function domainSeparator(chainId: number, verifyingContract: Address): Hash {
  return keccak256(
    encodeParams(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(toHex(EIP712_DOMAIN_TYPE_STRING)),
        keccak256(toHex(EIP712_DOMAIN.name)),
        keccak256(toHex(EIP712_DOMAIN.version)),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}

/** Full EIP-712 digest: keccak256(0x1901 || domainSeparator || structHash). */
export function digest(domainSeparatorValue: Hash, structHashValue: Hash): Hash {
  return keccak256(concat(["0x1901", domainSeparatorValue, structHashValue]));
}

/**
 * Evidence file-set hash: keccak256 over the raw concatenation of the
 * 32-byte file hashes. This is byte-equivalent to the contract's
 * `keccak256(abi.encodePacked(fileHashes))` (HubDispute.submitEvidenceCommitment):
 * abi.encodePacked of a bytes32[] is exactly the concatenation of its
 * elements, which is what viem's concat produces. Do NOT use
 * abi.encode (padded + length-prefixed) here — it yields a different hash
 * that the contract will reject.
 */
export function evidenceFilesHash(fileHashes: readonly Hash[]): Hash {
  return keccak256(concat([...fileHashes]));
}
