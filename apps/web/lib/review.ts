// Reviewer console API wrappers + pure quorum / award-preview / typed-data helpers (Midman V1).
//
// Auth: same signed-request scheme as the evidence routes (lib/requestAuth.ts):
//   x-wallet-address, x-wallet-expiry, x-wallet-signature = EIP-191 personal_sign of
//   `${METHOD}\n${path}\n${sha256hex(bodyBytes)}\n${expiry}`
// (GETs sign the empty body). Every wrapper throws ApiError carrying the HTTP
// status so UI can tolerate a not-yet-deployed review backend: 404/501/503
// render "review backend pending" copy, 403 renders reviewer-allowlist copy.
//
// Reviewer signing UX (important): ALL signatures are produced client-side in
// the reviewer's own browser wallet (viem signTypedData / personal_sign). The
// server only ever receives signature bytes — it never sees private keys.
//
// Only erasable TypeScript is used so Node 24 can import this file directly
// in tests (no enums, namespaces, or parameter properties).

import { API_BASE, ApiError } from "./api.ts";
import { signRequest } from "./requestAuth.ts";
import type { RequestSigner } from "./requestAuth.ts";
import { countdownTo } from "./money.ts";
import {
  normalSettlement,
  partialBondCosts,
  SELF_RESOLUTION_SECONDS,
  ESCALATION_WINDOW_SECONDS,
  RESPONDENT_EVIDENCE_SECONDS,
  PRIMARY_REVIEW_SECONDS,
  FALLBACK_REVIEW_SECONDS,
  CATASTROPHIC_ESCAPE_SECONDS,
} from "@midman/shared";

export { countdownTo };

// ---- Endpoint-missing / access-denied helpers + shared copy ----

/** The review backend is not deployed (or moved): UI should fall back, not crash. */
export function isReviewMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501 || error.status === 503);
}

/** 403 on signed routes: not a party, or reviewer allowlist has not cleared you. */
export function isReviewerDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export const REVIEW_MISSING_COPY =
  "Review backend unavailable (404/503). The review API is not deployed yet — your drafts, signatures, " +
  "and on-chain state are unaffected. Retry later; nothing was submitted.";

export const REVIEWER_DENIED_COPY =
  "Access denied (403). If you are a reviewer, your reviewer access is still pending allowlist approval. " +
  "Queue and case contents are only visible to assigned reviewers and deal parties.";

export const REVIEWER_SIGNING_COPY =
  "You sign with your own browser wallet (client-side EIP-712). The server only receives signature bytes — " +
  "it never sees your private keys. Nothing moves on-chain until a quorum-signed ruling is queued via relay or direct send.";

export const VETO_CANCEL_ONLY_COPY =
  "Veto is cancel-only: it cancels the queued ruling and returns the deal to fallback review (or deadlock). " +
  "A veto never sets an award, never names a recipient, and never moves funds.";

export const FALLBACK_PANEL_COPY =
  "Fallback panel is an independent roster: fallback reviewers re-examine the same evidence commitment from scratch. " +
  "Primary signatures do not count toward the fallback quorum and vice versa.";

// ---- Queue + case types (exactly per contract) ----

export type ReviewPanel = "primary" | "fallback";

export interface ReviewQueueItem {
  readonly dealId: string;
  readonly phase: string;
  readonly stage: string;
  readonly deadlineUnix: number;
  readonly panel: ReviewPanel;
  /** True when the connected reviewer is assigned; servers may also send an address list. */
  readonly assigned: boolean;
  readonly assignees?: readonly string[] | undefined;
}

export interface EvidenceManifestRef {
  readonly seq: number;
  readonly fileHash: string;
  readonly prevHash: string;
  readonly kind: string;
  readonly uploader: string;
  readonly uploadedAt: string;
}

export interface AwardRecord {
  readonly id: string;
  readonly sellerAwardUnits: string;
  readonly buyerCostUnits: string;
  readonly sellerCostUnits: string;
  readonly evidenceCommitment: string;
  readonly rulingNonce: string;
  readonly authEpoch: string | number;
  readonly queueExpiry: string | number;
}

export interface ApprovalSignerEntry {
  readonly signer: string;
  readonly signature: string;
}

export interface RecusalEntry {
  readonly reviewer: string;
  readonly reason: string;
}

export interface ReviewCaseBundle {
  /** Chain fields, all as exact strings. */
  readonly deal: Record<string, string>;
  readonly evidence: { readonly manifest: readonly EvidenceManifestRef[]; readonly head: string };
  /** Opaque delivery form payload — rendered read-only by the workspace. */
  readonly deliveryForm: unknown;
  readonly recusals: readonly RecusalEntry[];
  readonly awards: readonly AwardRecord[];
  readonly approvals: { readonly need: number; readonly signers: readonly ApprovalSignerEntry[] };
  readonly quorum: { readonly primary: number; readonly fallback: number; readonly tier: number };
}

export interface TypedDataEnvelope {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, unknown>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

export interface AwardDraftResult {
  readonly award: AwardRecord;
  readonly typedData: TypedDataEnvelope;
  readonly rulingNonce: string;
}

export interface ApprovalResult {
  readonly have: number;
  readonly need: number;
  readonly complete: boolean;
}

export interface RelayPayload {
  readonly idempotencyKey?: string | undefined;
  readonly key?: string | undefined;
  readonly action: string;
  readonly params: Record<string, unknown>;
}

export interface QueueRulingResult {
  readonly calldata: string;
  readonly relayPayload: RelayPayload;
}

export interface VetoSigInput {
  readonly authority: string;
  readonly nonce: string;
  readonly expiry: string | number;
  readonly signature: string;
}

export interface SettlementProposal {
  readonly id: string;
  readonly dealId: string;
  readonly sellerAwardUnits: string;
  readonly buyerCostUnits: string;
  readonly sellerCostUnits: string;
  readonly expectedPhase: number;
  readonly proposer?: string | undefined;
  readonly settlementNonce?: string | undefined;
  readonly expiresAt?: string | number | undefined;
  readonly typedData?: TypedDataEnvelope | undefined;
  readonly status?: string | undefined;
}

export interface EscalationInfo {
  readonly claimantBondUnits: string;
  readonly respondentBondUnits: string;
  readonly estimated: boolean;
  readonly negotiationEndUnix: number;
  readonly escalationEndUnix: number;
}

/**
 * Defensive shape guard for the case bundle: the API worker owns the route,
 * so the workspace refuses to render totals from an unrecognized payload
 * instead of misreading it.
 */
export function isReviewCaseBundle(value: unknown): value is ReviewCaseBundle {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const approvals = r["approvals"] as Record<string, unknown> | undefined;
  const quorum = r["quorum"] as Record<string, unknown> | undefined;
  const evidence = r["evidence"] as Record<string, unknown> | undefined;
  return (
    r["deal"] !== null &&
    typeof r["deal"] === "object" &&
    Array.isArray((evidence ?? {})["manifest"]) &&
    typeof (evidence ?? {})["head"] === "string" &&
    Array.isArray(approvals?.["signers"]) &&
    (typeof approvals?.["need"] === "number" || typeof approvals?.["need"] === "string") &&
    Array.isArray(r["awards"]) &&
    Array.isArray(r["recusals"]) &&
    typeof quorum?.["primary"] === "number" &&
    typeof quorum?.["fallback"] === "number"
  );
}

// ---- Signed fetch core (mirrors lib/evidence.ts semantics) ----

function extractMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // keep raw text
  }
  return text;
}

async function signedJson<T>(args: {
  readonly auth: RequestSigner;
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<T> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const raw = args.body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(args.body));
  const signed = await signRequest(args.auth, args.method, args.path, raw);
  const headers: Record<string, string> = { ...signed.headers };
  const init: RequestInit = { method: args.method.toUpperCase(), headers };
  if (raw !== undefined) {
    headers["content-type"] = "application/json";
    init.body = raw as BodyInit;
  }
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${args.path}`, init);
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, extractMessage(text));
  return (text ? JSON.parse(text) : {}) as T;
}

function normalizeList<T>(payload: unknown, keys: readonly string[]): readonly T[] {
  if (Array.isArray(payload)) return payload as readonly T[];
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      const inner = (payload as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner as readonly T[];
    }
  }
  return [];
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return fallback;
}

function normalizeQueueItem(raw: unknown): ReviewQueueItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const panel = r["panel"] === "fallback" ? "fallback" : "primary";
  const assignedRaw = r["assigned"];
  const assignees = Array.isArray(r["assignees"])
    ? (r["assignees"] as unknown[]).map(String)
    : Array.isArray(assignedRaw)
      ? (assignedRaw as unknown[]).map(String)
      : undefined;
  return {
    dealId: String(r["dealId"] ?? ""),
    phase: String(r["phase"] ?? ""),
    stage: String(r["stage"] ?? ""),
    deadlineUnix: toNumber(r["deadlineUnix"], 0),
    panel,
    assigned: assignedRaw === true,
    assignees,
  };
}

/** True when `address` is assigned to this queue item (flag or roster list). */
export function isAssignedToMe(item: ReviewQueueItem, address: string | null | undefined): boolean {
  if (!address) return false;
  if (item.assigned) return true;
  const me = address.toLowerCase();
  return (item.assignees ?? []).some((a) => a.toLowerCase() === me);
}

// ---- Endpoint wrappers (exactly per contract) ----

/** GET /review/queue — signed. Tolerate 404/503 via isReviewMissing. */
export async function fetchReviewQueue(
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<readonly ReviewQueueItem[]> {
  const payload = await signedJson<readonly unknown[] | { queue: readonly unknown[] }>({
    auth,
    method: "GET",
    path: "/review/queue",
    fetchImpl,
  });
  return normalizeList<unknown>(payload, ["queue"]).map(normalizeQueueItem);
}

/** GET /review/cases/:dealId — signed. */
export function fetchReviewCase(
  dealId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<ReviewCaseBundle> {
  return signedJson<ReviewCaseBundle>({
    auth,
    method: "GET",
    path: `/review/cases/${encodeURIComponent(dealId)}`,
    fetchImpl,
  });
}

/** POST /review/cases/:dealId/assign {primary[], fallback[]} — signed. */
export function postAssignReviewers(
  dealId: string,
  rosters: { readonly primary: readonly string[]; readonly fallback: readonly string[] },
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean }> {
  return signedJson<{ ok: boolean }>({
    auth,
    method: "POST",
    path: `/review/cases/${encodeURIComponent(dealId)}/assign`,
    body: { primary: [...rosters.primary], fallback: [...rosters.fallback] },
    fetchImpl,
  });
}

/** POST /review/cases/:dealId/recuse {reviewer, reason} — signed. */
export function postRecusal(
  dealId: string,
  input: { readonly reviewer: string; readonly reason: string },
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean }> {
  return signedJson<{ ok: boolean }>({
    auth,
    method: "POST",
    path: `/review/cases/${encodeURIComponent(dealId)}/recuse`,
    body: { reviewer: input.reviewer, reason: input.reason },
    fetchImpl,
  });
}

/** POST /review/cases/:dealId/awards/draft {sellerAwardUnits, evidenceCommitment} — signed. */
export function postAwardDraft(
  dealId: string,
  input: { readonly sellerAwardUnits: string; readonly evidenceCommitment: string },
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<AwardDraftResult> {
  return signedJson<AwardDraftResult>({
    auth,
    method: "POST",
    path: `/review/cases/${encodeURIComponent(dealId)}/awards/draft`,
    body: { sellerAwardUnits: input.sellerAwardUnits, evidenceCommitment: input.evidenceCommitment },
    fetchImpl,
  });
}

/** POST /review/cases/:dealId/approvals {signer, signature, rulingDigest} — signed. */
export function postApproval(
  dealId: string,
  input: { readonly signer: string; readonly signature: string; readonly rulingDigest: string },
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<ApprovalResult> {
  return signedJson<ApprovalResult>({
    auth,
    method: "POST",
    path: `/review/cases/${encodeURIComponent(dealId)}/approvals`,
    body: { signer: input.signer, signature: input.signature, rulingDigest: input.rulingDigest },
    fetchImpl,
  });
}

/** POST /review/cases/:dealId/queue-ruling {awardId} — signed. */
export function postQueueRuling(
  dealId: string,
  awardId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<QueueRulingResult> {
  return signedJson<QueueRulingResult>({
    auth,
    method: "POST",
    path: `/review/cases/${encodeURIComponent(dealId)}/queue-ruling`,
    body: { awardId },
    fetchImpl,
  });
}

/** POST /review/cases/:dealId/veto {rulingDigest, vsigs[]} — signed. */
export function postVeto(
  dealId: string,
  input: { readonly rulingDigest: string; readonly vsigs: readonly VetoSigInput[] },
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<QueueRulingResult> {
  return signedJson<QueueRulingResult>({
    auth,
    method: "POST",
    path: `/review/cases/${encodeURIComponent(dealId)}/veto`,
    body: {
      rulingDigest: input.rulingDigest,
      vsigs: input.vsigs.map((v) => ({
        authority: v.authority,
        nonce: v.nonce,
        expiry: v.expiry,
        signature: v.signature,
      })),
    },
    fetchImpl,
  });
}

/** Idempotency/relay key carried by a queue-ruling or veto relay payload. */
export function relayKeyOf(payload: RelayPayload): string {
  if (typeof payload.idempotencyKey === "string" && payload.idempotencyKey !== "") return payload.idempotencyKey;
  if (typeof payload.key === "string" && payload.key !== "") return payload.key;
  return `review-${Date.now()}`;
}

// ---- Settlement proposals (signed; contract: mutualSettlement calldata) ----

/** POST /deals/:dealId/settlement-proposals {sellerAwardUnits, buyerCostUnits, sellerCostUnits, expectedPhase}. */
export function proposeSettlement(
  dealId: string,
  input: {
    readonly sellerAwardUnits: string;
    readonly buyerCostUnits: string;
    readonly sellerCostUnits: string;
    readonly expectedPhase: number;
  },
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<SettlementProposal> {
  return signedJson<SettlementProposal>({
    auth,
    method: "POST",
    path: `/deals/${encodeURIComponent(dealId)}/settlement-proposals`,
    body: {
      sellerAwardUnits: input.sellerAwardUnits,
      buyerCostUnits: input.buyerCostUnits,
      sellerCostUnits: input.sellerCostUnits,
      expectedPhase: input.expectedPhase,
    },
    fetchImpl,
  });
}

/** GET /deals/:dealId/settlement-proposals — signed list (bare array or {proposals}). */
export async function listSettlementProposals(
  dealId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<readonly SettlementProposal[]> {
  const payload = await signedJson<readonly SettlementProposal[] | { proposals: readonly SettlementProposal[] }>({
    auth,
    method: "GET",
    path: `/deals/${encodeURIComponent(dealId)}/settlement-proposals`,
    fetchImpl,
  });
  return normalizeList<SettlementProposal>(payload, ["proposals"]);
}

/** POST /settlement-proposals/:id/accept {signature} — signed countersignature. */
export function acceptSettlementProposal(
  proposalId: string,
  signature: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<QueueRulingResult> {
  return signedJson<QueueRulingResult>({
    auth,
    method: "POST",
    path: `/settlement-proposals/${encodeURIComponent(proposalId)}/accept`,
    body: { signature },
    fetchImpl,
  });
}

// ---- Escalation info (auth optional: signed when a wallet is connected) ----

/**
 * GET /deals/:dealId/escalation -> {claimantBondUnits, respondentBondUnits,
 * estimated, negotiationEndUnix, escalationEndUnix}. Unsigned fallback is used
 * when no wallet is connected (DisputeProgress); signed when provided.
 */
export async function fetchEscalation(
  dealId: string,
  auth?: RequestSigner | undefined,
  fetchImpl?: typeof fetch,
): Promise<EscalationInfo> {
  const path = `/deals/${encodeURIComponent(dealId)}/escalation`;
  const impl = fetchImpl ?? fetch;
  if (auth) {
    const payload = await signedJson<Record<string, unknown>>({ auth, method: "GET", path, fetchImpl: impl });
    return normalizeEscalation(payload);
  }
  let res: Response;
  try {
    res = await impl(`${API_BASE}${path}`, { method: "GET" });
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, extractMessage(text));
  return normalizeEscalation((text ? JSON.parse(text) : {}) as Record<string, unknown>);
}

function normalizeEscalation(raw: Record<string, unknown>): EscalationInfo {
  return {
    claimantBondUnits: String(raw["claimantBondUnits"] ?? raw["claimantBond"] ?? "0"),
    respondentBondUnits: String(raw["respondentBondUnits"] ?? raw["respondentBond"] ?? "0"),
    estimated: raw["estimated"] === true,
    negotiationEndUnix: toNumber(raw["negotiationEndUnix"], 0),
    escalationEndUnix: toNumber(raw["escalationEndUnix"], 0),
  };
}

// ---- Client-side quorum math (distinct non-recused signers vs need) ----

export interface QuorumProgress {
  /** Distinct eligible signers counted. */
  readonly have: number;
  readonly need: number;
  readonly complete: boolean;
  /** Lowercased eligible signer addresses. */
  readonly distinct: readonly string[];
  /** Signatures discarded because the signer recused. */
  readonly excludedRecused: number;
  /** Signatures discarded as duplicates (same signer twice). */
  readonly excludedDuplicates: number;
}

/**
 * Count distinct, non-recused signers against the quorum need.
 * Comparison is case-insensitive (checksummed vs lowercase addresses).
 */
export function quorumProgress(
  signers: readonly string[],
  recusals: readonly string[],
  need: number,
): QuorumProgress {
  const recused = new Set(recusals.map((r) => r.toLowerCase()));
  const seen = new Set<string>();
  const distinct: string[] = [];
  let excludedRecused = 0;
  let excludedDuplicates = 0;
  for (const signer of signers) {
    const lower = signer.toLowerCase();
    if (recused.has(lower)) {
      excludedRecused += 1;
      continue;
    }
    if (seen.has(lower)) {
      excludedDuplicates += 1;
      continue;
    }
    seen.add(lower);
    distinct.push(lower);
  }
  const target = Number.isInteger(need) && need > 0 ? need : 0;
  return {
    have: distinct.length,
    need: target,
    complete: distinct.length >= target,
    distinct,
    excludedRecused,
    excludedDuplicates,
  };
}

// ---- Award preview (exact strings via @midman/shared) ----

export type FeeAllocation = 0 | 5000 | 10000;

export interface AwardPreviewInput {
  readonly principalUnits: string;
  readonly quotedFeeUnits: string;
  readonly buyerFeeBps: FeeAllocation;
  readonly sellerAwardUnits: string;
  readonly claimantBondUnits?: string | undefined;
  readonly respondentBondUnits?: string | undefined;
}

export interface AwardPreview {
  readonly sellerAwardUnits: string;
  readonly earnedFeeUnits: string;
  readonly buyerFeeUnits: string;
  readonly sellerFeeUnits: string;
  readonly buyerClaimUnits: string;
  readonly sellerClaimUnits: string;
  readonly prepaidBuyerFeeUnits: string;
  readonly fundedUnits: string;
  readonly buyerCostUnits: string;
  readonly sellerCostUnits: string;
}

/**
 * Exact-unit award preview: L-NORMAL settlement split plus P-03 partial bond
 * costs. Throws RangeError when S is out of [0, P] (bounded award input).
 */
export function previewAward(input: AwardPreviewInput): AwardPreview {
  const principal = BigInt(input.principalUnits);
  const quotedFee = BigInt(input.quotedFeeUnits);
  const award = BigInt(input.sellerAwardUnits);
  const settled = normalSettlement(principal, quotedFee, award, input.buyerFeeBps);
  const costs = partialBondCosts(
    principal,
    award,
    BigInt(input.claimantBondUnits ?? "0"),
    BigInt(input.respondentBondUnits ?? "0"),
  );
  return {
    sellerAwardUnits: award.toString(),
    earnedFeeUnits: settled.earnedFee.toString(),
    buyerFeeUnits: settled.buyerFee.toString(),
    sellerFeeUnits: settled.sellerFee.toString(),
    buyerClaimUnits: settled.buyerClaim.toString(),
    sellerClaimUnits: settled.sellerClaim.toString(),
    prepaidBuyerFeeUnits: settled.prepaidBuyerFee.toString(),
    fundedUnits: settled.funded.toString(),
    buyerCostUnits: costs.buyerCost.toString(),
    sellerCostUnits: costs.sellerCost.toString(),
  };
}

// ---- EIP-712 typed-data builders (field order matches the contract) ----

// Ruling(...): [dealId, agreementDigest, arbitrationPolicyId, origin,
//   rulingNonce, sellerAward, buyerBondCost, sellerBondCost,
//   evidenceCommitment, authEpoch, queueExpiry]
export const RULING_FIELD_ORDER: readonly string[] = [
  "dealId",
  "agreementDigest",
  "arbitrationPolicyId",
  "origin",
  "rulingNonce",
  "sellerAward",
  "buyerBondCost",
  "sellerBondCost",
  "evidenceCommitment",
  "authEpoch",
  "queueExpiry",
];

// VetoRuling(...): [dealId, rulingDigest, authority, nonce, expiresAt]
// (no award/recipient — veto is cancel-only).
export const VETO_FIELD_ORDER: readonly string[] = ["dealId", "rulingDigest", "authority", "nonce", "expiresAt"];

// MutualSettlement(...): [dealId, agreementDigest, sellerAward, buyerBondCost,
//   sellerBondCost, expectedPhase, settlementNonce, expiresAt]
export const MUTUAL_SETTLEMENT_FIELD_ORDER: readonly string[] = [
  "dealId",
  "agreementDigest",
  "sellerAward",
  "buyerBondCost",
  "sellerBondCost",
  "expectedPhase",
  "settlementNonce",
  "expiresAt",
];

export function rulingEIP712Types(): Record<string, readonly { name: string; type: string }[]> {
  return {
    Ruling: [
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
    ],
  };
}

export function vetoEIP712Types(): Record<string, readonly { name: string; type: string }[]> {
  return {
    VetoRuling: [
      { name: "dealId", type: "bytes32" },
      { name: "rulingDigest", type: "bytes32" },
      { name: "authority", type: "address" },
      { name: "nonce", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
    ],
  };
}

export function mutualSettlementEIP712Types(): Record<string, readonly { name: string; type: string }[]> {
  return {
    MutualSettlement: [
      { name: "dealId", type: "bytes32" },
      { name: "agreementDigest", type: "bytes32" },
      { name: "sellerAward", type: "uint256" },
      { name: "buyerBondCost", type: "uint256" },
      { name: "sellerBondCost", type: "uint256" },
      { name: "expectedPhase", type: "uint8" },
      { name: "settlementNonce", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
    ],
  };
}

export interface RulingTypedDataInput {
  readonly chainId: number;
  readonly hub: string;
  readonly dealId: string;
  readonly agreementDigest: string;
  readonly arbitrationPolicyId: string;
  readonly origin: number;
  readonly rulingNonce: string;
  readonly sellerAwardUnits: string;
  readonly buyerCostUnits: string;
  readonly sellerCostUnits: string;
  readonly evidenceCommitment: string;
  readonly authEpoch: string | number;
  readonly queueExpiry: string | number;
}

/** Build the exact Ruling typed-data envelope (message keys in contract order). */
export function buildRulingTypedData(input: RulingTypedDataInput): TypedDataEnvelope {
  const message: Record<string, unknown> = {
    dealId: input.dealId,
    agreementDigest: input.agreementDigest,
    arbitrationPolicyId: input.arbitrationPolicyId,
    origin: input.origin,
    rulingNonce: input.rulingNonce,
    sellerAward: BigInt(input.sellerAwardUnits),
    buyerBondCost: BigInt(input.buyerCostUnits),
    sellerBondCost: BigInt(input.sellerCostUnits),
    evidenceCommitment: input.evidenceCommitment,
    authEpoch: BigInt(input.authEpoch),
    queueExpiry: BigInt(input.queueExpiry),
  };
  return {
    domain: { name: "MidmanEscrow", version: "1", chainId: input.chainId, verifyingContract: input.hub },
    types: rulingEIP712Types(),
    primaryType: "Ruling",
    message,
  };
}

export interface VetoTypedDataInput {
  readonly chainId: number;
  readonly hub: string;
  readonly dealId: string;
  readonly rulingDigest: string;
  readonly authority: string;
  readonly nonce: string;
  readonly expiresAt: string | number | bigint;
}

/** Build the exact VetoRuling typed-data envelope (cancel-only: no award/recipient). */
export function buildVetoTypedData(input: VetoTypedDataInput): TypedDataEnvelope {
  const message: Record<string, unknown> = {
    dealId: input.dealId,
    rulingDigest: input.rulingDigest,
    authority: input.authority,
    nonce: input.nonce,
    expiresAt: BigInt(input.expiresAt),
  };
  return {
    domain: { name: "MidmanEscrow", version: "1", chainId: input.chainId, verifyingContract: input.hub },
    types: vetoEIP712Types(),
    primaryType: "VetoRuling",
    message,
  };
}

export interface MutualSettlementTypedDataInput {
  readonly chainId: number;
  readonly hub: string;
  readonly dealId: string;
  readonly agreementDigest: string;
  readonly sellerAwardUnits: string;
  readonly buyerCostUnits: string;
  readonly sellerCostUnits: string;
  readonly expectedPhase: number;
  readonly settlementNonce: string;
  readonly expiresAt: string | number | bigint;
}

/** Build the MutualSettlement typed-data envelope for countersigning. */
export function buildMutualSettlementTypedData(input: MutualSettlementTypedDataInput): TypedDataEnvelope {
  const message: Record<string, unknown> = {
    dealId: input.dealId,
    agreementDigest: input.agreementDigest,
    sellerAward: BigInt(input.sellerAwardUnits),
    buyerBondCost: BigInt(input.buyerCostUnits),
    sellerBondCost: BigInt(input.sellerCostUnits),
    expectedPhase: input.expectedPhase,
    settlementNonce: input.settlementNonce,
    expiresAt: BigInt(input.expiresAt),
  };
  return {
    domain: { name: "MidmanEscrow", version: "1", chainId: input.chainId, verifyingContract: input.hub },
    types: mutualSettlementEIP712Types(),
    primaryType: "MutualSettlement",
    message,
  };
}

/**
 * Normalize a server-returned typed-data message for viem: decimal-string or
 * numeric uint/int fields become bigint (viem rejects decimal strings for
 * uint256). Bytes/address fields pass through untouched.
 */
export function normalizeTypedDataMessage(envelope: TypedDataEnvelope): Record<string, unknown> {
  const typeList = (envelope.types as Record<string, readonly { name: string; type: string }[] | undefined>)[
    envelope.primaryType
  ];
  const kinds: Record<string, string> = {};
  if (Array.isArray(typeList)) {
    for (const field of typeList) kinds[field.name] = field.type;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope.message)) {
    const kind = kinds[key] ?? "";
    if ((kind.startsWith("uint") || kind.startsWith("int")) && (typeof value === "string" || typeof value === "number")) {
      const text = String(value).trim();
      if (/^-?\d+$/.test(text)) {
        out[key] = BigInt(text);
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

export interface WalletTypedDataClient {
  signTypedData: (args: {
    account: string;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<string>;
}

/**
 * Sign a typed-data envelope with the reviewer's own wallet client.
 * Client-side only: the private key never leaves the browser.
 */
export function signTypedDataWithWallet(
  client: WalletTypedDataClient,
  account: string,
  envelope: TypedDataEnvelope,
): Promise<string> {
  return client.signTypedData({
    account,
    domain: envelope.domain,
    types: envelope.types,
    primaryType: envelope.primaryType,
    message: envelope.message,
  });
}

// ---- Dispute timeline (pure stage mapping from unix timestamps) ----

export { SELF_RESOLUTION_SECONDS, ESCALATION_WINDOW_SECONDS, RESPONDENT_EVIDENCE_SECONDS };

export interface DisputeTimelineInput {
  readonly fundedAtUnix?: number | undefined;
  readonly deliveredAtUnix?: number | undefined;
  readonly disputeOpenedAtUnix?: number | undefined;
  readonly escalatedAtUnix?: number | undefined;
  readonly evidenceCutoffUnix?: number | undefined;
  readonly primaryEndUnix?: number | undefined;
  readonly fallbackStartUnix?: number | undefined;
  readonly fallbackEndUnix?: number | undefined;
  readonly rulingExecuteAtUnix?: number | undefined;
  readonly escapeAtUnix?: number | undefined;
  readonly negotiationEndUnix?: number | undefined;
  readonly escalationEndUnix?: number | undefined;
  readonly disputeUsed?: boolean | undefined;
}

export type DisputeStageState = "done" | "active" | "upcoming" | "unknown" | "lapsed";

export interface DisputeStage {
  readonly id: string;
  readonly label: string;
  readonly window: string;
  readonly deadlineUnix: number | null;
  readonly state: DisputeStageState;
  readonly detail: string;
}

function stageCountdown(deadline: number | null, now: number): string {
  if (deadline === null) return "deadline unknown";
  return countdownTo(deadline, now);
}

/**
 * Map dispute unix timestamps to the 7-stage timeline:
 * negotiation 24h → escalation window → evidence cutoff → primary 7d →
 * fallback 7d → ruling delay → escape 60d. Missing timestamps yield
 * "unknown" stages (endpoint pending), never crashes.
 */
export function disputeStages(input: DisputeTimelineInput, nowUnix?: number): readonly DisputeStage[] {
  const now = nowUnix ?? Math.floor(Date.now() / 1_000);
  const opened = input.disputeOpenedAtUnix ?? null;
  const negotiationEnd =
    input.negotiationEndUnix ?? (opened !== null ? opened + SELF_RESOLUTION_SECONDS : null);
  const escalationEnd =
    input.escalationEndUnix ?? (negotiationEnd !== null ? negotiationEnd + ESCALATION_WINDOW_SECONDS : null);
  const evidenceCutoff =
    input.evidenceCutoffUnix ??
    (input.escalatedAtUnix !== undefined && input.escalatedAtUnix !== null
      ? input.escalatedAtUnix + RESPONDENT_EVIDENCE_SECONDS
      : null);
  const primaryEnd =
    input.primaryEndUnix ??
    (input.escalatedAtUnix !== undefined && input.escalatedAtUnix !== null
      ? input.escalatedAtUnix + PRIMARY_REVIEW_SECONDS
      : null);
  const fallbackStart = input.fallbackStartUnix ?? primaryEnd;
  const fallbackEnd =
    input.fallbackEndUnix ?? (fallbackStart !== null ? fallbackStart + FALLBACK_REVIEW_SECONDS : null);
  const escapeAt =
    input.escapeAtUnix ?? (opened !== null ? opened + CATASTROPHIC_ESCAPE_SECONDS : null);

  const after = (t: number | null): boolean => t !== null && now >= t;

  const negotiationState: DisputeStageState =
    opened === null ? "unknown" : input.escalatedAtUnix != null || after(negotiationEnd) ? "done" : "active";
  const escalationState: DisputeStageState =
    escalationEnd === null
      ? "unknown"
      : input.escalatedAtUnix != null
        ? "done"
        : after(escalationEnd)
          ? "lapsed"
          : opened === null
            ? "upcoming"
            : "active";
  const evidenceState: DisputeStageState =
    evidenceCutoff === null ? "unknown" : after(evidenceCutoff) ? "done" : input.escalatedAtUnix != null ? "active" : "upcoming";
  const primaryState: DisputeStageState =
    primaryEnd === null ? "unknown" : after(primaryEnd) ? "done" : input.escalatedAtUnix != null ? "active" : "upcoming";
  const fallbackState: DisputeStageState =
    fallbackEnd === null
      ? "unknown"
      : input.fallbackStartUnix != null || (primaryEnd !== null && after(primaryEnd))
        ? after(fallbackEnd)
          ? "done"
          : "active"
        : "upcoming";
  const rulingState: DisputeStageState =
    input.rulingExecuteAtUnix == null ? "upcoming" : after(input.rulingExecuteAtUnix) ? "done" : "active";

  return [
    {
      id: "negotiation",
      label: "Negotiation",
      window: "24h",
      deadlineUnix: negotiationEnd,
      state: negotiationState,
      detail:
        opened === null
          ? "Opens when the buyer freezes the deal (one free dispute)."
          : `Freeze opened; parties negotiate until the deadline (${stageCountdown(negotiationEnd, now)} left).`,
    },
    {
      id: "escalation",
      label: "Escalation window",
      window: "24h",
      deadlineUnix: escalationEnd,
      state: escalationState,
      detail:
        input.escalatedAtUnix != null
          ? "Escalated with bond posted."
          : escalationState === "lapsed"
            ? "LAPSED: no escalation bond was posted in time — the dispute lapses and the timeout path resumes."
            : "Claimant must post the escalation bond before the window closes.",
    },
    {
      id: "evidence",
      label: "Evidence cutoff",
      window: "24h after escalation",
      deadlineUnix: evidenceCutoff,
      state: evidenceState,
      detail: "Only the on-chain committed manifest counts. Upload before the cutoff.",
    },
    {
      id: "primary",
      label: "Primary review",
      window: "7d",
      deadlineUnix: primaryEnd,
      state: primaryState,
      detail: "Primary panel quorum reviews the committed evidence.",
    },
    {
      id: "fallback",
      label: "Fallback review",
      window: "7d",
      deadlineUnix: fallbackEnd,
      state: fallbackState,
      detail: "Independent fallback roster (separate quorum) if primary lapses or its ruling is vetoed.",
    },
    {
      id: "ruling",
      label: "Ruling delay",
      window: "exec delay",
      deadlineUnix: input.rulingExecuteAtUnix ?? null,
      state: rulingState,
      detail:
        input.rulingExecuteAtUnix == null
          ? "Starts when a quorum-signed ruling is queued; veto window runs until execution."
          : `Queued ruling executes at the deadline (${stageCountdown(input.rulingExecuteAtUnix, now)} left) unless vetoed.`,
    },
    {
      id: "escape",
      label: "Catastrophic escape",
      window: "60d",
      deadlineUnix: escapeAt,
      state: escapeAt === null ? "unknown" : after(escapeAt) ? "done" : "upcoming",
      detail:
        "60 days after the first dispute, properly escalated deals only: principal splits 50/50 (odd unit to buyer), zero fees.",
    },
  ];
}

/**
 * Explainer shown when rights were exhausted: free freeze used, a window
 * lapsed, or escalation never happened.
 */
export function exhaustedRightsNote(input: DisputeTimelineInput, nowUnix?: number): string | null {
  const now = nowUnix ?? Math.floor(Date.now() / 1_000);
  const stages = disputeStages(input, now);
  const escalation = stages.find((s) => s.id === "escalation");
  if (escalation?.state === "lapsed") {
    return (
      "Rights exhausted: the escalation window lapsed with no bond posted. The dispute is over — " +
      "the deal resumes the normal timeout path (release/refund/settle). A new freeze is not possible " +
      "because the single free dispute was already consumed."
    );
  }
  if (input.disputeUsed === true && input.disputeOpenedAtUnix == null) {
    return (
      "Dispute exhausted: this deal's single free freeze was already used (disputeUsed). " +
      "Only escalation with a real bond, mutual settlement, or the 60-day catastrophic escape remain."
    );
  }
  return null;
}

/** Phase name → contract uint8 (mirrors @midman/chain PHASE_NAMES order). */
export const PHASE_ORDER: readonly string[] = [
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
];

/** Map a phase name to its expectedPhase uint8; unknown phases map to 5 (EVIDENCE). */
export function expectedPhaseForName(phase: string | null | undefined): number {
  const idx = PHASE_ORDER.indexOf(phase ?? "");
  return idx === -1 ? 5 : idx;
}
