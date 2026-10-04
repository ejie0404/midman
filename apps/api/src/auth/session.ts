// Signed session cookies for the wallet login flow.
//
// Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).
// The HMAC key is SESSION_SECRET. In production a missing SESSION_SECRET is a
// hard error; in development a loud warning is emitted and an insecure fixed
// secret is used so local/test runs work without configuration.
//
// Cookie: httpOnly + Secure + SameSite=Lax, Path=/. Sessions have an idle
// timeout (30m) and an absolute timeout (24h). The token carries the wallet,
// issuedAt, absolute expiresAt, lastSeen (idle anchor), and a random nonce.
// Rotation re-signs the token (fresh lastSeen) without extending absolute
// expiry. Revocation is an in-memory deny-list keyed by nonce, used by logout.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Address } from "viem";
import { getAuthPersistence } from "./persistence.js";

export const SESSION_COOKIE = "midman_session";
export const SESSION_IDLE_SECONDS = 30 * 60;
export const SESSION_ABSOLUTE_SECONDS = 24 * 60 * 60;
export const SESSION_ROTATE_AFTER_SECONDS = 5 * 60;
export const MIN_SESSION_SECRET_LENGTH = 16;

const DEV_SECRET = "midman-insecure-dev-session-secret";

export interface SessionPayload {
  readonly wallet: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly lastSeen: number;
  readonly nonce: string;
}

export interface Session {
  readonly wallet: Address;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly lastSeen: number;
  readonly nonce: string;
}

let warnedAboutSecret = false;

/** Resolve the HMAC secret, failing closed in production. */
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env["SESSION_SECRET"];
  if (secret && secret.length > 0) {
    if (secret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
    }
    return secret;
  }
  if (env["NODE_ENV"] === "production") {
    throw new Error("SESSION_SECRET is required in production");
  }
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn("[auth] SESSION_SECRET is not set; using an insecure development secret. Set SESSION_SECRET before production.");
  }
  return DEV_SECRET;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function sign(body: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(body).digest());
}

/** Sign a session payload into a cookie token. */
export function signSessionToken(payload: SessionPayload, secret: string = sessionSecret()): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body, secret)}`;
}

/** Verify + parse a session token; returns null for bad signature/shape. */
export function verifySessionToken(token: string, secret: string = sessionSecret()): SessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body, secret);
  const got = Buffer.from(mac, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (
      typeof parsed.wallet !== "string" ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.lastSeen !== "number" ||
      typeof parsed.nonce !== "string"
    ) {
      return null;
    }
    return {
      wallet: parsed.wallet,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
      lastSeen: parsed.lastSeen,
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
}

const revokedNonces = new Set<string>();

/** Revoke a session nonce (logout / compromise). Mirrored to AuthPersistence. */
export function revokeSessionNonce(nonce: string): void {
  revokedNonces.add(nonce);
  void getAuthPersistence().revokeSession(nonce);
}

export function isSessionNonceRevoked(nonce: string): boolean {
  return revokedNonces.has(nonce);
}

/** Rebuild the local deny-list from the durable adapter (restart / Phase 3). */
export async function hydrateSessionRevocations(): Promise<void> {
  const adapter = getAuthPersistence();
  if (typeof adapter.listRevokedSessions !== "function") return;
  for (const nonce of await adapter.listRevokedSessions()) revokedNonces.add(nonce);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/** Validate absolute + idle + revocation. */
export function isSessionValid(payload: SessionPayload, now: number = nowSeconds()): boolean {
  if (isSessionNonceRevoked(payload.nonce)) return false;
  if (now >= payload.expiresAt) return false;
  if (now - payload.lastSeen > SESSION_IDLE_SECONDS) return false;
  return true;
}

function cookieHeader(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.header("set-cookie", cookieHeader(token, maxAgeSeconds));
}

/** Issue a fresh session cookie for a wallet. Returns the session. */
export function issueSession(reply: FastifyReply, wallet: string, now: number = nowSeconds()): Session {
  const payload: SessionPayload = {
    wallet,
    issuedAt: now,
    expiresAt: now + SESSION_ABSOLUTE_SECONDS,
    lastSeen: now,
    nonce: randomBytes(16).toString("hex"),
  };
  setSessionCookie(reply, signSessionToken(payload), SESSION_ABSOLUTE_SECONDS);
  return { ...payload, wallet: wallet as Address };
}

/** Re-sign the same session with a fresh lastSeen (rotation; absolute preserved). */
export function rotateSession(reply: FastifyReply, session: Session, now: number = nowSeconds()): Session {
  const payload: SessionPayload = {
    wallet: session.wallet,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    lastSeen: now,
    nonce: session.nonce,
  };
  const maxAge = Math.max(0, session.expiresAt - now);
  setSessionCookie(reply, signSessionToken(payload), maxAge);
  return { ...payload, wallet: session.wallet };
}

/** Rotate at most once per SESSION_ROTATE_AFTER_SECONDS window. */
export function maybeRotateSession(reply: FastifyReply, session: Session, now: number = nowSeconds()): Session {
  if (now - session.lastSeen < SESSION_ROTATE_AFTER_SECONDS) return session;
  return rotateSession(reply, session, now);
}

/** Clear the session cookie. */
export function clearSession(reply: FastifyReply): void {
  reply.header("set-cookie", cookieHeader("", 0));
}

/** Parse a Cookie header into a name->value map (no dependencies). */
export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const rawValue = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(rawValue);
    } catch {
      out[name] = rawValue;
    }
  }
  return out;
}

function requestCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return null;
  return parseCookies(header)[name] ?? null;
}

/** Read + validate the session cookie from a request; null when absent/invalid. */
export function readSession(req: FastifyRequest, now: number = nowSeconds()): Session | null {
  const token = requestCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload || !isSessionValid(payload, now)) return null;
  return { ...payload, wallet: payload.wallet as Address };
}

/** Test helper: clear the revocation deny-list. */
export function __resetSessionsForTests(): void {
  revokedNonces.clear();
}
