// Wallet session client (SIWE-style sign-in) for apps/web.
//
// Wallet connection alone is NOT authentication. Opening a session requires:
//   1. POST /auth/challenge  { wallet, chainId }  -> exact EIP-191 message
//   2. the connected wallet personal_signs that EXACT message (purpose sentence
//      "Midman sign-in only, no funds authorized" — never a financial action)
//   3. POST /auth/verify      { nonce, wallet, signature, ... } -> Set-Cookie
//   4. GET  /auth/session     -> { authenticated, wallet, expiresAt }
//
// Every request sends `credentials: "include"` so the httpOnly session cookie is
// stored/sent first-party (the API is reachable through the same-origin /api
// rewrite; see next.config.mjs). Logout revokes it server-side.
//
// Only erasable TypeScript is used so Node 24 can import this file directly in
// tests (no enums, namespaces, or parameter properties).

import { ApiError } from "@midman/api-client";
import { API_BASE } from "./api.ts";

/** Default same-origin proxy prefix; override with an absolute API origin. */
export const DEFAULT_SESSION_BASE = "/api";

export interface SessionSigner {
  /** The wallet that will be authenticated (x-wallet-address). */
  readonly address: string;
  /** personal_sign over the exact challenge message. */
  signMessage(message: string): Promise<string>;
}

export interface SessionChallenge {
  readonly challenge: {
    readonly domain: string;
    readonly chainId: number;
    readonly wallet: string;
    readonly nonce: string;
    readonly expiresAt: number;
    readonly purpose?: string;
  };
  readonly message: string;
  readonly uri: string;
  readonly expiresAt: number;
}

export interface AuthSession {
  readonly authenticated: true;
  readonly wallet: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AnonymousSession {
  readonly authenticated: false;
}

export type SessionState = AuthSession | AnonymousSession;

export interface SessionFetchOptions {
  /** Injected fetch (tests). Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Base URL override. Defaults to NEXT_PUBLIC_API_URL or "/api". */
  readonly baseUrl?: string;
}

function resolveBase(baseUrl?: string): string {
  const explicit =
    baseUrl ?? (typeof process !== "undefined" ? process.env["NEXT_PUBLIC_API_URL"] : undefined) ?? API_BASE;
  return explicit.replace(/\/+$/, "");
}

function extractMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // keep raw text
  }
  return text;
}

async function sessionFetch(
  path: string,
  init: RequestInit,
  options: SessionFetchOptions,
): Promise<Response> {
  const impl = options.fetchImpl ?? fetch;
  const base = resolveBase(options.baseUrl);
  try {
    return await impl(`${base}${path}`, { credentials: "include", ...init });
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, extractMessage(text));
  return (text ? JSON.parse(text) : {}) as T;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new ApiError(0, `Auth response missing ${field}`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiError(0, `Auth response missing ${field}`);
  return value;
}

/** POST /auth/challenge — issue a single-use login challenge + exact message. */
export async function requestChallenge(
  wallet: string,
  chainId: number,
  options: SessionFetchOptions = {},
): Promise<SessionChallenge> {
  const res = await sessionFetch(
    "/auth/challenge",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, chainId }),
    },
    options,
  );
  const raw = await readJson<Record<string, unknown>>(res);
  const challenge = (raw["challenge"] ?? {}) as Record<string, unknown>;
  return {
    challenge: {
      domain: requireString(challenge["domain"], "challenge.domain"),
      chainId: requireNumber(challenge["chainId"], "challenge.chainId"),
      wallet: requireString(challenge["wallet"], "challenge.wallet"),
      nonce: requireString(challenge["nonce"], "challenge.nonce"),
      expiresAt: requireNumber(challenge["expiresAt"], "challenge.expiresAt"),
      ...(typeof challenge["purpose"] === "string" ? { purpose: challenge["purpose"] } : {}),
    },
    message: requireString(raw["message"], "message"),
    uri: typeof raw["uri"] === "string" ? (raw["uri"] as string) : "",
    expiresAt: requireNumber(raw["expiresAt"], "expiresAt"),
  };
}

/** POST /auth/verify — exchange the signed challenge for a session cookie. */
export async function verifyChallenge(
  input: { readonly nonce: string; readonly wallet: string; readonly signature: string; readonly chainId?: number },
  options: SessionFetchOptions = {},
): Promise<{ readonly ok: true; readonly wallet: string; readonly expiresAt: number }> {
  const body: Record<string, unknown> = {
    nonce: input.nonce,
    wallet: input.wallet,
    signature: input.signature,
  };
  if (input.chainId !== undefined) body["chainId"] = input.chainId;
  const res = await sessionFetch(
    "/auth/verify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
  const raw = await readJson<Record<string, unknown>>(res);
  if (raw["ok"] !== true) throw new ApiError(0, "Auth verify did not return ok");
  return {
    ok: true,
    wallet: requireString(raw["wallet"], "wallet"),
    expiresAt: requireNumber(raw["expiresAt"], "expiresAt"),
  };
}

/** GET /auth/session — current session, or { authenticated: false }. */
export async function getSession(options: SessionFetchOptions = {}): Promise<SessionState> {
  const res = await sessionFetch("/auth/session", { method: "GET" }, options);
  const raw = await readJson<Record<string, unknown>>(res);
  if (raw["authenticated"] !== true) return { authenticated: false };
  return {
    authenticated: true,
    wallet: requireString(raw["wallet"], "wallet"),
    issuedAt: requireNumber(raw["issuedAt"], "issuedAt"),
    expiresAt: requireNumber(raw["expiresAt"], "expiresAt"),
  };
}

/** POST /auth/logout — revoke + clear the session cookie. */
export async function logout(options: SessionFetchOptions = {}): Promise<void> {
  const res = await sessionFetch("/auth/logout", { method: "POST" }, options);
  await readJson<Record<string, unknown>>(res);
}

/**
 * Full sign-in: challenge -> wallet personal_sign -> verify -> session.
 * Wallet connection alone never authenticates; only a valid signature over the
 * server-issued message does.
 */
export async function signIn(
  signer: SessionSigner,
  options: SessionFetchOptions & { readonly chainId?: number } = {},
): Promise<AuthSession> {
  if (!signer || typeof signer.address !== "string" || signer.address === "") {
    throw new ApiError(0, "signIn requires a connected wallet address");
  }
  if (typeof signer.signMessage !== "function") throw new ApiError(0, "signIn requires signer.signMessage");
  const chainId = options.chainId ?? DEFAULT_CHAIN_ID;
  const issued = await requestChallenge(signer.address, chainId, options);
  const signature = await signer.signMessage(issued.message);
  await verifyChallenge(
    { nonce: issued.challenge.nonce, wallet: signer.address, signature, chainId },
    options,
  );
  const session = await getSession(options);
  if (!session.authenticated) throw new ApiError(0, "Session was not established after verify");
  return session;
}

/** True when an error is a 401 that should trigger re-authentication. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Default chain id used when the caller does not supply one. */
export const DEFAULT_CHAIN_ID = 8453;
