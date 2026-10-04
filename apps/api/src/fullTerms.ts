// Full 32-field DealTerms record + EIP-712 agreement digest for off-chain
// exports (download / readiness). The EIP-712 schema (field order, types,
// type string, domain) is the canonical @midman/chain definition, which
// matches packages/contracts/src/DealTypes.sol (DealTerms struct +
// DEAL_TERMS_TYPEHASH) character-for-character.
// Canonical terms shape (src/terms.ts) is NOT changed; termsVersion "1" is
// derived here. All money stays exact integer-unit strings, never floats.
import { hashTypedData, keccak256, toHex, type Address, type Hash } from "viem";
import { TYPES as EIP712_TYPES, buildDomain, structHash } from "@midman/chain";
import type { CanonicalTerms } from "./terms.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** Ordered field names: canonical @midman/chain DealTerms order == DealTypes.sol struct order. */
export const DEAL_TERMS_FIELD_ORDER: readonly string[] = EIP712_TYPES.DealTerms.map((field) => field.name);

/** EIP-712 types for the on-chain DealTerms struct (canonical @midman/chain definition). */
export const DEAL_TERMS_TYPES = {
  DealTerms: EIP712_TYPES.DealTerms,
} as const;

function asAddress(value: string, field: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address for ${field}`);
  return value as Address;
}

function asHash(value: string, field: string): Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid bytes32 for ${field}`);
  return value as Hash;
}

function asUint(value: string, field: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid integer for ${field}`);
  return BigInt(value);
}

/** Normalize any stored policy reference to bytes32 (identity for bytes32, keccak otherwise, zero when absent). */
function toBytes32(value: string | undefined): Hash {
  if (value === undefined || value === "") return ZERO_HASH as unknown as Hash;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value as Hash;
  return keccak256(toHex(value));
}

function policyId(terms: CanonicalTerms, ...names: string[]): Hash {
  for (const name of names) {
    const value = terms[`policy:${name}`];
    if (value !== undefined) return toBytes32(value);
  }
  return ZERO_HASH as unknown as Hash;
}

export function fullTermsDomain(chainId: number, hub: Address): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
} {
  return buildDomain(chainId, hub);
}

export interface FullTermsResult {
  /** Ordered 32-field record; all integers are exact decimal strings. */
  readonly fullTerms: Record<string, string>;
  readonly agreementDigest: Hash;
  /** Domain-independent struct hash (isolates field order/type parity). */
  readonly structHash: Hash;
}

/**
 * Canonical terms + hub -> ordered 32-field DealTerms record + EIP-712
 * agreement digest (domain MidmanEscrow/1/chainId/hub). Deterministic:
 * same inputs always yield the same digest.
 */
export function buildFullTerms(terms: CanonicalTerms, hub: Address): FullTermsResult {
  const custody = asAddress(hub, "hub");
  const chainId = Number(terms["chainId"]);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("Invalid chainId for domain");
  // Ordered insert: key order MUST stay DEAL_TERMS_FIELD_ORDER.
  const fullTerms: Record<string, string> = {
    dealId: asHash(terms["dealId"]!, "dealId"),
    termsVersion: "1",
    buyerAddress: asAddress(terms["buyer"]!, "buyer"),
    sellerAddress: asAddress(terms["seller"]!, "seller"),
    sellerPayoutAddress: asAddress(terms["sellerPayout"] ?? terms["seller"]!, "sellerPayout"),
    buyerRefundAddress: asAddress(terms["buyerRefund"] ?? terms["buyer"]!, "buyerRefund"),
    buyerBondRefundAddress: asAddress(terms["buyerBondRefund"] ?? terms["buyer"]!, "buyerBondRefund"),
    sellerBondRefundAddress: asAddress(terms["sellerBondRefund"] ?? terms["seller"]!, "sellerBondRefund"),
    token: asAddress(terms["token"]!, "token"),
    principal: asUint(terms["principalUnits"]!, "principalUnits").toString(),
    quotedPlatformFee: asUint(terms["quotedFeeUnits"]!, "quotedFeeUnits").toString(),
    buyerFeeBps: asUint(terms["buyerFeeBps"]!, "buyerFeeBps").toString(),
    agreementHash: asHash(terms["agreementHash"]!, "agreementHash"),
    feePolicyId: policyId(terms, "fee", "feePolicyId"),
    deliveryPeriodSeconds: asUint(terms["deliverySeconds"]!, "deliverySeconds").toString(),
    inspectionPeriodSeconds: asUint(terms["inspectionSeconds"]!, "inspectionSeconds").toString(),
    categoryPolicyId: policyId(terms, "category", "categoryPolicyId"),
    readinessPolicyId: policyId(terms, "readiness", "readinessPolicyId"),
    readinessConsentHash: asHash(
      terms["readinessConsentHash"] ??
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      "readinessConsentHash",
    ),
    evidencePolicyId: policyId(terms, "evidence", "evidencePolicyId"),
    bondPolicyId: policyId(terms, "bond", "bondPolicyId"),
    arbitrationPolicyId: policyId(terms, "arbitration", "arbitrationPolicyId"),
    outagePolicyId: policyId(terms, "outage", "outagePolicyId"),
    catastrophicPolicyId: policyId(terms, "catastrophic", "catastrophicPolicyId"),
    platformFeeRecipient: asAddress(terms["platformFeeRecipient"]!, "platformFeeRecipient"),
    arbitrationCostRecipient: asAddress(terms["arbitrationCostRecipient"]!, "arbitrationCostRecipient"),
    fundingDeadline: asUint(terms["fundingDeadline"]!, "fundingDeadline").toString(),
    nonce: asHash(terms["nonce"]!, "nonce"),
    salt: asHash(terms["salt"]!, "salt"),
    factory: ZERO_ADDRESS as unknown as string,
    implementation: ZERO_ADDRESS as unknown as string,
    custodyAddress: custody,
  };
  const agreementDigest = hashTypedData({
    domain: fullTermsDomain(chainId, custody),
    types: DEAL_TERMS_TYPES,
    primaryType: "DealTerms",
    message: {
      dealId: fullTerms["dealId"] as Hash,
      termsVersion: Number(fullTerms["termsVersion"]),
      buyerAddress: fullTerms["buyerAddress"] as Address,
      sellerAddress: fullTerms["sellerAddress"] as Address,
      sellerPayoutAddress: fullTerms["sellerPayoutAddress"] as Address,
      buyerRefundAddress: fullTerms["buyerRefundAddress"] as Address,
      buyerBondRefundAddress: fullTerms["buyerBondRefundAddress"] as Address,
      sellerBondRefundAddress: fullTerms["sellerBondRefundAddress"] as Address,
      token: fullTerms["token"] as Address,
      principal: BigInt(fullTerms["principal"]!),
      quotedPlatformFee: BigInt(fullTerms["quotedPlatformFee"]!),
      buyerFeeBps: Number(fullTerms["buyerFeeBps"]),
      agreementHash: fullTerms["agreementHash"] as Hash,
      feePolicyId: fullTerms["feePolicyId"] as Hash,
      deliveryPeriodSeconds: Number(fullTerms["deliveryPeriodSeconds"]),
      inspectionPeriodSeconds: Number(fullTerms["inspectionPeriodSeconds"]),
      categoryPolicyId: fullTerms["categoryPolicyId"] as Hash,
      readinessPolicyId: fullTerms["readinessPolicyId"] as Hash,
      readinessConsentHash: fullTerms["readinessConsentHash"] as Hash,
      evidencePolicyId: fullTerms["evidencePolicyId"] as Hash,
      bondPolicyId: fullTerms["bondPolicyId"] as Hash,
      arbitrationPolicyId: fullTerms["arbitrationPolicyId"] as Hash,
      outagePolicyId: fullTerms["outagePolicyId"] as Hash,
      catastrophicPolicyId: fullTerms["catastrophicPolicyId"] as Hash,
      platformFeeRecipient: fullTerms["platformFeeRecipient"] as Address,
      arbitrationCostRecipient: fullTerms["arbitrationCostRecipient"] as Address,
      fundingDeadline: BigInt(fullTerms["fundingDeadline"]!),
      nonce: fullTerms["nonce"] as Hash,
      salt: fullTerms["salt"] as Hash,
      factory: fullTerms["factory"] as Address,
      implementation: fullTerms["implementation"] as Address,
      custodyAddress: fullTerms["custodyAddress"] as Address,
    },
  });
  return { fullTerms, agreementDigest, structHash: structHashOf(fullTerms) };
}

/** EIP-712 struct hash of the ordered record (no domain dependence). */
export function structHashOf(fullTerms: Record<string, string>): Hash {
  return structHash(
    "DealTerms",
    [
      { type: "bytes32" }, // dealId
      { type: "uint32" }, // termsVersion
      { type: "address" }, // buyerAddress
      { type: "address" }, // sellerAddress
      { type: "address" }, // sellerPayoutAddress
      { type: "address" }, // buyerRefundAddress
      { type: "address" }, // buyerBondRefundAddress
      { type: "address" }, // sellerBondRefundAddress
      { type: "address" }, // token
      { type: "uint256" }, // principal
      { type: "uint256" }, // quotedPlatformFee
      { type: "uint16" }, // buyerFeeBps
      { type: "bytes32" }, // agreementHash
      { type: "bytes32" }, // feePolicyId
      { type: "uint32" }, // deliveryPeriodSeconds
      { type: "uint32" }, // inspectionPeriodSeconds
      { type: "bytes32" }, // categoryPolicyId
      { type: "bytes32" }, // readinessPolicyId
      { type: "bytes32" }, // readinessConsentHash
      { type: "bytes32" }, // evidencePolicyId
      { type: "bytes32" }, // bondPolicyId
      { type: "bytes32" }, // arbitrationPolicyId
      { type: "bytes32" }, // outagePolicyId
      { type: "bytes32" }, // catastrophicPolicyId
      { type: "address" }, // platformFeeRecipient
      { type: "address" }, // arbitrationCostRecipient
      { type: "uint64" }, // fundingDeadline
      { type: "bytes32" }, // nonce
      { type: "bytes32" }, // salt
      { type: "address" }, // factory
      { type: "address" }, // implementation
      { type: "address" }, // custodyAddress
    ],
    [
      fullTerms["dealId"] as Hash,
        Number(fullTerms["termsVersion"]),
        fullTerms["buyerAddress"] as Address,
        fullTerms["sellerAddress"] as Address,
        fullTerms["sellerPayoutAddress"] as Address,
        fullTerms["buyerRefundAddress"] as Address,
        fullTerms["buyerBondRefundAddress"] as Address,
        fullTerms["sellerBondRefundAddress"] as Address,
        fullTerms["token"] as Address,
        BigInt(fullTerms["principal"]!),
        BigInt(fullTerms["quotedPlatformFee"]!),
        Number(fullTerms["buyerFeeBps"]),
        fullTerms["agreementHash"] as Hash,
        fullTerms["feePolicyId"] as Hash,
        Number(fullTerms["deliveryPeriodSeconds"]),
        Number(fullTerms["inspectionPeriodSeconds"]),
        fullTerms["categoryPolicyId"] as Hash,
        fullTerms["readinessPolicyId"] as Hash,
        fullTerms["readinessConsentHash"] as Hash,
        fullTerms["evidencePolicyId"] as Hash,
        fullTerms["bondPolicyId"] as Hash,
        fullTerms["arbitrationPolicyId"] as Hash,
        fullTerms["outagePolicyId"] as Hash,
        fullTerms["catastrophicPolicyId"] as Hash,
        fullTerms["platformFeeRecipient"] as Address,
        fullTerms["arbitrationCostRecipient"] as Address,
        BigInt(fullTerms["fundingDeadline"]!),
        fullTerms["nonce"] as Hash,
        fullTerms["salt"] as Hash,
        fullTerms["factory"] as Address,
        fullTerms["implementation"] as Address,
        fullTerms["custodyAddress"] as Address,
    ],
  );
}
