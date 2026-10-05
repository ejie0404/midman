// Reviewer award drafts (Phase 9): arbitrators choose S only.
// Bond costs are DERIVED exactly via @midman/shared partialBondCosts:
//   Cb = floor(Qb * S / P), Cs = floor(Qs * (P - S) / P)  (P-03).
// Ruling EIP-712 field order is EXACTLY per specs/phase2-threat-model.md:
//   dealId, agreementDigest, arbitrationPolicyId, origin, rulingNonce,
//   sellerAward, buyerBondCost, sellerBondCost, evidenceCommitment,
//   authEpoch, queueExpiry. Field order is signing-significant; do not reorder.
import { hashTypedData, type Address, type Hash, type Hex } from "viem";
import { TYPES as EIP712_TYPES } from "@midman/chain";
import { normalSettlement, partialBondCosts } from "@midman/shared";
import { DurableCollection, RegistryWriter, type RegistryAdapter } from "@midman/store";

const AWARD_NS = "review.award-drafts";
const writer = new RegistryWriter();
const drafts = new DurableCollection<AwardDraft>(AWARD_NS, writer, (draft) => draft.rulingDigest.toLowerCase());

export const RULING_TYPES = {
  Ruling: EIP712_TYPES.Ruling,
} as const;

export const RULING_FIELD_ORDER: readonly string[] = RULING_TYPES.Ruling.map((field) => field.name);

export interface DraftAwardInput {
  readonly principalUnits: string;
  readonly quotedFeeUnits: string;
  readonly buyerFeeBps: 0 | 5000 | 10000;
  readonly sellerAwardUnits: string;
  readonly claimantBondUnits: string;
  readonly respondentBondUnits: string;
  readonly evidenceCommitment: string;
  readonly origin: number;
  readonly rulingNonce: string;
  readonly authEpoch: string | number;
  readonly queueExpiry: string | number;
  readonly arbitrationPolicyId: string;
  readonly dealId: string;
  readonly agreementDigest: string;
  /** EIP-712 domain: { name: "MidmanEscrow", version: "1", chainId, verifyingContract: hub }. */
  readonly chainId: number;
  readonly hub: string;
}

export interface AwardDraft {
  readonly dealId: string;
  readonly agreementDigest: string;
  readonly arbitrationPolicyId: string;
  readonly origin: number;
  readonly rulingNonce: string;
  readonly sellerAward: string;
  readonly buyerCost: string;
  readonly sellerCost: string;
  readonly earnedFeePreview: string;
  readonly evidenceCommitment: string;
  readonly authEpoch: string;
  readonly queueExpiry: string;
  /** EIP-712 hash of the Ruling struct (also the on-chain rulingDigest). */
  readonly rulingDigest: string;
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: string };
  readonly types: typeof RULING_TYPES;
  readonly primaryType: "Ruling";
  /** JSON-safe message (uint fields as decimal strings, same convention as commitments). */
  readonly message: {
    readonly dealId: string;
    readonly agreementDigest: string;
    readonly arbitrationPolicyId: string;
    readonly origin: number;
    readonly rulingNonce: string;
    readonly sellerAward: string;
    readonly buyerBondCost: string;
    readonly sellerBondCost: string;
    readonly evidenceCommitment: string;
    readonly authEpoch: string;
    readonly queueExpiry: string;
  };
  readonly createdAt: string;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UNITS_RE = /^[0-9]+$/;

function bytes32(value: unknown, field: string): string {
  if (typeof value !== "string" || !BYTES32_RE.test(value)) {
    throw httpError(400, `Invalid bytes32 for ${field}`);
  }
  return value;
}

function units(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !UNITS_RE.test(value)) {
    throw httpError(400, `Invalid units for ${field}`);
  }
  return BigInt(value);
}

function uint64(value: unknown, field: string): bigint {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !UNITS_RE.test(raw)) {
    throw httpError(400, `Invalid uint64 for ${field}`);
  }
  const parsed = BigInt(raw);
  if (parsed > 18_446_744_073_709_551_615n) throw httpError(400, `Out of uint64 range for ${field}`);
  return parsed;
}

/** Viem-signable message rebuilt from a stored/returned draft (bigints for uint fields). */
export function rulingSignableMessage(draft: Pick<
  AwardDraft,
  | "dealId"
  | "agreementDigest"
  | "arbitrationPolicyId"
  | "origin"
  | "rulingNonce"
  | "sellerAward"
  | "buyerCost"
  | "sellerCost"
  | "evidenceCommitment"
  | "authEpoch"
  | "queueExpiry"
>): {
  dealId: Hash;
  agreementDigest: Hash;
  arbitrationPolicyId: Hash;
  origin: number;
  rulingNonce: Hash;
  sellerAward: bigint;
  buyerBondCost: bigint;
  sellerBondCost: bigint;
  evidenceCommitment: Hash;
  authEpoch: bigint;
  queueExpiry: bigint;
} {
  return {
    dealId: draft.dealId as Hash,
    agreementDigest: draft.agreementDigest as Hash,
    arbitrationPolicyId: draft.arbitrationPolicyId as Hash,
    origin: draft.origin,
    rulingNonce: draft.rulingNonce as Hash,
    sellerAward: BigInt(draft.sellerAward),
    buyerBondCost: BigInt(draft.buyerCost),
    sellerBondCost: BigInt(draft.sellerCost),
    evidenceCommitment: draft.evidenceCommitment as Hash,
    authEpoch: BigInt(draft.authEpoch),
    queueExpiry: BigInt(draft.queueExpiry),
  };
}

/** Switch award drafts to durable mode and rehydrate. Wired in server.ts. */
export async function configureRegistry(adapter: RegistryAdapter | null, dealIds?: string[]): Promise<void> {
  writer.setAdapter(adapter);
  await drafts.hydrate(dealIds);
}

/** Sync test hook: attach an adapter without hydrating. */
export function __setRegistryForTests(adapter: RegistryAdapter | null): void {
  writer.setAdapter(adapter);
}

/** Await queued durable writes (tests only). */
export function __flushAwardsForTests(): Promise<void> {
  return writer.flush();
}

/**
 * Draft an award. Validates 0 <= S <= P, derives Cb/Cs exactly, previews the
 * earned fee, and returns the EIP-712 Ruling typed-data envelope plus its
 * digest. The draft is persisted under (dealId, rulingDigest) before return.
 */
export async function draftAward(input: DraftAwardInput): Promise<AwardDraft> {
  const dealId = bytes32(input.dealId, "dealId");
  const agreementDigest = bytes32(input.agreementDigest, "agreementDigest");
  const arbitrationPolicyId = bytes32(input.arbitrationPolicyId, "arbitrationPolicyId");
  const evidenceCommitment = bytes32(input.evidenceCommitment, "evidenceCommitment");
  const rulingNonce = bytes32(input.rulingNonce, "rulingNonce");
  if (input.origin !== 0 && input.origin !== 1) throw httpError(400, "origin must be 0 (primary) or 1 (fallback)");
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) throw httpError(400, "Invalid chainId");
  if (typeof input.hub !== "string" || !ADDRESS_RE.test(input.hub)) throw httpError(400, "Invalid hub");
  if (input.buyerFeeBps !== 0 && input.buyerFeeBps !== 5000 && input.buyerFeeBps !== 10000) {
    throw httpError(400, "Invalid buyerFeeBps");
  }

  const principal = units(input.principalUnits, "principalUnits");
  const quotedFee = units(input.quotedFeeUnits, "quotedFeeUnits");
  const sellerAward = units(input.sellerAwardUnits, "sellerAwardUnits");
  const claimantBond = units(input.claimantBondUnits, "claimantBondUnits");
  const respondentBond = units(input.respondentBondUnits, "respondentBondUnits");
  const authEpoch = uint64(input.authEpoch, "authEpoch");
  const queueExpiry = uint64(input.queueExpiry, "queueExpiry");
  if (principal <= 0n) throw httpError(400, "principalUnits must be positive");
  if (sellerAward < 0n || sellerAward > principal) {
    throw httpError(400, "sellerAward must satisfy 0 <= S <= P");
  }

  // P-03: arbitrators choose S only; Cb/Cs are derived, never negotiated.
  const { buyerCost, sellerCost } = partialBondCosts(principal, sellerAward, claimantBond, respondentBond);
  const { earnedFee } = normalSettlement(principal, quotedFee, sellerAward, input.buyerFeeBps);

  const domain = {
    name: "MidmanEscrow",
    version: "1",
    chainId: input.chainId,
    verifyingContract: input.hub,
  };
  const signable = {
    dealId: dealId as Hash,
    agreementDigest: agreementDigest as Hash,
    arbitrationPolicyId: arbitrationPolicyId as Hash,
    origin: input.origin,
    rulingNonce: rulingNonce as Hash,
    sellerAward,
    buyerBondCost: buyerCost,
    sellerBondCost: sellerCost,
    evidenceCommitment: evidenceCommitment as Hash,
    authEpoch,
    queueExpiry,
  };
  const rulingDigest = hashTypedData({
    domain: { ...domain, verifyingContract: input.hub as Address },
    types: RULING_TYPES,
    primaryType: "Ruling",
    message: signable,
  });

  const draft: AwardDraft = {
    dealId,
    agreementDigest,
    arbitrationPolicyId,
    origin: input.origin,
    rulingNonce,
    sellerAward: sellerAward.toString(),
    buyerCost: buyerCost.toString(),
    sellerCost: sellerCost.toString(),
    earnedFeePreview: earnedFee.toString(),
    evidenceCommitment,
    authEpoch: authEpoch.toString(),
    queueExpiry: queueExpiry.toString(),
    rulingDigest,
    domain,
    types: RULING_TYPES,
    primaryType: "Ruling",
    message: {
      dealId,
      agreementDigest,
      arbitrationPolicyId,
      origin: input.origin,
      rulingNonce,
      sellerAward: sellerAward.toString(),
      buyerBondCost: buyerCost.toString(),
      sellerBondCost: sellerCost.toString(),
      evidenceCommitment,
      authEpoch: authEpoch.toString(),
      queueExpiry: queueExpiry.toString(),
    },
    createdAt: new Date().toISOString(),
  };
  // Await the durable commit before returning, so a restart (or a second
  // instance) can still match an approval against this draft.
  await drafts.set(dealId.toLowerCase(), draft.rulingDigest.toLowerCase(), draft);
  return { ...draft, message: { ...draft.message } };
}

export function getAwardDrafts(dealId: string): AwardDraft[] {
  return drafts.list(dealId.toLowerCase()).map((draft) => ({
    ...draft,
    message: { ...draft.message },
  }));
}

export function findAwardDraft(dealId: string, rulingDigest: string): AwardDraft | null {
  const found = drafts.get(dealId.toLowerCase(), rulingDigest.toLowerCase());
  return found ? { ...found, message: { ...found.message } } : null;
}

/** Test-only reset (drops all stored drafts). */
export function __resetAwardsForTests(): void {
  drafts.clear();
  writer.setAdapter(null);
  writer.resetSequences();
}

export type HexString = Hex;
