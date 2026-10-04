// Reviewer quorum approvals (Phase 9 console intake, NOT consensus).
// Each approval is verified via viem recoverTypedDataAddress against the
// stored draft payload (the signature must match an existing draft award).
// The signer must be a NON-RECUSED panel member of the ruling's house:
// chain panel membership (reader.isPanelMember at the deal's epoch) wins when
// a policies registry is reachable, otherwise the console roster
// (assignReviewers) is authoritative for drills. Recused signers are rejected
// and prior signatures from newly recused signers count as ABSENT.
// Quorum need: on-chain primaryQuorum/fallbackQuorum wins; otherwise the P-05
// tier table (T1 2-of-3; T2/T3 3-of-5) derived from principal, else 2.
import { recoverTypedDataAddress, type Address, type Hash } from "viem";
import type { ChainReader } from "@midman/chain";
import { DurableCollection, RegistryWriter, type RegistryAdapter } from "@midman/store";
import { findAwardDraft, RULING_TYPES, rulingSignableMessage } from "./awards.js";
import { isReviewer } from "../evidence/access.js";
import { reviewRegistry } from "./registry.js";

export interface ApprovalInput {
  readonly signer: string;
  readonly signature: string;
  readonly rulingDigest: string;
  readonly epoch: string | number;
  readonly origin: number;
}

export interface ApprovalProgress {
  readonly rulingDigest: string;
  readonly origin: number;
  readonly have: number;
  readonly need: number;
  readonly signers: string[];
  readonly complete: boolean;
}

export interface ApprovalContext {
  readonly reader?: ChainReader | null;
  /** Policies-registry contract for isPanelMember; defaults to POLICIES_ADDRESS env. */
  readonly policies?: Address | null;
  /** Chain deal record (getDeal) for quorum derivation; null when unreadable. */
  readonly chainDeal?: Record<string, bigint | string | boolean | number> | null;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const UNITS_RE = /^[0-9]+$/;

/** Quorum need for a ruling house: chain quorums win, else the P-05 tier table. */
export function quorumNeed(
  chainDeal: Record<string, bigint | string | boolean | number> | null | undefined,
  origin: number,
): number {
  const key = origin === 1 ? "fallbackQuorum" : "primaryQuorum";
  const onChain = chainDeal?.[key];
  if (typeof onChain === "number" && Number.isInteger(onChain) && onChain > 0) return onChain;
  if (typeof onChain === "bigint" && onChain > 0n) return Number(onChain);
  const principalRaw = chainDeal?.["principal"];
  const principal =
    typeof principalRaw === "bigint" ? principalRaw : typeof principalRaw === "number" ? BigInt(principalRaw) : null;
  if (principal !== null) {
    // P-05 principal tiers (6-decimal USDC units): T1 5–1,000 USDC -> 2;
    // T2 >1,000–10,000 and T3 >10,000 USDC -> 3.
    if (principal > 1_000_000_000n) return 3;
    return 2;
  }
  const tierRaw = chainDeal?.["tier"];
  const tier = typeof tierRaw === "bigint" ? Number(tierRaw) : typeof tierRaw === "number" ? tierRaw : 0;
  if (tier >= 2) return 3;
  return 2;
}

interface ApprovalSlot {
  readonly digest: string;
  origin: number;
  epoch: string;
  need: number;
  signers: string[];
  signatures: string[];
}

const APPROVAL_NS = "review.approvals";
const writer = new RegistryWriter();
const approvalSlots = new DurableCollection<ApprovalSlot>(APPROVAL_NS, writer, (slot) => slot.digest);

/**
 * Switch approvals to durable mode and rehydrate. The lead wires this in
 * server.ts: `await configureRegistry(adapter)`.
 */
export async function configureRegistry(adapter: RegistryAdapter | null, dealIds?: string[]): Promise<void> {
  writer.setAdapter(adapter);
  await approvalSlots.hydrate(dealIds);
}

/** Sync test hook: attach an adapter without hydrating. */
export function __setRegistryForTests(adapter: RegistryAdapter | null): void {
  writer.setAdapter(adapter);
}

/** Await queued durable writes (tests only). */
export function __flushApprovalsForTests(): Promise<void> {
  return writer.flush();
}

function progressFor(dealId: string, rulingDigest: string, slot: ApprovalSlot): ApprovalProgress {
  // Recused signers count as ABSENT for console quorum math.
  const active = slot.signers.filter((signer) => !reviewRegistry.isRecused(dealId, signer));
  return {
    rulingDigest,
    origin: slot.origin,
    have: active.length,
    need: slot.need,
    signers: [...active],
    complete: active.length >= slot.need,
  };
}

/**
 * Record one quorum approval. Verifies the EIP-712 Ruling signature against
 * the stored draft, enforces non-recused house membership, dedupes signers.
 */
export async function recordApproval(
  dealId: string,
  input: ApprovalInput,
  ctx?: ApprovalContext,
): Promise<ApprovalProgress> {
  if (!BYTES32_RE.test(dealId)) throw httpError(400, "Invalid dealId");
  if (typeof input.signer !== "string" || !ADDRESS_RE.test(input.signer)) {
    throw httpError(400, "Invalid signer");
  }
  if (typeof input.signature !== "string" || !HEX_RE.test(input.signature)) {
    throw httpError(400, "Invalid signature");
  }
  if (typeof input.rulingDigest !== "string" || !BYTES32_RE.test(input.rulingDigest)) {
    throw httpError(400, "Invalid rulingDigest");
  }
  if (input.origin !== 0 && input.origin !== 1) throw httpError(400, "origin must be 0 (primary) or 1 (fallback)");
  const epochRaw = typeof input.epoch === "number" ? String(input.epoch) : input.epoch;
  if (typeof epochRaw !== "string" || !UNITS_RE.test(epochRaw)) throw httpError(400, "Invalid epoch");

  const draft = findAwardDraft(dealId, input.rulingDigest);
  if (!draft) throw httpError(404, "No matching draft award for rulingDigest");
  if (draft.origin !== input.origin) throw httpError(400, "origin does not match the draft award");
  if (draft.authEpoch !== BigInt(epochRaw).toString()) {
    throw httpError(400, "epoch does not match the draft authEpoch");
  }

  // Signature must recover to the claimed signer over the stored draft payload.
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: draft.domain.name,
        version: draft.domain.version,
        chainId: draft.domain.chainId,
        verifyingContract: draft.domain.verifyingContract as Address,
      },
      types: RULING_TYPES,
      primaryType: "Ruling",
      message: rulingSignableMessage(draft),
      signature: input.signature as Hash,
    });
  } catch {
    throw httpError(400, "Unrecoverable ruling signature");
  }
  if (recovered.toLowerCase() !== input.signer.toLowerCase()) {
    throw httpError(400, "Signature does not recover to the claimed signer");
  }

  const house = input.origin === 1 ? "fallback" : "primary";
  if (reviewRegistry.isRecused(dealId, input.signer)) {
    throw httpError(403, "Recused reviewers cannot approve");
  }
  const reader = ctx?.reader ?? null;
  const envPolicies = process.env["POLICIES_ADDRESS"] ?? "";
  const policies =
    ctx?.policies ?? (/^0x[0-9a-fA-F]{40}$/.test(envPolicies) ? (envPolicies as Address) : null);
  const withPanel = reader as unknown as {
    isPanelMember?: (
      policies: Address,
      epoch: bigint,
      house: "primary" | "fallback",
      wallet: Address,
    ) => Promise<boolean>;
  } | null;
  if (reader && policies && withPanel && typeof withPanel.isPanelMember === "function") {
    let member = false;
    try {
      member = await withPanel.isPanelMember(policies, BigInt(epochRaw), house, input.signer as Address);
    } catch {
      member = false;
    }
    if (!member) throw httpError(403, "Signer is not a panel member for this epoch");
  } else {
    const roster = reviewRegistry.getCase(dealId);
    if (roster) {
      const houseRoster = house === "primary" ? roster.primary : roster.fallback;
      const member = houseRoster.some((entry) => entry.toLowerCase() === input.signer.toLowerCase());
      if (!member) throw httpError(403, "Signer is not an assigned panel member");
    } else if (!isReviewer(input.signer)) {
      throw httpError(403, "Signer is not an assigned panel member");
    }
  }

  const dealKey = dealId.toLowerCase();
  const digestKey = input.rulingDigest.toLowerCase();
  let slot = approvalSlots.get(dealKey, digestKey);
  if (!slot) {
    slot = {
      digest: digestKey,
      origin: input.origin,
      epoch: BigInt(epochRaw).toString(),
      need: quorumNeed(ctx?.chainDeal ?? null, input.origin),
      signers: [],
      signatures: [],
    };
  }
  if (slot.signers.some((entry) => entry.toLowerCase() === input.signer.toLowerCase())) {
    throw httpError(409, "Duplicate approval from this signer");
  }
  slot.signers.push(input.signer as Address);
  slot.signatures.push(input.signature);
  await approvalSlots.set(dealKey, digestKey, slot);
  return progressFor(dealId, input.rulingDigest, slot);
}

export function getApprovalProgress(dealId: string, rulingDigest: string): ApprovalProgress | null {
  const slot = approvalSlots.get(dealId.toLowerCase(), rulingDigest.toLowerCase());
  if (!slot) return null;
  return progressFor(dealId, rulingDigest, slot);
}

export function listApprovalProgress(dealId: string): ApprovalProgress[] {
  return approvalSlots
    .list(dealId.toLowerCase())
    .map((slot) => progressFor(dealId, slot.digest, slot));
}

export function getApprovalSignatures(dealId: string, rulingDigest: string): string[] {
  const slot = approvalSlots.get(dealId.toLowerCase(), rulingDigest.toLowerCase());
  if (!slot) return [];
  const recused = new Set(
    slot.signers.filter((signer) => reviewRegistry.isRecused(dealId, signer)).map((s) => s.toLowerCase()),
  );
  return slot.signatures.filter((_, i) => !recused.has(slot.signers[i]!.toLowerCase()));
}

/** True when any (or the given) ruling digest has reached quorum with active signers. */
export function quorumComplete(dealId: string, rulingDigest?: string): boolean {
  const list = approvalSlots.list(dealId.toLowerCase());
  if (list.length === 0) return false;
  if (rulingDigest) {
    const slot = approvalSlots.get(dealId.toLowerCase(), rulingDigest.toLowerCase());
    return slot ? progressFor(dealId, rulingDigest, slot).complete : false;
  }
  for (const slot of list) {
    if (progressFor(dealId, slot.digest, slot).complete) return true;
  }
  return false;
}

/** Test-only reset (drops all recorded approvals). */
export function __resetApprovalsForTests(): void {
  approvalSlots.clear();
  writer.setAdapter(null);
}
