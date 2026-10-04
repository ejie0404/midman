// Wallet-domain login challenges (SIWE-style, EIP-191 personal_sign).
//
// Login signatures are NEVER financial authorization. The signed message is
// domain-separated from every EIP-712 financial action by (a) the fixed
// purpose sentence and (b) the SIWE text envelope below, and the server only
// accepts a signature over the exact message it issued. A signature produced
// for /auth/challenge must not verify as (or be replayable into) any
// request-signature or EIP-712 acceptance route.
//
// Message format (deterministic; newline-joined, no trailing newline):
//   `${domain} wants you to sign in with your Ethereum account:`
//   `${wallet}`
//   `` (blank)
//   `Midman sign-in only, no funds authorized`
//   `` (blank)
//   `URI: ${uri}`
//   `Version: 1`
//   `Chain ID: ${chainId}`
//   `Nonce: ${nonce}`
//   `Issued At: ${issuedAt ISO-8601}`
//   `Expiration Time: ${expiresAt ISO-8601}`
//
// Challenges are stored in-memory with a TTL (default 300s), are single-use
// (the nonce is consumed on the first successful verification), and are bound
// to domain + chainId + wallet. Expired, reused, unknown-domain, and
// chain-mismatched challenges are rejected.
import { randomBytes } from "node:crypto";
import { verifyMessage, type Address, type Hash } from "viem";
import { buildLoginChallenge, type LoginChallenge } from "../auth.js";

/** Frozen purpose sentence (specs/phase2-threat-model.md LoginChallenge). */
export const LOGIN_PURPOSE = "Midman sign-in only, no funds authorized" as const;

/** Default challenge lifetime in seconds. */
export const DEFAULT_CHALLENGE_TTL_SECONDS = 300;

/** Default login domain when MIDMAN_AUTH_DOMAIN / AUTH_DOMAIN are unset. */
export const DEFAULT_LOGIN_DOMAIN = "midman.local";

/** Default login URI when MIDMAN_AUTH_URI / AUTH_URI are unset. */
export function loginUri(domain: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["MIDMAN_AUTH_URI"] ?? env["AUTH_URI"];
  if (explicit && explicit.trim()) return explicit.trim();
  return `https://${domain}`;
}

/** Configured login domain (case-insensitive comparisons are done by callers). */
export function loginDomain(env: NodeJS.ProcessEnv = process.env): string {
  const value = env["MIDMAN_AUTH_DOMAIN"] ?? env["AUTH_DOMAIN"];
  return value && value.trim() ? value.trim() : DEFAULT_LOGIN_DOMAIN;
}

export interface StoredLoginChallenge extends LoginChallenge {
  readonly issuedAt: number;
  readonly uri: string;
  consumed: boolean;
}

const challenges = new Map<string, StoredLoginChallenge>();

/** 32-byte hex nonce (bytes32, per the frozen LoginChallenge schema). */
export function newChallengeNonce(): Hash {
  return `0x${randomBytes(32).toString("hex")}` as Hash;
}

/** Exact EIP-191 text signed for sign-in. Documented above; used by tests. */
export function buildLoginMessage(challenge: {
  domain: string;
  chainId: number;
  wallet: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  uri: string;
}): string {
  return [
    `${challenge.domain} wants you to sign in with your Ethereum account:`,
    challenge.wallet,
    "",
    LOGIN_PURPOSE,
    "",
    `URI: ${challenge.uri}`,
    "Version: 1",
    `Chain ID: ${challenge.chainId}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${new Date(challenge.issuedAt * 1_000).toISOString()}`,
    `Expiration Time: ${new Date(challenge.expiresAt * 1_000).toISOString()}`,
  ].join("\n");
}

export interface IssuedChallenge {
  readonly challenge: LoginChallenge;
  readonly message: string;
  readonly uri: string;
}

/** Issue + store a single-use login challenge and return the exact message. */
export function issueLoginChallenge(params: {
  domain: string;
  chainId: number;
  wallet: string;
  ttlSeconds?: number;
  nowSeconds?: number;
  uri?: string;
}): IssuedChallenge {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const ttl = params.ttlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new TypeError("ttlSeconds must be a positive integer");
  if (!Number.isInteger(params.chainId) || params.chainId <= 0) throw new TypeError("chainId must be a positive integer");
  const nonce = newChallengeNonce();
  const expiresAt = now + ttl;
  const uri = params.uri ?? loginUri(params.domain);
  const challenge = buildLoginChallenge(params.domain, params.chainId, params.wallet, nonce, expiresAt);
  const stored: StoredLoginChallenge = { ...challenge, issuedAt: now, uri, consumed: false };
  challenges.set(nonce.toLowerCase(), stored);
  return { challenge, message: buildLoginMessage(stored), uri };
}

/** Look up an issued challenge by nonce (case-insensitive hex). */
export function getStoredChallenge(nonce: string): StoredLoginChallenge | null {
  return challenges.get(nonce.toLowerCase()) ?? null;
}

export type LoginVerifyResult =
  | { readonly ok: true; readonly challenge: StoredLoginChallenge; readonly wallet: Address }
  | { readonly ok: false; readonly reason: string; readonly statusCode: number };

function reject(statusCode: number, reason: string): LoginVerifyResult {
  return { ok: false, statusCode, reason };
}

/**
 * Verify a login signature against a stored challenge and consume it.
 * Rejects: malformed nonce, unknown/reused/expired challenge, wrong wallet,
 * unknown domain (not the configured login domain), chain mismatch, and
 * invalid signature.
 */
export async function verifyLoginSignature(params: {
  nonce: string;
  wallet: string;
  signature: string;
  domain?: string;
  chainId?: number;
  expectedDomain?: string;
  expectedChainId?: number;
  nowSeconds?: number;
}): Promise<LoginVerifyResult> {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.nonce)) return reject(400, "Invalid challenge nonce");
  const stored = getStoredChallenge(params.nonce);
  if (!stored) return reject(401, "Unknown or already-used challenge");
  if (stored.consumed) return reject(401, "Challenge already used");
  if (now >= stored.expiresAt) {
    challenges.delete(params.nonce.toLowerCase());
    return reject(401, "Challenge expired");
  }
  const expectedDomain = params.expectedDomain ?? loginDomain();
  if (stored.domain !== expectedDomain) return reject(401, "Unknown challenge domain");
  if (params.expectedChainId !== undefined && stored.chainId !== params.expectedChainId) {
    return reject(401, "Challenge chain mismatch");
  }
  if (params.domain !== undefined && params.domain !== stored.domain) {
    return reject(401, "Challenge domain mismatch");
  }
  if (params.chainId !== undefined && params.chainId !== stored.chainId) {
    return reject(401, "Challenge chain mismatch");
  }
  if (params.wallet.toLowerCase() !== stored.wallet.toLowerCase()) {
    return reject(401, "Challenge wallet mismatch");
  }

  // Mark consumed before awaiting verification to close the replay race; reset
  // only if the signature itself is invalid.
  stored.consumed = true;
  let valid = false;
  try {
    valid = await verifyMessage({
      address: stored.wallet as Address,
      message: buildLoginMessage(stored),
      signature: params.signature as Hash,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    stored.consumed = false;
    return reject(401, "Invalid login signature");
  }
  challenges.delete(params.nonce.toLowerCase());
  return { ok: true, challenge: stored, wallet: stored.wallet as Address };
}

/** Test helper: clear all issued challenges. */
export function __resetChallengesForTests(): void {
  challenges.clear();
}
