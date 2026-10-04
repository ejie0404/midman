// Wallet-domain authentication. Login signatures are NEVER financial authorization.
// Challenge: domain + chainId + wallet + nonce + expiry. Verification via viem
// is wired against a live RPC in Phase 6; this module owns format + replay rules.
export interface LoginChallenge {
  readonly domain: string;
  readonly chainId: number;
  readonly wallet: string;
  readonly nonce: string;
  readonly expiresAt: number; // integer chain seconds
  readonly purpose: "Midman sign-in only, no funds authorized";
}

export function buildLoginChallenge(domain: string, chainId: number, wallet: string, nonce: string, expiresAt: number): LoginChallenge {
  if (!Number.isInteger(expiresAt)) throw new TypeError("expiresAt must be integer seconds");
  return { domain, chainId, wallet, nonce, expiresAt, purpose: "Midman sign-in only, no funds authorized" };
}

export function isChallengeFresh(challenge: LoginChallenge, nowSeconds: number): boolean {
  return Number.isInteger(nowSeconds) && nowSeconds < challenge.expiresAt;
}

// Operational roles (P-15). Isolated credentials per role; enforced at router level.
export const OPERATIONAL_ROLES = [
  "pauser",
  "arbitration",
  "veto",
  "relay",
  "governance",
  "feeRecipient",
] as const;
export type OperationalRole = (typeof OPERATIONAL_ROLES)[number];
