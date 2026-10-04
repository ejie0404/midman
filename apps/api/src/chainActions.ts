// Pure calldata + EIP-712 typed-data builders for the funding flow
// (audit finding #6: the web signs a 5-field MidmanDraft message, while
// MidmanHub.fund requires the full 32-field DealTerms plus the nested
// Payment3009 / AllowanceIntent / Admission / ReadinessAuth structs).
//
// Sources of truth (do not re-derive by hand):
//   - Field order / types / type strings: packages/chain/src/eip712.ts
//     (canonical @midman/chain, copied character-for-character from
//     packages/contracts/src/DealTypes.sol MidmanDK *_TYPEHASH constants).
//   - Calldata struct order: packages/chain/src/abi/generated/midmanHub.ts
//     (generated from the compiled MidmanHub artifact).
//   - Payment nonce derivation: packages/contracts/src/MidmanHub.sol fund()
//     line 320: keccak256(abi.encode(t.dealId, digest, pay.paymentSalt)).
import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hash, type Hex } from "viem";
import { HUB_ABI, TYPES as EIP712_TYPES, buildDomain } from "@midman/chain";

/** Minimal ERC-20 approve ABI for the direct (non-3009) funding path. */
export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function asAddress(value: string | undefined, field: string): Address {
  if (value === undefined || !ADDRESS_RE.test(value)) throw new Error(`Invalid address for ${field}`);
  return value as Address;
}

function asHash(value: string | undefined, field: string): Hash {
  if (value === undefined || !BYTES32_RE.test(value)) throw new Error(`Invalid bytes32 for ${field}`);
  return value as Hash;
}

function asUint(value: string | number | bigint | undefined, field: string): bigint {
  if (value === undefined) throw new Error(`Missing integer for ${field}`);
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`Invalid integer for ${field}`);
    return BigInt(value);
  }
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid integer for ${field}`);
  return BigInt(value);
}

function asHex(value: string | undefined, field: string): Hex {
  if (value === undefined || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`Invalid hex for ${field}`);
  return value as Hex;
}

export interface DomainType {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export interface DealTermsTypedData {
  readonly domain: DomainType;
  readonly types: { readonly DealTerms: typeof EIP712_TYPES.DealTerms };
  readonly primaryType: "DealTerms";
  /** Exact typed values in canonical DealTerms field order (bigints for uints). */
  readonly message: Record<string, bigint | string>;
}

export interface FundWithAllowanceTypedData {
  readonly domain: DomainType;
  readonly types: { readonly FundWithAllowance: typeof EIP712_TYPES.FundWithAllowance };
  readonly primaryType: "FundWithAllowance";
  readonly message: {
    readonly dealId: Hash;
    readonly agreementDigest: Hash;
    readonly payer: Address;
    readonly amount: bigint;
    readonly paymentSalt: Hash;
    readonly nonce: Hash;
    readonly expiresAt: bigint;
  };
}

export interface FundingAdmissionTypedData {
  readonly domain: DomainType;
  readonly types: { readonly FundingAdmission: typeof EIP712_TYPES.FundingAdmission };
  readonly primaryType: "FundingAdmission";
  readonly message: {
    readonly agreementDigest: Hash;
    readonly minPolicyId: Hash;
    readonly admissionNonce: Hash;
    readonly expiresAt: bigint;
    readonly expectedUnfunded: boolean;
  };
}

export interface ReadinessConsentTypedData {
  readonly domain: DomainType;
  readonly types: { readonly ReadinessConsent: typeof EIP712_TYPES.ReadinessConsent };
  readonly primaryType: "ReadinessConsent";
  readonly message: {
    readonly dealId: Hash;
    readonly agreementDigest: Hash;
    readonly buyer: Address;
    readonly attestedAt: bigint;
    readonly nonce: Hash;
    readonly expiresAt: bigint;
  };
}

/**
 * EIP-712 typed data for the full on-chain DealTerms struct. Values are the
 * exact typed fields (bigint for every uint, 0x strings otherwise) in the
 * canonical @midman/chain order, so wallets sign the same digest the hub's
 * agreementDigestOf() recomputes.
 */
export function dealTermsTypedData(
  chainId: number,
  hub: Address,
  fullTerms: Record<string, string>,
): DealTermsTypedData {
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("Invalid chainId");
  const domain = buildDomain(chainId, asAddress(hub, "hub"));
  const message: Record<string, bigint | string> = {};
  for (const field of EIP712_TYPES.DealTerms) {
    const raw = fullTerms[field.name];
    if (raw === undefined) throw new Error(`Missing DealTerms field ${field.name}`);
    message[field.name] = field.type.startsWith("uint") ? asUint(raw, field.name) : raw;
  }
  return { domain, types: { DealTerms: EIP712_TYPES.DealTerms }, primaryType: "DealTerms", message };
}

/** EIP-712 FundWithAllowance typed data (buyer-signed allowance path). */
export function fundWithAllowanceTypedData(params: {
  chainId: number;
  hub: Address;
  dealId: string;
  agreementDigest: string;
  payer: string;
  amountUnits: string | number | bigint;
  paymentSalt: string;
  nonce: string;
  expiresAt: string | number | bigint;
}): FundWithAllowanceTypedData {
  return {
    domain: buildDomain(params.chainId, asAddress(params.hub, "hub")),
    types: { FundWithAllowance: EIP712_TYPES.FundWithAllowance },
    primaryType: "FundWithAllowance",
    message: {
      dealId: asHash(params.dealId, "dealId"),
      agreementDigest: asHash(params.agreementDigest, "agreementDigest"),
      payer: asAddress(params.payer, "payer"),
      amount: asUint(params.amountUnits, "amountUnits"),
      paymentSalt: asHash(params.paymentSalt, "paymentSalt"),
      nonce: asHash(params.nonce, "nonce"),
      expiresAt: asUint(params.expiresAt, "expiresAt"),
    },
  };
}

/** EIP-712 FundingAdmission typed data (risk signer admits an unfunded deal). */
export function fundingAdmissionTypedData(params: {
  chainId: number;
  hub: Address;
  agreementDigest: string;
  minPolicyId: string;
  admissionNonce: string;
  expiresAt: string | number | bigint;
  expectedUnfunded: boolean;
}): FundingAdmissionTypedData {
  return {
    domain: buildDomain(params.chainId, asAddress(params.hub, "hub")),
    types: { FundingAdmission: EIP712_TYPES.FundingAdmission },
    primaryType: "FundingAdmission",
    message: {
      agreementDigest: asHash(params.agreementDigest, "agreementDigest"),
      minPolicyId: asHash(params.minPolicyId, "minPolicyId"),
      admissionNonce: asHash(params.admissionNonce, "admissionNonce"),
      expiresAt: asUint(params.expiresAt, "expiresAt"),
      expectedUnfunded: Boolean(params.expectedUnfunded),
    },
  };
}

/** EIP-712 ReadinessConsent typed data (P-11 buyer attestation, <=3h tier). */
export function readinessConsentTypedData(params: {
  chainId: number;
  hub: Address;
  dealId: string;
  agreementDigest: string;
  buyer: string;
  attestedAt: string | number | bigint;
  nonce: string;
  expiresAt: string | number | bigint;
}): ReadinessConsentTypedData {
  return {
    domain: buildDomain(params.chainId, asAddress(params.hub, "hub")),
    types: { ReadinessConsent: EIP712_TYPES.ReadinessConsent },
    primaryType: "ReadinessConsent",
    message: {
      dealId: asHash(params.dealId, "dealId"),
      agreementDigest: asHash(params.agreementDigest, "agreementDigest"),
      buyer: asAddress(params.buyer, "buyer"),
      attestedAt: asUint(params.attestedAt, "attestedAt"),
      nonce: asHash(params.nonce, "nonce"),
      expiresAt: asUint(params.expiresAt, "expiresAt"),
    },
  };
}

/**
 * EIP-3009 payment nonce, exactly as MidmanHub.fund() derives it
 * (packages/contracts/src/MidmanHub.sol line 320):
 *   keccak256(abi.encode(t.dealId, digest, pay.paymentSalt))
 * abi.encode of three bytes32 values === abi.encodeParameters(bytes32,bytes32,bytes32).
 */
export function paymentNonce(dealId: string, agreementDigest: string, paymentSalt: string): Hash {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [
        asHash(dealId, "dealId"),
        asHash(agreementDigest, "agreementDigest"),
        asHash(paymentSalt, "paymentSalt"),
      ],
    ),
  );
}

export interface Payment3009Input {
  readonly validAfter?: string | number | bigint;
  readonly validBefore?: string | number | bigint;
  readonly paymentSalt: string;
  readonly v?: string | number | bigint;
  readonly r?: string;
  readonly s?: string;
  readonly use3009?: boolean;
}

export interface AllowanceIntentInput {
  readonly paymentSalt: string;
  readonly nonce: string;
  readonly expiresAt: string | number | bigint;
  readonly signature: string;
}

export interface AdmissionInput {
  readonly minPolicyId: string;
  readonly admissionNonce: string;
  readonly expiresAt: string | number | bigint;
  readonly signature: string;
}

export interface ReadinessAuthInput {
  readonly attestedAt: string | number | bigint;
  readonly nonce: string;
  readonly expiresAt: string | number | bigint;
  readonly signature: string;
}

/** DealTerms tuple in the exact ABI component order (midmanHub.ts fund inputs). */
function dealTermsStruct(fullTerms: Record<string, string>) {
  return {
    dealId: asHash(fullTerms["dealId"], "dealId"),
    termsVersion: Number(asUint(fullTerms["termsVersion"], "termsVersion")),
    buyerAddress: asAddress(fullTerms["buyerAddress"], "buyerAddress"),
    sellerAddress: asAddress(fullTerms["sellerAddress"], "sellerAddress"),
    sellerPayoutAddress: asAddress(fullTerms["sellerPayoutAddress"], "sellerPayoutAddress"),
    buyerRefundAddress: asAddress(fullTerms["buyerRefundAddress"], "buyerRefundAddress"),
    buyerBondRefundAddress: asAddress(fullTerms["buyerBondRefundAddress"], "buyerBondRefundAddress"),
    sellerBondRefundAddress: asAddress(fullTerms["sellerBondRefundAddress"], "sellerBondRefundAddress"),
    token: asAddress(fullTerms["token"], "token"),
    principal: asUint(fullTerms["principal"], "principal"),
    quotedPlatformFee: asUint(fullTerms["quotedPlatformFee"], "quotedPlatformFee"),
    buyerFeeBps: Number(asUint(fullTerms["buyerFeeBps"], "buyerFeeBps")),
    agreementHash: asHash(fullTerms["agreementHash"], "agreementHash"),
    feePolicyId: asHash(fullTerms["feePolicyId"], "feePolicyId"),
    deliveryPeriodSeconds: Number(asUint(fullTerms["deliveryPeriodSeconds"], "deliveryPeriodSeconds")),
    inspectionPeriodSeconds: Number(asUint(fullTerms["inspectionPeriodSeconds"], "inspectionPeriodSeconds")),
    categoryPolicyId: asHash(fullTerms["categoryPolicyId"], "categoryPolicyId"),
    readinessPolicyId: asHash(fullTerms["readinessPolicyId"], "readinessPolicyId"),
    readinessConsentHash: asHash(fullTerms["readinessConsentHash"], "readinessConsentHash"),
    evidencePolicyId: asHash(fullTerms["evidencePolicyId"], "evidencePolicyId"),
    bondPolicyId: asHash(fullTerms["bondPolicyId"], "bondPolicyId"),
    arbitrationPolicyId: asHash(fullTerms["arbitrationPolicyId"], "arbitrationPolicyId"),
    outagePolicyId: asHash(fullTerms["outagePolicyId"], "outagePolicyId"),
    catastrophicPolicyId: asHash(fullTerms["catastrophicPolicyId"], "catastrophicPolicyId"),
    platformFeeRecipient: asAddress(fullTerms["platformFeeRecipient"], "platformFeeRecipient"),
    arbitrationCostRecipient: asAddress(fullTerms["arbitrationCostRecipient"], "arbitrationCostRecipient"),
    fundingDeadline: asUint(fullTerms["fundingDeadline"], "fundingDeadline"),
    nonce: asHash(fullTerms["nonce"], "nonce"),
    salt: asHash(fullTerms["salt"], "salt"),
    factory: asAddress(fullTerms["factory"], "factory"),
    implementation: asAddress(fullTerms["implementation"], "implementation"),
    custodyAddress: asAddress(fullTerms["custodyAddress"], "custodyAddress"),
  };
}

function paymentStruct(pay: Payment3009Input) {
  return {
    validAfter: asUint(pay.validAfter ?? 0, "pay.validAfter"),
    validBefore: asUint(pay.validBefore ?? 0, "pay.validBefore"),
    paymentSalt: asHash(pay.paymentSalt, "pay.paymentSalt"),
    v: Number(asUint(pay.v ?? 0, "pay.v")),
    r: asHash(pay.r ?? "0x0000000000000000000000000000000000000000000000000000000000000000", "pay.r"),
    s: asHash(pay.s ?? "0x0000000000000000000000000000000000000000000000000000000000000000", "pay.s"),
    use3009: Boolean(pay.use3009),
  };
}

/**
 * Encode the seven-argument fund(...) call in the generated ABI's exact
 * struct order: (DealTerms, bytes sigBuyer, bytes sigSeller, Payment3009,
 * AllowanceIntent, Admission, ReadinessAuth).
 */
export function buildFundCalldata(input: {
  fullTerms: Record<string, string>;
  sigBuyer: string;
  sigSeller: string;
  pay: Payment3009Input;
  allowance: AllowanceIntentInput;
  admission: AdmissionInput;
  readiness: ReadinessAuthInput;
}): Hex {
  return encodeFunctionData({
    abi: HUB_ABI,
    functionName: "fund",
    args: [
      dealTermsStruct(input.fullTerms),
      asHex(input.sigBuyer, "sigBuyer"),
      asHex(input.sigSeller, "sigSeller"),
      paymentStruct(input.pay),
      {
        paymentSalt: asHash(input.allowance.paymentSalt, "allowance.paymentSalt"),
        nonce: asHash(input.allowance.nonce, "allowance.nonce"),
        expiresAt: asUint(input.allowance.expiresAt, "allowance.expiresAt"),
        signature: asHex(input.allowance.signature, "allowance.signature"),
      },
      {
        minPolicyId: asHash(input.admission.minPolicyId, "admission.minPolicyId"),
        admissionNonce: asHash(input.admission.admissionNonce, "admission.admissionNonce"),
        expiresAt: asUint(input.admission.expiresAt, "admission.expiresAt"),
        signature: asHex(input.admission.signature, "admission.signature"),
      },
      {
        attestedAt: asUint(input.readiness.attestedAt, "readiness.attestedAt"),
        nonce: asHash(input.readiness.nonce, "readiness.nonce"),
        expiresAt: asUint(input.readiness.expiresAt, "readiness.expiresAt"),
        signature: asHex(input.readiness.signature, "readiness.signature"),
      },
    ],
  }) as Hex;
}

/** Encode ERC-20 approve(spender, amount) calldata for the direct fund path. */
export function buildApproveCalldata(
  token: string,
  spender: string,
  amount: string | number | bigint,
): Hex {
  // `token` is the call target; validate it here so a bad address fails loudly
  // even though `approve` itself only encodes (spender, amount).
  asAddress(token, "token");
  return encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [asAddress(spender, "spender"), asUint(amount, "amount")],
  }) as Hex;
}
