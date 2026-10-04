// Bounded mutual-settlement proposals (Phase 9 intake, NOT consensus).
// P-04: only bilateral T07 can allocate nonzero bond costs, bounded by posted
// amounts (0 <= Cb <= Qb, 0 <= Cs <= Qs). Posted bonds come from the chain
// deal when readable; otherwise the proposer supplies explicit bond inputs and
// the proposal is flagged `unverified` (console display only — the contract
// re-validates bounds at mutualSettlement time). Stale offers die via the
// on-chain settlementNonce: any bond posting or phase change invalidates the
// nonce, so acceptance of a superseded proposal reverts on-chain. The console
// never enforces liveness; the contract does.
import { encodeFunctionData, recoverTypedDataAddress, type Address, type Hash, type Hex } from "viem";
import { HUB_ABI, TYPES as EIP712_TYPES } from "@midman/chain";
import { hydrateNamespace, RegistryWriter, type RegistryAdapter } from "@midman/store";

export const MUTUAL_TYPES = {
  MutualSettlement: EIP712_TYPES.MutualSettlement,
} as const;

export const MUTUAL_FIELD_ORDER: readonly string[] = MUTUAL_TYPES.MutualSettlement.map((field) => field.name);

export interface ProposeSettlementInput {
  readonly proposer: string;
  readonly sellerAwardUnits: string;
  readonly buyerCostUnits: string;
  readonly sellerCostUnits: string;
  readonly expectedPhase: number;
  /** Explicit fallbacks used only when the chain deal is unreadable (flagged unverified). */
  readonly principalUnits?: string;
  readonly claimantBondUnits?: string;
  readonly respondentBondUnits?: string;
  readonly agreementDigest?: string;
  readonly settlementNonce?: string;
  readonly expiresAt?: string | number;
  readonly buyer?: string;
  readonly seller?: string;
  readonly proposerSignature?: string;
  readonly chainId?: number;
  readonly hub?: string;
}

export interface SettlementProposal {
  readonly id: string;
  readonly dealId: string;
  readonly proposer: string;
  readonly buyer: string | null;
  readonly seller: string | null;
  readonly sellerAward: string;
  readonly buyerCost: string;
  readonly sellerCost: string;
  readonly expectedPhase: number;
  readonly agreementDigest: string;
  readonly settlementNonce: string;
  readonly expiresAt: string;
  readonly principal: string;
  readonly claimantBond: string;
  readonly respondentBond: string;
  /** True when bond bounds were checked against explicit inputs, not chain state. */
  readonly bondsUnverified: boolean;
  readonly proposerSignature: string | null;
  readonly chainId: number;
  readonly hub: string;
  readonly status: "open" | "accepted";
  readonly createdAt: string;
}

export interface ProposalContext {
  readonly chainDeal?: Record<string, bigint | string | boolean | number> | null;
  readonly chainId?: number | null;
  readonly hub?: Address | null;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UNITS_RE = /^[0-9]+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const ZERO_NONCE = "0x0000000000000000000000000000000000000000000000000000000000000000";

const PROPOSAL_NS = "review.proposals";
const writer = new RegistryWriter();
const proposalsById = new Map<string, SettlementProposal>();
const proposalOrder: string[] = [];
let proposalCounter = 0;

/** Switch proposals to durable mode and rehydrate. Lead wires this in server.ts. */
export async function configureRegistry(adapter: RegistryAdapter | null, dealIds?: string[]): Promise<void> {
  writer.setAdapter(adapter);
  await hydrateProposals(dealIds);
}

/** Sync test hook: attach an adapter without hydrating. */
export function __setRegistryForTests(adapter: RegistryAdapter | null): void {
  writer.setAdapter(adapter);
}

/** Await queued durable writes (tests only). */
export function __flushProposalsForTests(): Promise<void> {
  return writer.flush();
}

async function hydrateProposals(dealIds?: string[]): Promise<void> {
  const adapter = writer.getAdapter();
  if (!adapter) return;
  const loaded: SettlementProposal[] = [];
  await hydrateNamespace<SettlementProposal>(adapter, PROPOSAL_NS, dealIds, (_dealId, list) => {
    loaded.push(...list);
  });
  for (const proposal of loaded) proposalsById.set(proposal.id, proposal);
  loaded.sort((a, b) => a.id.localeCompare(b.id));
  proposalOrder.length = 0;
  proposalOrder.push(...loaded.map((proposal) => proposal.id));
  proposalCounter = loaded.reduce((max, proposal) => {
    const numeric = Number(proposal.id.replace(/^prop_/, ""));
    return Number.isFinite(numeric) && numeric > max ? numeric : max;
  }, proposalCounter);
}

function units(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !UNITS_RE.test(value)) throw httpError(400, `Invalid units for ${field}`);
  return BigInt(value);
}

function asBigintRecord(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/** Viem-signable MutualSettlement message (requires BOTH buyer and seller sigs over identical struct). */
export function mutualSignableMessage(proposal: Pick<
  SettlementProposal,
  | "dealId"
  | "agreementDigest"
  | "sellerAward"
  | "buyerCost"
  | "sellerCost"
  | "expectedPhase"
  | "settlementNonce"
  | "expiresAt"
>): {
  dealId: Hash;
  agreementDigest: Hash;
  sellerAward: bigint;
  buyerBondCost: bigint;
  sellerBondCost: bigint;
  expectedPhase: number;
  settlementNonce: Hash;
  expiresAt: bigint;
} {
  return {
    dealId: proposal.dealId as Hash,
    agreementDigest: proposal.agreementDigest as Hash,
    sellerAward: BigInt(proposal.sellerAward),
    buyerBondCost: BigInt(proposal.buyerCost),
    sellerBondCost: BigInt(proposal.sellerCost),
    expectedPhase: proposal.expectedPhase,
    settlementNonce: proposal.settlementNonce as Hash,
    expiresAt: BigInt(proposal.expiresAt),
  };
}

export function proposeSettlement(
  dealId: string,
  input: ProposeSettlementInput,
  ctx?: ProposalContext,
): SettlementProposal {
  if (!BYTES32_RE.test(dealId)) throw httpError(400, "Invalid dealId");
  if (typeof input.proposer !== "string" || !ADDRESS_RE.test(input.proposer)) {
    throw httpError(400, "Invalid proposer");
  }
  if (!Number.isInteger(input.expectedPhase) || input.expectedPhase < 0 || input.expectedPhase > 9) {
    throw httpError(400, "expectedPhase must be an integer 0-9");
  }
  const sellerAward = units(input.sellerAwardUnits, "sellerAwardUnits");
  const buyerCost = units(input.buyerCostUnits, "buyerCostUnits");
  const sellerCost = units(input.sellerCostUnits, "sellerCostUnits");

  const chainDeal = ctx?.chainDeal ?? null;
  const chainPrincipal = chainDeal ? asBigintRecord(chainDeal["principal"]) : null;
  const principal = chainPrincipal ?? (input.principalUnits !== undefined ? units(input.principalUnits, "principalUnits") : null);
  if (principal === null) throw httpError(400, "principalUnits required when the chain deal is unreadable");
  if (sellerAward < 0n || sellerAward > principal) {
    throw httpError(400, "sellerAward must satisfy 0 <= S <= P");
  }

  const chainQb = chainDeal ? asBigintRecord(chainDeal["claimantBond"]) : null;
  const chainQs = chainDeal ? asBigintRecord(chainDeal["respondentBond"]) : null;
  let claimantBond = chainQb;
  let respondentBond = chainQs;
  let bondsUnverified = false;
  if (claimantBond === null || respondentBond === null) {
    if (input.claimantBondUnits === undefined || input.respondentBondUnits === undefined) {
      throw httpError(400, "claimantBondUnits/respondentBondUnits required when the chain deal is unreadable");
    }
    claimantBond = units(input.claimantBondUnits, "claimantBondUnits");
    respondentBond = units(input.respondentBondUnits, "respondentBondUnits");
    bondsUnverified = true;
  }
  if (buyerCost < 0n || buyerCost > (claimantBond as bigint)) {
    throw httpError(400, "buyerCost exceeds the posted claimant bond");
  }
  if (sellerCost < 0n || sellerCost > (respondentBond as bigint)) {
    throw httpError(400, "sellerCost exceeds the posted respondent bond");
  }

  const chainBuyer = typeof chainDeal?.["buyer"] === "string" ? (chainDeal["buyer"] as string) : null;
  const chainSeller = typeof chainDeal?.["seller"] === "string" ? (chainDeal["seller"] as string) : null;
  const buyer = input.buyer ?? chainBuyer;
  const seller = input.seller ?? chainSeller;
  if (buyer !== null && buyer !== undefined && !ADDRESS_RE.test(buyer)) throw httpError(400, "Invalid buyer");
  if (seller !== null && seller !== undefined && !ADDRESS_RE.test(seller)) throw httpError(400, "Invalid seller");

  const agreementDigest =
    input.agreementDigest ?? (typeof chainDeal?.["termsHash"] === "string" ? (chainDeal["termsHash"] as string) : ZERO_NONCE);
  if (!BYTES32_RE.test(agreementDigest)) throw httpError(400, "Invalid agreementDigest");

  // The settlementNonce is AUTHORITATIVE chain state: it is the live counter
  // that any bond posting or phase change invalidates. It MUST be supplied by
  // the caller after reading it from the chain (never invented server-side — a
  // random nonce splits the proposal off the on-chain counter and makes the
  // countersignature uncompletable). A nonce that conflicts with the readable
  // chain deal is rejected outright.
  if (typeof input.settlementNonce !== "string" || !BYTES32_RE.test(input.settlementNonce)) {
    throw httpError(400, "settlementNonce (live on-chain) is required; random or absent nonces are rejected");
  }
  const settlementNonce = input.settlementNonce;
  const chainNonceRaw = chainDeal?.["settlementNonce"];
  const chainNonce =
    typeof chainNonceRaw === "string" && BYTES32_RE.test(chainNonceRaw) && !/^0x0+$/i.test(chainNonceRaw)
      ? chainNonceRaw
      : null;
  if (chainNonce !== null && chainNonce.toLowerCase() !== settlementNonce.toLowerCase()) {
    throw httpError(400, "settlementNonce conflicts with authoritative chain state");
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expiresRaw = input.expiresAt === undefined ? nowSeconds + 86_400 : input.expiresAt;
  const expiresStr = typeof expiresRaw === "number" ? String(expiresRaw) : expiresRaw;
  if (!UNITS_RE.test(expiresStr) || BigInt(expiresStr) <= BigInt(nowSeconds)) {
    throw httpError(400, "expiresAt must be in the future");
  }
  if (input.proposerSignature !== undefined && !HEX_RE.test(input.proposerSignature)) {
    throw httpError(400, "Invalid proposerSignature");
  }

  const chainId = input.chainId ?? ctx?.chainId ?? Number(process.env["CHAIN_ID"] ?? "8453");
  if (!Number.isInteger(chainId) || (chainId as number) <= 0) throw httpError(400, "Invalid chainId");
  const hub = input.hub ?? (ctx?.hub as string | undefined) ?? process.env["HUB_ADDRESS"] ?? "";
  if (!ADDRESS_RE.test(hub)) throw httpError(400, "hub required (chainId + hub bind the settlement signature)");

  proposalCounter += 1;
  const id = `prop_${proposalCounter.toString().padStart(4, "0")}`;
  const proposal: SettlementProposal = {
    id,
    dealId,
    proposer: input.proposer,
    buyer: (buyer as string | null) ?? null,
    seller: (seller as string | null) ?? null,
    sellerAward: sellerAward.toString(),
    buyerCost: buyerCost.toString(),
    sellerCost: sellerCost.toString(),
    expectedPhase: input.expectedPhase,
    agreementDigest,
    settlementNonce,
    expiresAt: BigInt(expiresStr).toString(),
    principal: (principal as bigint).toString(),
    claimantBond: (claimantBond as bigint).toString(),
    respondentBond: (respondentBond as bigint).toString(),
    bondsUnverified,
    proposerSignature: input.proposerSignature ?? null,
    chainId: chainId as number,
    hub,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  proposalsById.set(id, proposal);
  proposalOrder.push(id);
  void writer.put(PROPOSAL_NS, dealId.toLowerCase(), id, proposal);
  return { ...proposal };
}

export function listProposals(dealId: string): SettlementProposal[] {
  return proposalOrder
    .map((id) => proposalsById.get(id)!)
    .filter((proposal) => proposal.dealId.toLowerCase() === dealId.toLowerCase())
    .map((proposal) => ({ ...proposal }));
}

export function getProposal(id: string): SettlementProposal | null {
  const proposal = proposalsById.get(id);
  return proposal ? { ...proposal } : null;
}

/**
 * Accept a proposal: verifies the counterparty signature over the
 * MutualSettlement typed-data and returns pre-encoded mutualSettlement
 * calldata plus a relay-submission payload. Does NOT submit on-chain; the
 * caller submits via /relay/submit. Stale offers (superseded settlementNonce)
 * revert on-chain at mutualSettlement time.
 */
export async function acceptProposal(
  id: string,
  input: { counterparty: string; signature: string; proposerSignature?: string },
): Promise<{
  proposal: SettlementProposal;
  calldata: string;
  relayPayload: { idempotencyKey: string; action: string; params: Record<string, unknown> };
  note: string;
}> {
  const proposal = proposalsById.get(id);
  if (!proposal) throw httpError(404, "Unknown settlement proposal");
  if (proposal.status !== "open") throw httpError(409, "Settlement proposal is no longer open");
  if (typeof input.counterparty !== "string" || !ADDRESS_RE.test(input.counterparty)) {
    throw httpError(400, "Invalid counterparty");
  }
  if (typeof input.signature !== "string" || !HEX_RE.test(input.signature)) {
    throw httpError(400, "Invalid signature");
  }
  if (input.counterparty.toLowerCase() === proposal.proposer.toLowerCase()) {
    throw httpError(400, "Counterparty must differ from the proposer (mutual path needs both sides)");
  }

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: "MidmanEscrow",
        version: "1",
        chainId: proposal.chainId,
        verifyingContract: proposal.hub as Address,
      },
      types: MUTUAL_TYPES,
      primaryType: "MutualSettlement",
      message: mutualSignableMessage(proposal),
      signature: input.signature as Hash,
    });
  } catch {
    throw httpError(400, "Unrecoverable settlement signature");
  }
  if (recovered.toLowerCase() !== input.counterparty.toLowerCase()) {
    throw httpError(400, "Signature does not recover to the counterparty");
  }

  const proposerSignature = input.proposerSignature ?? proposal.proposerSignature ?? "0x";
  if (!HEX_RE.test(proposerSignature)) throw httpError(400, "Invalid proposerSignature");
  if (proposal.buyer === null || proposal.seller === null) {
    throw httpError(400, "Proposal parties unknown; cannot assign signature slots");
  }
  const proposerIsBuyer = proposal.proposer.toLowerCase() === proposal.buyer.toLowerCase();
  const proposerIsSeller = proposal.proposer.toLowerCase() === proposal.seller.toLowerCase();
  if (!proposerIsBuyer && !proposerIsSeller) {
    throw httpError(400, "Proposer is not a deal party");
  }
  const counterpartyIsParty =
    input.counterparty.toLowerCase() === proposal.buyer.toLowerCase() ||
    input.counterparty.toLowerCase() === proposal.seller.toLowerCase();
  if (!counterpartyIsParty) throw httpError(403, "Counterparty is not a deal party");
  const sigBuyer = (proposerIsBuyer ? proposerSignature : input.signature) as Hex;
  const sigSeller = (proposerIsSeller ? proposerSignature : input.signature) as Hex;

  const calldata = encodeFunctionData({
    abi: HUB_ABI,
    functionName: "mutualSettlement",
    args: [
      proposal.dealId as Hex,
      BigInt(proposal.sellerAward),
      BigInt(proposal.buyerCost),
      BigInt(proposal.sellerCost),
      proposal.expectedPhase,
      proposal.settlementNonce as Hex,
      BigInt(proposal.expiresAt),
      sigBuyer,
      sigSeller,
    ],
  });
  const relayPayload = {
    idempotencyKey: `mutual-${proposal.id}`,
    action: "mutualSettlement",
    params: {
      dealId: proposal.dealId,
      sellerAward: proposal.sellerAward,
      buyerCost: proposal.buyerCost,
      sellerCost: proposal.sellerCost,
      expectedPhase: proposal.expectedPhase,
      settlementNonce: proposal.settlementNonce,
      expiresAt: proposal.expiresAt,
      sigBuyer,
      sigSeller,
      calldata,
    },
  };
  const accepted: SettlementProposal = { ...proposal, status: "accepted" };
  proposalsById.set(id, accepted);
  await writer.put(PROPOSAL_NS, proposal.dealId.toLowerCase(), id, accepted);
  return {
    proposal: { ...accepted },
    calldata,
    relayPayload,
    note: "Stale offers die via the on-chain settlementNonce: any bond posting or phase change invalidates this nonce and mutualSettlement reverts. This payload was NOT submitted; submit via POST /relay/submit.",
  };
}

/** Test-only reset (drops all proposals and the id counter). */
export function __resetProposalsForTests(): void {
  proposalsById.clear();
  proposalOrder.length = 0;
  proposalCounter = 0;
  writer.setAdapter(null);
}
