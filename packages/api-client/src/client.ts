// Typed fetch client for the Midman V1 API.
//
// Every method returns a validated type (see schemas.ts) and throws:
// - ApiError(status 0, ...) on transport failure,
// - ApiError(httpStatus, message) when the API returns `{ error }`,
// - ApiValidationError carrying the endpoint path on schema mismatch.
//
// Signed routes (evidence / categories / messages / review / escalation /
// settlement) authenticate via the EIP-191 signed-request scheme owned by
// apps/web/lib/requestAuth.ts. This client does NOT sign: callers pre-sign and
// pass the headers through via the trailing `headers` parameter. For JSON
// calls, sign the exact bytes produced by `encodeJsonBody(body)` so the
// server-side body hash matches. Multipart uploads sign the EMPTY body per
// the server rule (boundaries are not canonical); pass prebuilt `body` bytes
// plus the signed headers straight through.

import {
  ApiValidationError,
  validateAcceptanceSignature,
  validateAcceptDraftResult,
  validateAcceptProposalResult,
  validateAdmissionResult,
  validateApprovalProgress,
  validateAwardDraft,
  validateCategoriesList,
  validateChatMessage,
  validateConfirmation,
  validateCreateDraftResult,
  validateDeadlineSummary,
  validateDealStatus,
  validateDeliveryFormRecord,
  validateDeliveryFormResult,
  validateDraftDownload,
  validateDraftSummary,
  validateDraftTermsResult,
  validateErrorResponse,
  validateEscalationInfo,
  validateEvidenceExport,
  validateEvidenceManifest,
  validateEvidencePayload,
  validateEvidenceReceipt,
  validateEvidenceUploadResult,
  validateHealthResponse,
  validateIndexerReplayResult,
  validateIndexerTickResult,
  validateInvitation,
  validateMessagesList,
  validateQueueRulingResult,
  validateReadinessPayload,
  validateRecuseResult,
  validateRecoveryPackage,
  validateRelayJob,
  validateRelaySubmitResult,
  validateRestoreCheckResult,
  validateReviewCaseBundle,
  validateReviewCaseRecord,
  validateReviewQueue,
  validateRevocationNote,
  validateSettlementProposalsList,
  validateSettlementProposal,
  validateSettlementQuote,
  validateTxStatus,
  validateVetoPayload,
  type AcceptanceSignature,
  type AcceptDraftResult,
  type AcceptProposalResult,
  type AdmissionResult,
  type ApprovalProgress,
  type AwardDraft,
  type CategoriesList,
  type ChatMessage,
  type Confirmation,
  type CreateDraftResult,
  type DealStatus,
  type DeliveryFormRecord,
  type DeliveryFormResult,
  type DraftDownload,
  type DraftSummary,
  type DraftTermsResult,
  type EscalationInfo,
  type EvidenceExport,
  type EvidenceManifest,
  type EvidencePayload,
  type EvidenceReceipt,
  type EvidenceUploadResult,
  type HealthResponse,
  type IndexerReplayResult,
  type IndexerTickResult,
  type Invitation,
  type MessagesList,
  type QueueRulingResult,
  type ReadinessPayload,
  type RecuseResult,
  type RecoveryPackage,
  type RelayJob,
  type RelaySubmitResult,
  type RestoreCheckResult,
  type ReviewCaseBundle,
  type ReviewCaseRecord,
  type ReviewQueue,
  type RevocationNote,
  type SettlementProposalsList,
  type SettlementProposal,
  type SettlementQuote,
  type TxStatus,
  type VetoPayload,
} from "./schemas.js";

export { ApiValidationError };

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(body ? `API ${status}: ${body}` : `API ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
export type SignedHeaders = Record<string, string>;

/** Canonical JSON body bytes. Sign THESE bytes for signed JSON calls. */
export function encodeJsonBody(body: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

function extractErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // keep raw text
  }
  return text;
}

export class MidmanClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(baseUrl: string, fetchImpl?: FetchImpl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async rawGet(path: string, headers?: SignedHeaders): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { ...(headers ?? {}) },
      });
    } catch (error) {
      throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
    }
  }

  private async rawPost(path: string, body: Uint8Array, contentType: string, headers?: SignedHeaders): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": contentType, ...(headers ?? {}) },
        body: body as BodyInit,
      });
    } catch (error) {
      throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
    }
  }

  private async get<T>(path: string, validate: (value: unknown, route: string) => T, headers?: SignedHeaders): Promise<T> {
    const res = await this.rawGet(path, headers);
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, extractErrorMessage(text));
    return this.parse(`GET ${path}`, text, validate);
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    validate: (value: unknown, route: string) => T,
    headers?: SignedHeaders,
  ): Promise<T> {
    const res = await this.rawPost(path, encodeJsonBody(body), "application/json", headers);
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, extractErrorMessage(text));
    return this.parse(`POST ${path}`, text, validate);
  }

  private parse<T>(route: string, text: string, validate: (value: unknown, route: string) => T): T {
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiValidationError(route, "response is not valid JSON");
    }
    // Transport-level {error} on a 200 is still an API error, never data.
    if (typeof json === "object" && json !== null && !Array.isArray(json) && "error" in json && Object.keys(json).length === 1) {
      const parsed = validateErrorResponse(json, route);
      throw new ApiError(200, parsed.error);
    }
    try {
      return validate(json, "$");
    } catch (error) {
      if (error instanceof ApiValidationError) throw new ApiValidationError(route, error.message);
      throw error;
    }
  }

  // ---- Drafts ----

  createDraft(input: { creatorWallet: string; counterpartyHint?: string; terms: Record<string, unknown> }): Promise<CreateDraftResult> {
    const body: Record<string, unknown> = { creatorWallet: input.creatorWallet, terms: input.terms };
    if (input.counterpartyHint !== undefined) body["counterpartyHint"] = input.counterpartyHint;
    return this.postJson("/drafts", body, validateCreateDraftResult);
  }

  inviteDraft(id: string): Promise<Invitation> {
    return this.postJson(`/drafts/${encodeURIComponent(id)}/invite`, {}, validateInvitation);
  }

  acceptDraft(id: string, counterpartyAddress: string): Promise<AcceptDraftResult> {
    return this.postJson(`/drafts/${encodeURIComponent(id)}/accept`, { counterpartyAddress }, validateAcceptDraftResult);
  }

  getDraftTerms(id: string): Promise<DraftTermsResult> {
    return this.get(`/drafts/${encodeURIComponent(id)}/terms`, validateDraftTermsResult);
  }

  submitSignature(id: string, role: "buyer" | "seller", signature: string): Promise<AcceptanceSignature> {
    return this.postJson(`/drafts/${encodeURIComponent(id)}/signatures`, { role, signature }, validateAcceptanceSignature);
  }

  submitAdmission(id: string, admission: Record<string, string>): Promise<AdmissionResult> {
    return this.postJson(`/drafts/${encodeURIComponent(id)}/admission`, { admission }, validateAdmissionResult);
  }

  submitRevocationNote(id: string, by: string): Promise<RevocationNote> {
    return this.postJson(`/drafts/${encodeURIComponent(id)}/revoke-note`, { by }, validateRevocationNote);
  }

  getQuote(id: string, sellerAward?: string): Promise<SettlementQuote> {
    const query = sellerAward !== undefined ? `?sellerAward=${encodeURIComponent(sellerAward)}` : "";
    return this.get(`/drafts/${encodeURIComponent(id)}/quote${query}`, validateSettlementQuote);
  }

  getSummary(id: string): Promise<DraftSummary> {
    return this.get(`/drafts/${encodeURIComponent(id)}/summary`, validateDraftSummary);
  }

  downloadTerms(id: string): Promise<DraftDownload> {
    return this.get(`/drafts/${encodeURIComponent(id)}/download`, validateDraftDownload);
  }

  getReadinessPayload(id: string): Promise<ReadinessPayload> {
    return this.postJson(`/drafts/${encodeURIComponent(id)}/readiness-payload`, {}, validateReadinessPayload);
  }

  // ---- Chain-first deal reads ----

  getStatus(dealId: string): Promise<DealStatus> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/status`, validateDealStatus);
  }

  getConfirmation(dealId: string): Promise<Confirmation> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/confirmation`, validateConfirmation);
  }

  getRecovery(dealId: string): Promise<RecoveryPackage> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/recovery`, validateRecoveryPackage);
  }

  getTxStatus(txHash: string): Promise<TxStatus> {
    return this.get(`/tx/${encodeURIComponent(txHash)}/status`, validateTxStatus);
  }

  // ---- Relay ----

  submitRelay(idempotencyKey: string, action: string, params: Record<string, unknown>): Promise<RelaySubmitResult> {
    return this.postJson("/relay/submit", { idempotencyKey, action, params }, validateRelaySubmitResult);
  }

  getRelayJob(key: string): Promise<RelayJob> {
    return this.get(`/relay/${encodeURIComponent(key)}`, validateRelayJob);
  }

  // ---- Evidence (signed; pass pre-signed headers) ----

  listEvidence(dealId: string, headers?: SignedHeaders): Promise<EvidenceManifest> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/evidence`, validateEvidenceManifest, headers);
  }

  /** Prebuilt multipart body bytes + signed headers (signature covers the EMPTY body per server rule). */
  uploadEvidence(dealId: string, body: Uint8Array, contentType: string, headers?: SignedHeaders): Promise<EvidenceUploadResult> {
    return this.rawPost(`/deals/${encodeURIComponent(dealId)}/evidence`, body, contentType, headers).then(
      async (res) => {
        const text = await res.text();
        if (!res.ok) throw new ApiError(res.status, extractErrorMessage(text));
        return this.parse(`POST /deals/${dealId}/evidence`, text, validateEvidenceUploadResult);
      },
    );
  }

  getReceipt(dealId: string, fileHash: string, headers?: SignedHeaders): Promise<EvidenceReceipt> {
    return this.get(
      `/evidence/${encodeURIComponent(fileHash)}/receipt?dealId=${encodeURIComponent(dealId)}`,
      validateEvidenceReceipt,
      headers,
    );
  }

  exportBundle(dealId: string, headers?: SignedHeaders): Promise<EvidenceExport> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/export`, validateEvidenceExport, headers);
  }

  restoreCheck(dealId: string, fileHash: string, headers?: SignedHeaders): Promise<RestoreCheckResult> {
    return this.postJson(
      `/deals/${encodeURIComponent(dealId)}/evidence/restore-check`,
      { fileHash },
      validateRestoreCheckResult,
      headers,
    );
  }

  async downloadEvidence(
    dealId: string,
    fileHash: string,
    headers?: SignedHeaders,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string | null }> {
    const path = `/evidence/${encodeURIComponent(fileHash)}?dealId=${encodeURIComponent(dealId)}`;
    const res = await this.rawGet(path, headers);
    if (!res.ok) throw new ApiError(res.status, extractErrorMessage(await res.text()));
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
  }

  // ---- Categories / messages / commitments (signed) ----

  getCategories(headers?: SignedHeaders): Promise<CategoriesList> {
    return this.get("/categories", validateCategoriesList, headers);
  }

  submitDeliveryForm(dealId: string, category: string, data: Record<string, unknown>, headers?: SignedHeaders): Promise<DeliveryFormResult> {
    return this.postJson(
      `/deals/${encodeURIComponent(dealId)}/delivery-form`,
      { category, data },
      validateDeliveryFormResult,
      headers,
    );
  }

  getDeliveryForm(dealId: string, headers?: SignedHeaders): Promise<DeliveryFormRecord> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/delivery-form`, validateDeliveryFormRecord, headers);
  }

  postMessage(dealId: string, text: string, headers?: SignedHeaders): Promise<ChatMessage> {
    return this.postJson(`/deals/${encodeURIComponent(dealId)}/messages`, { text }, validateChatMessage, headers);
  }

  listMessages(dealId: string, headers?: SignedHeaders): Promise<MessagesList> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/messages`, validateMessagesList, headers);
  }

  evidencePayload(
    dealId: string,
    input: {
      uploader: string;
      sequence: number;
      prevCommitment: string;
      fileHashes: readonly string[];
      metadataCommitment: string;
      nonce: string;
      expiresAt: number;
      agreementDigest?: string;
    },
    headers?: SignedHeaders,
  ): Promise<EvidencePayload> {
    const body: Record<string, unknown> = {
      uploader: input.uploader,
      sequence: input.sequence,
      prevCommitment: input.prevCommitment,
      fileHashes: [...input.fileHashes],
      metadataCommitment: input.metadataCommitment,
      nonce: input.nonce,
      expiresAt: input.expiresAt,
    };
    if (input.agreementDigest !== undefined) body["agreementDigest"] = input.agreementDigest;
    return this.postJson(`/deals/${encodeURIComponent(dealId)}/evidence/payload`, body, validateEvidencePayload, headers);
  }

  // ---- Review (signed) ----

  reviewQueue(headers?: SignedHeaders): Promise<ReviewQueue> {
    return this.get("/review/queue", validateReviewQueue, headers);
  }

  reviewCase(dealId: string, headers?: SignedHeaders): Promise<ReviewCaseBundle> {
    return this.get(`/review/cases/${encodeURIComponent(dealId)}`, validateReviewCaseBundle, headers);
  }

  assignReviewers(
    dealId: string,
    rosters: { primary: readonly string[]; fallback: readonly string[] },
    headers?: SignedHeaders,
  ): Promise<ReviewCaseRecord> {
    return this.postJson(
      `/review/cases/${encodeURIComponent(dealId)}/assign`,
      { primary: [...rosters.primary], fallback: [...rosters.fallback] },
      validateReviewCaseRecord,
      headers,
    );
  }

  recuse(dealId: string, input: { reviewer: string; reason: string }, headers?: SignedHeaders): Promise<RecuseResult> {
    return this.postJson(
      `/review/cases/${encodeURIComponent(dealId)}/recuse`,
      { reviewer: input.reviewer, reason: input.reason },
      validateRecuseResult,
      headers,
    );
  }

  draftAward(
    dealId: string,
    input: {
      principalUnits: string;
      quotedFeeUnits: string;
      buyerFeeBps: number;
      sellerAwardUnits: string;
      claimantBondUnits: string;
      respondentBondUnits: string;
      evidenceCommitment: string;
      origin: number;
      rulingNonce: string;
      authEpoch: string | number;
      queueExpiry: string | number;
      arbitrationPolicyId: string;
      agreementDigest: string;
      chainId?: number;
      hub?: string;
    },
    headers?: SignedHeaders,
  ): Promise<AwardDraft> {
    const body: Record<string, unknown> = { ...input };
    return this.postJson(`/review/cases/${encodeURIComponent(dealId)}/awards/draft`, body, validateAwardDraft, headers);
  }

  submitApproval(
    dealId: string,
    input: { signer: string; signature: string; rulingDigest: string; epoch: string | number; origin: number },
    headers?: SignedHeaders,
  ): Promise<ApprovalProgress> {
    return this.postJson(
      `/review/cases/${encodeURIComponent(dealId)}/approvals`,
      { signer: input.signer, signature: input.signature, rulingDigest: input.rulingDigest, epoch: input.epoch, origin: input.origin },
      validateApprovalProgress,
      headers,
    );
  }

  queueRuling(dealId: string, input?: { rulingDigest?: string }, headers?: SignedHeaders): Promise<QueueRulingResult> {
    // NOTE: the server reads `rulingDigest` (optional; defaults to the latest
    // draft). There is no `awardId` field server-side.
    const body: Record<string, unknown> = {};
    if (input?.rulingDigest !== undefined) body["rulingDigest"] = input.rulingDigest;
    return this.postJson(`/review/cases/${encodeURIComponent(dealId)}/queue-ruling`, body, validateQueueRulingResult, headers);
  }

  submitVeto(
    dealId: string,
    input: {
      rulingDigest: string;
      origin?: number;
      vsigs: readonly { authority: string; nonce: string; expiry: string | number; signature: string }[];
    },
    headers?: SignedHeaders,
  ): Promise<VetoPayload> {
    const body: Record<string, unknown> = {
      rulingDigest: input.rulingDigest,
      vsigs: input.vsigs.map((v) => ({ authority: v.authority, nonce: v.nonce, expiry: v.expiry, signature: v.signature })),
    };
    if (input.origin !== undefined) body["origin"] = input.origin;
    return this.postJson(`/review/cases/${encodeURIComponent(dealId)}/veto`, body, validateVetoPayload, headers);
  }

  escalationInfo(dealId: string, headers?: SignedHeaders): Promise<EscalationInfo> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/escalation`, validateEscalationInfo, headers);
  }

  // ---- Settlement proposals (signed) ----
  //
  // WHY settlementNonce is required: POST /deals/:dealId/settlement-proposals
  // falls back to `randomBytes(32)` when the client omits it
  // (review/proposals.ts). A random nonce means the proposer, the
  // counterparty, and the contract never agree on one MutualSettlement struct:
  // countersignatures cannot be produced off-chain and acceptance reverts
  // on-chain once any bond posting or phase change moves the live counter.
  // Always read the live on-chain settlementNonce for the deal's current phase
  // and pass it explicitly here — never invent one client-side.

  proposeSettlement(
    dealId: string,
    input: {
      sellerAwardUnits: string;
      buyerCostUnits: string;
      sellerCostUnits: string;
      expectedPhase: number;
      settlementNonce: string;
      principalUnits?: string;
      claimantBondUnits?: string;
      respondentBondUnits?: string;
      agreementDigest?: string;
      expiresAt?: string | number;
      buyer?: string;
      seller?: string;
      proposerSignature?: string;
      chainId?: number;
      hub?: string;
    },
    headers?: SignedHeaders,
  ): Promise<SettlementProposal> {
    requireSettlementNonce(input.settlementNonce);
    const body: Record<string, unknown> = {
      sellerAwardUnits: input.sellerAwardUnits,
      buyerCostUnits: input.buyerCostUnits,
      sellerCostUnits: input.sellerCostUnits,
      expectedPhase: input.expectedPhase,
      settlementNonce: input.settlementNonce,
    };
    if (input.principalUnits !== undefined) body["principalUnits"] = input.principalUnits;
    if (input.claimantBondUnits !== undefined) body["claimantBondUnits"] = input.claimantBondUnits;
    if (input.respondentBondUnits !== undefined) body["respondentBondUnits"] = input.respondentBondUnits;
    if (input.agreementDigest !== undefined) body["agreementDigest"] = input.agreementDigest;
    if (input.expiresAt !== undefined) body["expiresAt"] = input.expiresAt;
    if (input.buyer !== undefined) body["buyer"] = input.buyer;
    if (input.seller !== undefined) body["seller"] = input.seller;
    if (input.proposerSignature !== undefined) body["proposerSignature"] = input.proposerSignature;
    if (input.chainId !== undefined) body["chainId"] = input.chainId;
    if (input.hub !== undefined) body["hub"] = input.hub;
    return this.postJson(
      `/deals/${encodeURIComponent(dealId)}/settlement-proposals`,
      body,
      validateSettlementProposal,
      headers,
    );
  }

  listProposals(dealId: string, headers?: SignedHeaders): Promise<SettlementProposalsList> {
    return this.get(`/deals/${encodeURIComponent(dealId)}/settlement-proposals`, validateSettlementProposalsList, headers);
  }

  acceptProposal(
    proposalId: string,
    input: { signature: string; counterparty?: string; proposerSignature?: string },
    headers?: SignedHeaders,
  ): Promise<AcceptProposalResult> {
    const body: Record<string, unknown> = { signature: input.signature };
    if (input.counterparty !== undefined) body["counterparty"] = input.counterparty;
    if (input.proposerSignature !== undefined) body["proposerSignature"] = input.proposerSignature;
    return this.postJson(`/settlement-proposals/${encodeURIComponent(proposalId)}/accept`, body, validateAcceptProposalResult, headers);
  }

  // ---- Indexer / health ----

  indexerTick(): Promise<IndexerTickResult> {
    return this.postJson("/indexer/tick", {}, validateIndexerTickResult);
  }

  indexerReplay(fromBlock?: string | number | bigint): Promise<IndexerReplayResult> {
    const body: Record<string, unknown> = {};
    if (fromBlock !== undefined) body["fromBlock"] = String(fromBlock);
    return this.postJson("/indexer/replay", body, validateIndexerReplayResult);
  }

  health(): Promise<HealthResponse> {
    return this.get("/health", validateHealthResponse);
  }
}

/**
 * Guard for the required live settlement nonce. Throws when the nonce is
 * missing or malformed: silently falling back to a random nonce would split
 * the proposal off from the on-chain counter and make mutual settlement
 * uncompletable (see proposeSettlement docs).
 */
export function requireSettlementNonce(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ApiValidationError(
      "$.settlementNonce",
      "a live on-chain settlementNonce (0x + 64 hex) is required; random nonces invalidate mutual settlement",
    );
  }
  return value;
}

export { validateDeadlineSummary };
export type {
  AcceptanceSignature,
  AcceptDraftResult,
  AcceptProposalResult,
  AdmissionResult,
  ApprovalProgress,
  AwardDraft,
  CategoriesList,
  ChatMessage,
  Confirmation,
  CreateDraftResult,
  DealStatus,
  DeliveryFormRecord,
  DeliveryFormResult,
  DraftDownload,
  DraftSummary,
  DraftTermsResult,
  EscalationInfo,
  EvidenceExport,
  EvidenceManifest,
  EvidencePayload,
  EvidenceReceipt,
  EvidenceUploadResult,
  HealthResponse,
  IndexerReplayResult,
  IndexerTickResult,
  Invitation,
  MessagesList,
  QueueRulingResult,
  ReadinessPayload,
  RecuseResult,
  RecoveryPackage,
  RelayJob,
  RelaySubmitResult,
  RestoreCheckResult,
  ReviewCaseBundle,
  ReviewCaseRecord,
  ReviewQueue,
  RevocationNote,
  SettlementProposalsList,
  SettlementProposal,
  SettlementQuote,
  TxStatus,
  VetoPayload,
};
