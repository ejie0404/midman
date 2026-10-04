// Off-chain drafting: canonical terms generation, exact financial preview,
// and EIP-712 signature collection. No funded chain state is created here;
// funding happens only through the wallet/relayer with both signatures.
import { randomBytes } from "node:crypto";
import { recoverTypedDataAddress, type Address, type Hash } from "viem";
import {
  quoteFee,
  normalSettlement,
  catastrophicSplit,
  type FeeAllocationBps,
} from "@midman/shared";

export const CATEGORY_MINIMUMS: Record<string, number> = {
  INSTANT_CODE: 3_600,
  GAME_ITEM: 43_200,
  GAME_CURRENCY: 43_200,
  DIGITAL_GOOD: 43_200,
  SERVICE: 43_200,
  GAME_ACCOUNT: 86_400,
};

export interface DraftTermsInput {
  readonly buyer: Address;
  readonly seller: Address;
  readonly sellerPayout?: Address;
  readonly buyerRefund?: Address;
  readonly buyerBondRefund?: Address;
  readonly sellerBondRefund?: Address;
  readonly principalUnits: string;
  readonly buyerFeeBps: FeeAllocationBps;
  readonly deliverySeconds: number;
  readonly inspectionSeconds: number;
  readonly category: keyof typeof CATEGORY_MINIMUMS;
  readonly agreementHash: Hash;
  readonly policyIds: Record<string, string>;
  readonly platformFeeRecipient: Address;
  readonly arbitrationCostRecipient: Address;
  readonly hub: Address;
  readonly token: Address;
  readonly chainId: number;
  readonly fundingDays?: number;
  /** Optional readiness attestation commitment; defaults to the zero hash
   * (only valid with a no-readiness policy — the contract enforces this). */
  readonly readinessConsentHash?: Hash;
}

export interface CanonicalTerms extends Record<string, string> {
  readonly dealId: string;
  readonly buyer: string;
  readonly seller: string;
  readonly principalUnits: string;
  readonly quotedFeeUnits: string;
  readonly prepaidBuyerFeeUnits: string;
  readonly fundedUnits: string;
  readonly buyerFeeBps: string;
  readonly deliverySeconds: string;
  readonly inspectionSeconds: string;
  readonly fundingDeadline: string;
  readonly readinessConsentHash: string;
  readonly nonce: string;
  readonly salt: string;
}

const hex32 = (): Hash => `0x${randomBytes(32).toString("hex")}` as Hash;

function asAddress(value: string, field: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address for ${field}`);
  return value as Address;
}

/** Build canonical terms; throws on any policy/economic violation. */
export function buildCanonicalTerms(input: DraftTermsInput, nowSeconds: number): CanonicalTerms {
  const principal = BigInt(input.principalUnits);
  if (principal < 5_000_000n) throw new Error("Below 5 USDC minimum principal");
  if (![0, 5_000, 10_000].includes(input.buyerFeeBps)) throw new Error("Unsupported fee allocation");
  const minInspection = CATEGORY_MINIMUMS[input.category];
  if (minInspection === undefined) throw new Error("Unknown category");
  if (!Number.isInteger(input.deliverySeconds) || input.deliverySeconds < 3_600 || input.deliverySeconds > 2_592_000) {
    throw new Error("Delivery out of bounds (1h-30d)");
  }
  if (!Number.isInteger(input.inspectionSeconds) || input.inspectionSeconds < minInspection || input.inspectionSeconds > 1_209_600) {
    throw new Error("Inspection violates category minimum or 14d maximum");
  }
  const duration = input.deliverySeconds + input.inspectionSeconds;
  const quoted = quoteFee(principal, duration); // locked CEIL rule, shared with contracts
  const prepaid = (quoted * BigInt(input.buyerFeeBps)) / 10_000n;
  const fundingDays = input.fundingDays ?? 7;
  return {
    dealId: hex32(),
    buyer: asAddress(input.buyer, "buyer"),
    seller: asAddress(input.seller, "seller"),
    sellerPayout: asAddress(input.sellerPayout ?? input.seller, "sellerPayout"),
    buyerRefund: asAddress(input.buyerRefund ?? input.buyer, "buyerRefund"),
    buyerBondRefund: asAddress(input.buyerBondRefund ?? input.buyer, "buyerBondRefund"),
    sellerBondRefund: asAddress(input.sellerBondRefund ?? input.seller, "sellerBondRefund"),
    token: asAddress(input.token, "token"),
    hub: asAddress(input.hub, "hub"),
    principalUnits: principal.toString(),
    quotedFeeUnits: quoted.toString(),
    prepaidBuyerFeeUnits: prepaid.toString(),
    fundedUnits: (principal + prepaid).toString(),
    buyerFeeBps: String(input.buyerFeeBps),
    deliverySeconds: String(input.deliverySeconds),
    inspectionSeconds: String(input.inspectionSeconds),
    durationSeconds: String(duration),
    category: input.category,
    agreementHash: input.agreementHash,
    fundingDeadline: String(nowSeconds + fundingDays * 86_400),
    readinessConsentHash: input.readinessConsentHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
    nonce: hex32(),
    salt: hex32(),
    chainId: String(input.chainId),
    platformFeeRecipient: asAddress(input.platformFeeRecipient, "platformFeeRecipient"),
    arbitrationCostRecipient: asAddress(input.arbitrationCostRecipient, "arbitrationCostRecipient"),
    ...Object.fromEntries(Object.entries(input.policyIds).map(([k, v]) => [`policy:${k}`, v])),
  };
}

const DEAL_TYPES = {
  DealTerms: [
    { name: "dealId", type: "bytes32" },
    { name: "principal", type: "uint256" },
    { name: "quotedPlatformFee", type: "uint256" },
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
  ],
} as const;

/** Typed-data payload shown to wallets for the off-chain acceptance signature. */
export function acceptanceTypedData(terms: CanonicalTerms): {
  domain: Record<string, string | number>;
  types: typeof DEAL_TYPES;
  primaryType: "DealTerms";
  message: Record<string, string>;
} {
  return {
    domain: { name: "MidmanDraft", version: "1", chainId: Number(terms["chainId"]), verifyingContract: terms["hub"]! },
    types: DEAL_TYPES,
    primaryType: "DealTerms",
    message: {
      dealId: terms["dealId"]!,
      principal: terms["principalUnits"]!,
      quotedPlatformFee: terms["quotedFeeUnits"]!,
      buyer: terms["buyer"]!,
      seller: terms["seller"]!,
    },
  };
}

/** Verify an acceptance signature recovers to the expected counterparty. */
export async function verifyAcceptanceSignature(params: {
  terms: CanonicalTerms;
  expected: Address;
  signature: Hash;
}): Promise<boolean> {
  const typed = acceptanceTypedData(params.terms);
  const recovered = await recoverTypedDataAddress({
    domain: typed.domain as { name: string; version: string; chainId: number; verifyingContract: Address },
    types: typed.types,
    primaryType: typed.primaryType,
    message: {
      dealId: typed.message["dealId"] as Hash,
      principal: BigInt(typed.message["principal"]!),
      quotedPlatformFee: BigInt(typed.message["quotedPlatformFee"]!),
      buyer: typed.message["buyer"] as Address,
      seller: typed.message["seller"] as Address,
    },
    signature: params.signature,
  });
  return recovered.toLowerCase() === params.expected.toLowerCase();
}

/** Exact settlement preview for a seller award S (smallest units, strings). */
export function previewSettlement(params: {
  principalUnits: string;
  quotedFeeUnits: string;
  buyerFeeBps: FeeAllocationBps;
  sellerAwardUnits: string;
}): Record<string, string> {
  const result = normalSettlement(
    BigInt(params.principalUnits),
    BigInt(params.quotedFeeUnits),
    BigInt(params.sellerAwardUnits),
    params.buyerFeeBps,
  );
  return {
    prepaidBuyerFee: result.prepaidBuyerFee.toString(),
    earnedFee: result.earnedFee.toString(),
    buyerFee: result.buyerFee.toString(),
    sellerFee: result.sellerFee.toString(),
    buyerClaim: result.buyerClaim.toString(),
    sellerClaim: result.sellerClaim.toString(),
    funded: result.funded.toString(),
  };
}

/** Catastrophic 50/50 preview (odd unit to buyer). */
export function previewCatastrophic(principalUnits: string, prepaidUnits: string): Record<string, string> {
  const { buyerShare, sellerShare } = catastrophicSplit(BigInt(principalUnits));
  const prepaid = BigInt(prepaidUnits);
  return {
    buyerClaim: (buyerShare + prepaid).toString(),
    sellerClaim: sellerShare.toString(),
    platformFee: "0",
  };
}
