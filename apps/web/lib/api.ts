// Typed fetch wrappers for the Midman V1 API.
// Base URL: NEXT_PUBLIC_API_URL ?? "/api" (same-origin Next.js rewrite proxy).
// The "/api" default keeps the wallet session cookie first-party; see
// next.config.mjs for the rewrite and the documented CORS fallback.
// Delegates to @midman/api-client (single validated definitions + typed
// client). Every helper throws ApiError (with HTTP status) on failure so pages
// can render error surfaces instead of crashing. ApiValidationError is thrown
// on 200 responses that fail schema validation (endpoint path in message).

import { ApiError, MidmanClient } from "@midman/api-client";

export { ApiError } from "@midman/api-client";
export type { ApiValidationError } from "@midman/api-client";

function resolveApiBase(): string {
  const configured =
    typeof process !== "undefined" ? process.env["NEXT_PUBLIC_API_URL"] : undefined;
  return configured && configured.trim() !== "" ? configured.trim().replace(/\/+$/, "") : "/api";
}

export const API_BASE = resolveApiBase();

const client = new MidmanClient(API_BASE);

// ---- Drafts ----

export interface DraftTerms extends Record<string, string> {
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
  readonly chainId: string;
  readonly hub: string;
  readonly token: string;
  readonly fundingDeadline: string;
  readonly nonce: string;
  readonly salt: string;
  readonly agreementHash: string;
  readonly category: string;
}

export interface CreateDraftInput {
  readonly creatorWallet: string;
  readonly counterpartyHint?: string;
  readonly terms: Record<string, unknown>;
}

export interface CreateDraftResult {
  readonly id: string;
  readonly dealId: string;
  readonly terms: DraftTerms;
}

export interface InviteResult {
  readonly invitationToken: string;
  readonly expiresAt: string;
}

export interface DraftTermsResult {
  readonly terms: DraftTerms;
  readonly signatures: Record<string, string>;
  readonly status: string;
}

export interface QuoteResult extends Record<string, string> {
  readonly prepaidBuyerFee: string;
  readonly earnedFee: string;
  readonly buyerFee: string;
  readonly sellerFee: string;
  readonly buyerClaim: string;
  readonly sellerClaim: string;
  readonly funded: string;
  readonly source: string;
}

export function createDraft(input: CreateDraftInput): Promise<CreateDraftResult> {
  return client.createDraft(input) as Promise<CreateDraftResult>;
}

export function inviteDraft(id: string): Promise<InviteResult> {
  return client.inviteDraft(id);
}

export function acceptDraft(id: string, counterpartyAddress: string): Promise<{ ok: boolean }> {
  return client.acceptDraft(id, counterpartyAddress);
}

export function getDraftTerms(id: string): Promise<DraftTermsResult> {
  return client.getDraftTerms(id) as Promise<DraftTermsResult>;
}

export function postSignature(id: string, role: "buyer" | "seller", signature: string): Promise<{ ok: boolean }> {
  return client.submitSignature(id, role, signature);
}

export function postAdmission(id: string, admission: Record<string, string>): Promise<{ ok: boolean }> {
  return client.submitAdmission(id, admission);
}

export function postRevokeNote(
  id: string,
  by: string,
): Promise<{ ok: boolean; note: unknown; pendingUntil: string }> {
  return client.submitRevocationNote(id, by) as Promise<{ ok: boolean; note: unknown; pendingUntil: string }>;
}

export function getQuote(id: string, sellerAward?: string): Promise<QuoteResult> {
  return client.getQuote(id, sellerAward) as Promise<QuoteResult>;
}

// ---- Chain-first deal reads ----

export interface DealStatus {
  readonly dealId: string;
  readonly source: "chain" | "projection" | "draft";
  readonly phase?: string;
  readonly status?: string;
  readonly fundedAt?: string;
  readonly deliveredAt?: string;
  readonly disputeOpenedAt?: string;
  readonly disputeUsed?: boolean;
  readonly events?: number;
  /** Live on-chain settlement counter when the status endpoint exposes it. */
  readonly settlementNonce?: string;
  readonly terms?: DraftTerms;
}

export interface Confirmation {
  readonly dealId: string;
  readonly level: "pending" | "included" | "safe" | "finalized";
  readonly txBlock?: string;
  readonly safeBlock?: string | null;
  readonly finalizedBlock?: string | null;
}

export interface RecoveryPackage {
  readonly version: number;
  readonly chainId: number;
  readonly hub: string;
  readonly usdc: string;
  readonly dealId: string;
  readonly agreementDigest: string;
  readonly canonicalTerms: Record<string, string>;
  readonly signatures: { readonly buyer: string; readonly seller: string };
  readonly policyIds: Record<string, string>;
  readonly relevantTransactions: readonly string[];
  readonly indexerTip: { readonly blockNumber: string; readonly blockHash: string } | null;
  readonly emergencyCalldata: Record<string, string>;
  readonly note: string;
}

export function getDealStatus(dealId: string): Promise<DealStatus> {
  return client.getStatus(dealId) as Promise<DealStatus>;
}

export function getConfirmation(dealId: string): Promise<Confirmation> {
  return client.getConfirmation(dealId) as Promise<Confirmation>;
}

export function getRecovery(dealId: string): Promise<RecoveryPackage> {
  return client.getRecovery(dealId) as Promise<RecoveryPackage>;
}

// ---- Relay outbox ----

export interface RelaySubmitResult {
  readonly idempotencyKey: string;
  readonly inserted: boolean;
  readonly status: string;
}

export interface RelayJob {
  readonly idempotencyKey: string;
  readonly action: string;
  readonly status: string;
  readonly attempts: number;
  readonly txHash: string | null;
  readonly result: unknown;
}

export function relaySubmit(idempotencyKey: string, action: string, params: Record<string, unknown>): Promise<RelaySubmitResult> {
  return client.submitRelay(idempotencyKey, action, params);
}

export function getRelayJob(key: string): Promise<RelayJob> {
  return client.getRelayJob(key) as Promise<RelayJob>;
}

/** Relay action allowlist enforced by POST /relay/submit (mirrors the API). */
export const RELAY_ACTIONS: readonly string[] = [
  "openDispute",
  "escalate",
  "postRespondentBond",
  "submitEvidenceCommitment",
  "approveSeller",
  "refundBuyer",
  "mutualSettlement",
  "markDelivered",
  "finalizeAfterTimeout",
  "refundForNonDelivery",
  "lapseDispute",
  "advanceToPrimary",
  "activateFallback",
  "queuePrimaryRuling",
  "queueFallbackRuling",
  "vetoPrimaryRuling",
  "vetoFallbackRuling",
  "executeRuling",
  "markDeadlock",
  "catastrophicEscape",
  "claimFor",
  "fund",
];

// ---- Funding bundle endpoints (finding #6/#8) ----
//
// Added by the parallel API work:
//   GET  /drafts/:id/funding-bundle
//   POST /drafts/:id/deal-signatures
//   POST /drafts/:id/relay-fund
//   GET  /drafts/:id/funding-status
//
// These are intentionally thin, unvalidated transport wrappers: the typed,
// defensive validation lives in apps/web/lib/funding.ts (parseFundingBundle),
// which tolerates a not-yet-deployed endpoint with a clear error.
// Every wrapper throws ApiError (with the HTTP status) on failure.

async function requestFunding<T>(
  path: string,
  method: "GET" | "POST",
  body: Record<string, unknown> | undefined,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const impl = fetchImpl ?? fetch;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await impl(`${API_BASE}${path}`, init);
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (parsed && typeof parsed.error === "string") message = parsed.error;
    } catch {
      // keep raw text
    }
    throw new ApiError(res.status, message);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** GET /drafts/:id/funding-bundle — raw bundle (validate with lib/funding.ts). */
export function getFundingBundleRaw(draftId: string, fetchImpl?: typeof fetch): Promise<unknown> {
  return requestFunding<unknown>(`/drafts/${encodeURIComponent(draftId)}/funding-bundle`, "GET", undefined, fetchImpl);
}

/** POST /drafts/:id/deal-signatures — record buyer/seller DealTerms signatures. */
export function postDealSignatures(
  draftId: string,
  payload: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  return requestFunding<unknown>(`/drafts/${encodeURIComponent(draftId)}/deal-signatures`, "POST", payload, fetchImpl);
}

/**
 * POST /drafts/:id/admission/request — ask the automated admission service for
 * a FundingAdmission (risk rules decide). The grant is stored on the draft and
 * appears in the next funding bundle.
 */
export function requestAdmission(draftId: string, fetchImpl?: typeof fetch): Promise<unknown> {
  return requestFunding<unknown>(`/drafts/${encodeURIComponent(draftId)}/admission/request`, "POST", {}, fetchImpl);
}

/** POST /drafts/:id/relay-fund — hand the funding bundle to the sponsored relayer. */
export function postRelayFund(
  draftId: string,
  payload: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  return requestFunding<unknown>(`/drafts/${encodeURIComponent(draftId)}/relay-fund`, "POST", payload, fetchImpl);
}

/** GET /drafts/:id/funding-status — relayer/projection funding progress. */
export function getFundingStatusRaw(draftId: string, fetchImpl?: typeof fetch): Promise<unknown> {
  return requestFunding<unknown>(`/drafts/${encodeURIComponent(draftId)}/funding-status`, "GET", undefined, fetchImpl);
}
