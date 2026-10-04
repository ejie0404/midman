// Invitation-token helpers + acceptance flow for apps/web.
//
// The raw invitation token is delivered in the URL FRAGMENT (#invite=...): it is
// never sent in the Referer header and never logged. Acceptance authenticates
// the intended counterparty through the wallet session (lib/session.ts) and
// POSTs the token to /drafts/:id/accept; the server re-checks expiry, revoked,
// consumed, and intended-wallet binding (compare-and-set). After success the
// token is stripped from the visible URL.
//
// Only erasable TypeScript is used so Node 24 can import this file directly in
// tests (no enums, namespaces, or parameter properties).

import { ApiError } from "@midman/api-client";
import { API_BASE } from "./api.ts";
import { getSession, signIn, type SessionSigner, type SessionFetchOptions } from "./session.ts";

export const INVITE_HASH_PREFIX = "invite=";

/** Read the invitation token from a URL fragment string (e.g. "#invite=abc"). */
export function readInviteToken(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const match = /(?:^#?|&)invite=([^&]+)/.exec(hash);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Return the fragment with the invite token removed (keeps other params). */
export function stripInviteToken(hash: string | null | undefined): string {
  if (!hash) return "";
  const cleaned = hash
    .replace(/^#/, "")
    .split("&")
    .filter((part) => part !== "" && !part.startsWith(INVITE_HASH_PREFIX))
    .join("&");
  return cleaned === "" ? "" : `#${cleaned}`;
}

/**
 * Remove the invite token from the visible URL without a navigation/reload.
 * Returns the new relative URL. No-op on the server or when replaceState is
 * unavailable.
 */
export function clearInviteFromLocation(location: {
  pathname: string;
  search: string;
  hash: string;
}, history?: { replaceState: (data: unknown, title: string, url: string) => void }): string {
  const next = `${location.pathname}${location.search}${stripInviteToken(location.hash)}`;
  const target = history ?? (typeof window !== "undefined" ? window.history : undefined);
  if (target && typeof target.replaceState === "function") {
    target.replaceState(null, "", next);
  }
  return next;
}

export type InviteFailureReason =
  | "unknown"
  | "expired"
  | "revoked"
  | "consumed"
  | "bad-token"
  | "wrong-wallet"
  | "not-authenticated";

export class InviteError extends Error {
  readonly reason: InviteFailureReason;
  readonly status: number;
  constructor(reason: InviteFailureReason, message: string, status = 403) {
    super(message);
    this.name = "InviteError";
    this.reason = reason;
    this.status = status;
  }
}

const REASON_WORDS: readonly InviteFailureReason[] = [
  "expired",
  "revoked",
  "consumed",
  "wrong-wallet",
  "bad-token",
  "unknown",
];

function reasonFromMessage(message: string): InviteFailureReason {
  const lower = message.toLowerCase();
  for (const reason of REASON_WORDS) {
    if (lower.includes(reason.replace("-", " ")) || lower.includes(reason)) return reason;
  }
  return "unknown";
}

export interface InviteAcceptResult {
  readonly ok: true;
  readonly counterpartyAddress: string;
}

async function postAccept(
  draftId: string,
  token: string,
  options: SessionFetchOptions,
): Promise<InviteAcceptResult> {
  const impl = options.fetchImpl ?? fetch;
  const base = (
    options.baseUrl ??
    (typeof process !== "undefined" ? process.env["NEXT_PUBLIC_API_URL"] : undefined) ??
    API_BASE
  ).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await impl(`${base}/drafts/${encodeURIComponent(draftId)}/accept`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationToken: token }),
    });
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
    if (res.status === 401) throw new InviteError("not-authenticated", message, 401);
    const reason = reasonFromMessage(message);
    throw new InviteError(reason, message, res.status);
  }
  const parsed = (text ? JSON.parse(text) : {}) as { ok?: unknown; counterpartyAddress?: unknown };
  if (parsed.ok !== true || typeof parsed.counterpartyAddress !== "string") {
    throw new InviteError("unknown", "Unexpected accept response", res.status);
  }
  return { ok: true, counterpartyAddress: parsed.counterpartyAddress };
}

/**
 * POST /drafts/:id/accept WITH the invitation token. The caller must already be
 * authenticated (session cookie); this validates the session wallet first and
 * fails with InviteError("not-authenticated") when there is none.
 */
export async function acceptInvitation(
  draftId: string,
  token: string,
  options: SessionFetchOptions = {},
): Promise<InviteAcceptResult> {
  if (!draftId) throw new InviteError("unknown", "draftId is required", 400);
  if (!token) throw new InviteError("bad-token", "invitation token is missing", 400);
  const session = await getSession(options);
  if (!session.authenticated) {
    throw new InviteError("not-authenticated", "Connect and sign in with the invited wallet first.", 401);
  }
  return postAccept(draftId, token, options);
}

/**
 * Authenticate the invited counterparty (if needed) and accept. Wallet
 * connection alone is not enough: this establishes a signed session first.
 */
export async function acceptInvitationAsCounterparty(
  input: { readonly draftId: string; readonly token: string; readonly signer: SessionSigner; readonly chainId?: number },
  options: SessionFetchOptions = {},
): Promise<InviteAcceptResult> {
  const session = await getSession(options);
  const authenticatedWallet = session.authenticated ? session.wallet.toLowerCase() : null;
  if (authenticatedWallet !== input.signer.address.toLowerCase()) {
    await signIn(input.signer, { ...options, chainId: input.chainId ?? 8453 });
  }
  return postAccept(input.draftId, input.token, options);
}
