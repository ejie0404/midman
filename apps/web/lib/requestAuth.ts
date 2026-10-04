// Signed-request auth for evidence / category / message routes (Midman V1).
// Headers: x-wallet-address, x-wallet-expiry (unix s, <=15min out),
// x-wallet-signature = EIP-191 personal_sign of the UTF-8 string
//   `${METHOD}\n${path}\n${sha256hex(bodyBytes)}\n${expiry}`
// where bodyBytes are the exact raw request bytes (GET/DELETE sign the empty
// hash). `path` is the origin-relative path INCLUDING any query string, so it
// must be byte-identical to what is sent on the wire.
//
// Only erasable TypeScript is used so Node 24 can import this file directly
// in tests.

import { sha256hex } from "./evidence.ts";

/** Wallet signer. `address` is the expected x-wallet-address value. */
export interface RequestSigner {
  readonly address: string;
  signMessage(message: string): Promise<string>;
}

export interface SignRequestOptions {
  /** Seconds from now until expiry. Default 300. Must be in (0, 900]. */
  readonly expiresInSec?: number;
  /** Unix seconds to base expiry on (tests). Defaults to Date.now(). */
  readonly nowSec?: number;
}

export interface SignedRequest {
  readonly headers: Record<string, string>;
  /** Exact UTF-8 string that was personal_signed. */
  readonly message: string;
  readonly expiry: number;
  readonly bodyHash: string;
  readonly address: string;
}

/** Server rejects expiries more than 15 minutes out. */
export const MAX_AUTH_WINDOW_SEC = 900;

/** Default expiry horizon (5 minutes — comfortably inside the 15-min cap). */
export const DEFAULT_AUTH_WINDOW_SEC = 300;

export async function signRequest(
  signer: RequestSigner,
  method: string,
  path: string,
  bodyBytes?: Uint8Array | string,
  opts?: SignRequestOptions,
): Promise<SignedRequest> {
  if (!signer || typeof signer.address !== "string" || signer.address === "") {
    throw new Error("signRequest: signer address is missing");
  }
  if (typeof signer.signMessage !== "function") {
    throw new Error("signRequest: signer.signMessage is missing");
  }
  const upper = method.toUpperCase();
  if (upper === "") throw new Error("signRequest: method is empty");
  if (!path.startsWith("/")) throw new Error("signRequest: path must be origin-relative (start with /)");
  const ttl = opts?.expiresInSec ?? DEFAULT_AUTH_WINDOW_SEC;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_AUTH_WINDOW_SEC) {
    throw new RangeError(`signRequest: expiresInSec must be an integer in (0, ${MAX_AUTH_WINDOW_SEC}]`);
  }
  const now = opts?.nowSec ?? Math.floor(Date.now() / 1_000);
  if (!Number.isInteger(now) || now <= 0) throw new RangeError("signRequest: nowSec must be integer unix seconds");
  const bodyHash = await sha256hex(bodyBytes ?? "");
  const expiry = now + ttl;
  const message = `${upper}\n${path}\n${bodyHash}\n${expiry}`;
  const signature = await signer.signMessage(message);
  return {
    headers: {
      "x-wallet-address": signer.address,
      "x-wallet-expiry": String(expiry),
      "x-wallet-signature": signature,
    },
    message,
    expiry,
    bodyHash,
    address: signer.address,
  };
}
