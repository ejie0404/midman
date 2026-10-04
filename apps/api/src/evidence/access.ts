// Signed-request auth for the encrypted evidence subsystem (P-13 access:
// bound participants + assigned reviewers, least privilege; an invitation
// token is never authorization).
//
// Header spec (exact):
//   x-wallet-address:   0x... (20-byte hex)
//   x-wallet-expiry:    unix seconds, integer ASCII
//   x-wallet-signature: EIP-191 personal_sign (viem signMessage /
//                       eth_personalSign) of the UTF-8 message
//   x-content-sha256:   (uploads) lowercase/0x hex sha256 of the FILE CONTENT
//
// Signed message (exact, UTF-8, newline separated):
//   `${METHOD}\n${path}\n${sha256hex(bodyBytes)}\n${contentSha256 ?? ''}\n${expiry}`
// where METHOD is the uppercased HTTP method, path is req.url (origin-form
// path INCLUDING the query string, e.g. `/evidence/0xabc?dealId=0x123`),
// bodyBytes are the raw request bytes (empty when there is no body; for
// multipart uploads the body hash is sha256 of the empty string because the
// boundary bytes are not canonical), contentSha256 is the normalized
// x-content-sha256 header value (empty string when the header is absent),
// and expiry echoes the header value verbatim. Because multipart bodies are
// not canonical, the FILE CONTENT hash is what binds an upload to its bytes:
// the upload route recomputes sha256 over the received bytes and rejects a
// mismatch (400). Legacy clients that predate content binding may still sign
// the 4-line message `${METHOD}\n${path}\n${bodyHash}\n${expiry}`; that form
// is accepted only while x-content-sha256 is absent. Requests are rejected
// when expired or when expiry is more than 15 minutes in the future.
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { recoverMessageAddress, type Address, type Hash } from "viem";
import { getCase, listOpen } from "../review/registry.js";

/** Max seconds an expiry may lie in the future (clock-skew bound). */
export const SIGNED_REQUEST_SKEW_SECONDS = 15 * 60;

/** Header carrying the sha256 of an upload's file CONTENT (bound in the signature). */
export const CONTENT_SHA256_HEADER = "x-content-sha256";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function headerValue(req: FastifyRequest, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Canonical body hash for signature verification. */
export function signedBodyHashHex(req: FastifyRequest): string {
  const contentType = String(req.headers["content-type"] ?? "");
  // Multipart boundaries are random per request, so multipart uploads are
  // signed over the empty body hash (auth binds method + path + expiry).
  if (contentType.includes("multipart/form-data")) return sha256Hex("");
  const rawBody = (req as unknown as { rawBody?: unknown }).rawBody;
  if (typeof rawBody === "string") return sha256Hex(Buffer.from(rawBody, "utf8"));
  if (rawBody instanceof Uint8Array) return sha256Hex(rawBody);
  if (Buffer.isBuffer(rawBody)) return sha256Hex(rawBody);
  const body = req.body as unknown;
  if (body === undefined || body === null) return sha256Hex("");
  if (typeof body === "string") return sha256Hex(Buffer.from(body, "utf8"));
  if (body instanceof Uint8Array) return sha256Hex(body);
  if (Buffer.isBuffer(body)) return sha256Hex(body);
  if (typeof body === "object") return sha256Hex(Buffer.from(JSON.stringify(body), "utf8"));
  return sha256Hex("");
}

/**
 * Normalized x-content-sha256 value (lowercase, no 0x prefix). Empty string
 * when the header is absent; throws 400 when present but malformed.
 */
export function declaredContentSha256(req: FastifyRequest): string {
  const raw = headerValue(req, CONTENT_SHA256_HEADER).trim().toLowerCase();
  if (raw === "") return "";
  const normalized = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw httpError(400, "Invalid x-content-sha256 header (expected 64 hex chars)");
  }
  return normalized;
}

/** Exact signed message construction (also used by tests/clients). */
export function buildSignedMessage(
  method: string,
  path: string,
  bodyHashHex: string,
  contentSha256: string,
  expiry: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${bodyHashHex}\n${contentSha256}\n${expiry}`;
}

/** Legacy 4-line message (no content binding); accepted only without a content header. */
function buildLegacySignedMessage(method: string, path: string, bodyHashHex: string, expiry: string): string {
  return `${method.toUpperCase()}\n${path}\n${bodyHashHex}\n${expiry}`;
}

/** Verify signed-request headers; resolves the authorized wallet or throws 401. */
export async function verifySignedRequest(req: FastifyRequest): Promise<Address> {
  const wallet = headerValue(req, "x-wallet-address");
  const expiryRaw = headerValue(req, "x-wallet-expiry");
  const signature = headerValue(req, "x-wallet-signature");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw httpError(401, "Missing or invalid x-wallet-address");
  }
  if (!expiryRaw || !/^\d+$/.test(expiryRaw)) {
    throw httpError(401, "Missing or invalid x-wallet-expiry");
  }
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw httpError(401, "Missing or invalid x-wallet-signature");
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expiry = Number.parseInt(expiryRaw, 10);
  if (nowSeconds > expiry) throw httpError(401, "Signed request expired");
  if (expiry - nowSeconds > SIGNED_REQUEST_SKEW_SECONDS) {
    throw httpError(401, "Signed request expiry too far in the future");
  }
  const method = (req.method ?? "GET").toUpperCase();
  const path = req.url ?? "/";
  const contentSha = declaredContentSha256(req);
  const bodyHash = signedBodyHashHex(req);
  const messages = [buildSignedMessage(method, path, bodyHash, contentSha, expiryRaw)];
  // Backward compatibility: no content header -> also accept the legacy
  // 4-line message so pre-binding clients are not locked out.
  if (contentSha === "") messages.push(buildLegacySignedMessage(method, path, bodyHash, expiryRaw));
  let recovered: Address | null = null;
  for (const message of messages) {
    try {
      const candidate = await recoverMessageAddress({ message, signature: signature as Hash });
      if (candidate.toLowerCase() === wallet.toLowerCase()) {
        recovered = candidate;
        break;
      }
    } catch {
      // try the next candidate format
    }
  }
  if (!recovered) throw httpError(401, "Invalid wallet signature");
  return wallet as Address;
}

/** Minimal structural deps (avoids importing routes.ts and its cycles). */
export interface DealPartyStore {
  getDraftByDeal(dealId: string): Promise<{ terms: Record<string, string> } | null>;
}

export interface DealPartyReader {
  getDeal(hub: Address, dealId: Hash): Promise<Record<string, bigint | string | boolean | number>>;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Resolve a wallet's role for a deal. Chain state wins when reader+hub are
 * available and the deal is on-chain with non-zero parties; otherwise (or
 * when the chain read fails / deal is not bytes32 / parties are zero)
 * falls back to the draft lookup comparing buyer/seller in terms.
 */
export async function dealParty(
  store: DealPartyStore,
  reader: DealPartyReader | null,
  hub: Address | null,
  dealId: string,
  wallet: string,
): Promise<"buyer" | "seller" | null> {
  const want = wallet.toLowerCase();
  if (reader && hub && /^0x[0-9a-fA-F]{64}$/.test(dealId)) {
    try {
      const deal = await reader.getDeal(hub, dealId as Hash);
      const buyer = String(deal["buyer"] ?? "").toLowerCase();
      const seller = String(deal["seller"] ?? "").toLowerCase();
      if (buyer === want && buyer !== "") return "buyer";
      if (seller === want && seller !== "") return "seller";
      // Authoritative on-chain verdict only when parties are known;
      // zero-party (unfunded/unknown) deals fall through to the draft.
      if (buyer !== ZERO_ADDRESS && seller !== ZERO_ADDRESS && buyer !== "" && seller !== "") {
        return null;
      }
    } catch {
      // Chain read failed: fall through to the draft projection.
    }
  }
  try {
    const draft = await store.getDraftByDeal(dealId);
    if (!draft) return null;
    const buyer = String(draft.terms["buyer"] ?? "").toLowerCase();
    const seller = String(draft.terms["seller"] ?? "").toLowerCase();
    if (buyer !== "" && buyer === want) return "buyer";
    if (seller !== "" && seller === want) return "seller";
    return null;
  } catch {
    return null;
  }
}

/** Same as dealParty but throws a 403 when the wallet is not a party. */
export async function requireDealParty(
  store: DealPartyStore,
  reader: DealPartyReader | null,
  hub: Address | null,
  dealId: string,
  wallet: string,
): Promise<"buyer" | "seller"> {
  const role = await dealParty(store, reader, hub, dealId, wallet);
  if (!role) throw httpError(403, "Wallet is not a party to this deal");
  return role;
}

/** REVIEWER_WALLETS env allowlist (comma-separated, case-insensitive). */
export function isReviewer(wallet: string): boolean {
  const raw = process.env["REVIEWER_WALLETS"] ?? "";
  if (!raw.trim()) return false;
  const allow = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return allow.has(wallet.toLowerCase());
}

/** Explicit supervisor role env; enables the REVIEWER_WALLETS superuser fallback. */
export function supervisorModeEnabled(): boolean {
  return process.env["EVIDENCE_SUPERVISOR"] === "1";
}

/** A supervisor is an allowlisted wallet while EVIDENCE_SUPERVISOR=1. */
export function isSupervisor(wallet: string): boolean {
  return supervisorModeEnabled() && isReviewer(wallet);
}

/**
 * STRICT reviewer check used by the route guard (Round-2, requirement 5): a
 * reviewer may access a deal ONLY when assigned to it (review-registry
 * primary/fallback, its per-deal allowlist) or as an explicit supervisor. A
 * deal with NO review case grants NO reviewer access. This differs from the
 * legacy `reviewerCanAccess` (kept for the evidence handlers and the
 * pre-escalation on-call drill path) only in that it drops the global
 * "no case -> roster" fallback.
 */
export function reviewerAssignedTo(dealId: string, wallet: string): boolean {
  const want = wallet.toLowerCase();
  const reviewCase = getCase(dealId);
  if (reviewCase) {
    const assigned = [...reviewCase.primary, ...reviewCase.fallback].some(
      (entry) => entry.toLowerCase() === want,
    );
    if (assigned) return true;
  }
  if (dealReviewerAllowlist(dealId).has(want)) return true;
  if (supervisorModeEnabled() && isReviewer(wallet)) return true;
  return false;
}

/** True when `wallet` is assigned to at least one open review case (queue access). */
export function hasAnyReviewerAssignment(wallet: string): boolean {
  const want = wallet.toLowerCase();
  for (const tracked of listOpen()) {
    if ([...tracked.primary, ...tracked.fallback].some((entry) => entry.toLowerCase() === want)) {
      return true;
    }
  }
  return false;
}

/** Per-deal reviewer allowlist env: `dealId:wallet|wallet;dealId2:wallet`. */
function dealReviewerAllowlist(dealId: string): Set<string> {
  const raw = (process.env["EVIDENCE_REVIEWER_ALLOWLIST"] ?? "").trim();
  const out = new Set<string>();
  if (raw === "") return out;
  const want = dealId.toLowerCase();
  for (const group of raw.split(";")) {
    const separator = group.indexOf(":");
    if (separator < 0) continue;
    const deal = group.slice(0, separator).trim().toLowerCase();
    if (deal !== want) continue;
    for (const wallet of group.slice(separator + 1).split("|")) {
      const entry = wallet.trim().toLowerCase();
      if (entry !== "") out.add(entry);
    }
  }
  return out;
}

/**
 * Whether `wallet` may read `dealId`'s evidence as a reviewer.
 *
 * Least privilege (P-13): a reviewer may read a case ONLY when assigned to it
 * (review-registry primary/fallback panel for the deal's epoch) or explicitly
 * allowlisted for that deal. The global REVIEWER_WALLETS roster is a superuser
 * fallback ONLY when EVIDENCE_SUPERVISOR=1. For a deal with no review case yet
 * (pre-escalation drill), the roster still acts as the on-call reviewer set so
 * drills keep working without granting access to cases that HAVE a panel.
 */
export function reviewerCanAccess(dealId: string, wallet: string): boolean {
  const want = wallet.toLowerCase();
  const reviewCase = getCase(dealId);
  if (reviewCase) {
    const assigned = [...reviewCase.primary, ...reviewCase.fallback].some(
      (entry) => entry.toLowerCase() === want,
    );
    if (assigned) return true;
  }
  if (dealReviewerAllowlist(dealId).has(want)) return true;
  if (supervisorModeEnabled() && isReviewer(wallet)) return true;
  if (!reviewCase && isReviewer(wallet)) return true;
  return false;
}
