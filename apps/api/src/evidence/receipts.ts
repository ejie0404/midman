// Server ECDSA evidence receipts + malware-scan hook.
// Receipt payload: `MidmanReceipt|${dealId}|${seq}|${fileHash}`, signed by
// the server key (RECEIPT_SIGNER_KEY; else an ephemeral dev key + warning).
// Anyone can offline-verify via viem recoverMessageAddress.
//
// Malware: ClamAV TCP INSTREAM when CLAMAV_HOST is set (minimal protocol:
// `zINSTREAM\0`, then 4-byte-BE-length-prefixed chunks, zero-length
// terminator; parse FOUND/OK/ERROR). Otherwise the scan status is honestly
// recorded as 'deferred' — never claimed as scanned-when-not.
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { recoverMessageAddress, type Address, type Hash } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface ReceiptInput {
  readonly dealId: string;
  readonly seq: number;
  readonly fileHash: string;
}

export interface SignedReceipt {
  readonly payload: string;
  readonly signature: Hash;
  readonly signer: Address;
}

let cachedSigner: PrivateKeyAccount | null = null;
let cachedSignerSource: string | null = null;
let warnedEphemeralSigner = false;

function loadSignerAccount(): PrivateKeyAccount {
  const key = (process.env["RECEIPT_SIGNER_KEY"] ?? "").trim();
  if (key !== "") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error("RECEIPT_SIGNER_KEY must be 0x + 64 hex chars");
    }
    if (!cachedSigner || cachedSignerSource !== key.toLowerCase()) {
      cachedSigner = privateKeyToAccount(key as Hash);
      cachedSignerSource = key.toLowerCase();
    }
    return cachedSigner;
  }
  if (!cachedSigner || cachedSignerSource !== "ephemeral") {
    cachedSigner = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}` as Hash);
    cachedSignerSource = "ephemeral";
    if (!warnedEphemeralSigner) {
      warnedEphemeralSigner = true;
      console.warn("[evidence] RECEIPT_SIGNER_KEY unset: using ephemeral dev signer (receipts will not verify after restart)");
    }
  }
  return cachedSigner;
}

/** Test-only reset for the signer cache. */
export function __resetReceiptSignerForTests(): void {
  cachedSigner = null;
  cachedSignerSource = null;
  warnedEphemeralSigner = false;
}

export function receiptPayload(input: ReceiptInput): string {
  return `MidmanReceipt|${input.dealId}|${input.seq}|${input.fileHash}`;
}

export async function signReceipt(input: ReceiptInput): Promise<SignedReceipt> {
  const account = loadSignerAccount();
  const payload = receiptPayload(input);
  const signature = (await account.signMessage({ message: payload })) as Hash;
  return { payload, signature, signer: account.address };
}

export async function verifyReceipt(receipt: SignedReceipt, expectedSigner?: string): Promise<{
  valid: boolean;
  recovered: Address;
}> {
  const recovered = await recoverMessageAddress({ message: receipt.payload, signature: receipt.signature });
  const matchesRecovery = recovered.toLowerCase() === receipt.signer.toLowerCase();
  const matchesExpected =
    expectedSigner === undefined || recovered.toLowerCase() === expectedSigner.toLowerCase();
  return { valid: matchesRecovery && matchesExpected, recovered };
}

// ---- Malware hook (ClamAV INSTREAM) ----

export type MalwareStatus = "clean" | "infected" | "deferred" | "error";

export interface MalwareScan {
  readonly status: MalwareStatus;
  readonly detail: string;
}

function parseClamResponse(text: string): MalwareScan {
  const trimmed = text.trim();
  if (/FOUND/.test(trimmed)) return { status: "infected", detail: trimmed };
  if (/stream:\s*OK/.test(trimmed) || /\bOK\b/.test(trimmed)) return { status: "clean", detail: trimmed };
  return { status: "error", detail: trimmed === "" ? "Empty ClamAV response" : trimmed };
}

function scanViaClamAv(host: string, port: number, bytes: Uint8Array): Promise<MalwareScan> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: MalwareScan): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // ignore teardown errors
      }
      resolve(result);
    };
    const timer = setTimeout(() => done({ status: "error", detail: "ClamAV scan timed out" }), 10_000);
    const chunks: Buffer[] = [];
    const socket = connect(port, host);
    socket.on("connect", () => {
      socket.write("zINSTREAM\0", () => {
        const buf = Buffer.from(bytes);
        for (let offset = 0; offset < buf.length; offset += 8192) {
          const slice = buf.subarray(offset, Math.min(offset + 8192, buf.length));
          const lengthPrefix = Buffer.alloc(4);
          lengthPrefix.writeUInt32BE(slice.length, 0);
          socket.write(Buffer.concat([lengthPrefix, slice]));
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
      });
    });
    socket.on("data", (data: Buffer) => {
      chunks.push(Buffer.from(data));
    });
    socket.on("close", () => {
      done(parseClamResponse(Buffer.concat(chunks).toString("utf8")));
    });
    socket.on("error", (error: Error) => {
      done({ status: "error", detail: `ClamAV connection failed: ${error.message}` });
    });
  });
}

/**
 * Malware scan entry point. Without CLAMAV_HOST the result is honestly
 * 'deferred' (recorded in the manifest as such).
 */
export async function scanBytes(bytes: Uint8Array, _filename = "upload.bin"): Promise<MalwareScan> {
  // Test/harness seam: force a verdict without a ClamAV socket (no network).
  const forced = (process.env["EVIDENCE_SCAN_FORCE"] ?? "").trim();
  if (forced === "clean" || forced === "infected" || forced === "deferred" || forced === "error") {
    return { status: forced, detail: `forced by EVIDENCE_SCAN_FORCE=${forced} (no scan performed)` };
  }
  const host = (process.env["CLAMAV_HOST"] ?? "").trim();
  if (host === "") {
    return { status: "deferred", detail: "CLAMAV_HOST unset; scan deferred (never claimed as scanned)" };
  }
  const port = Number(process.env["CLAMAV_PORT"] ?? 3310);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { status: "error", detail: `Invalid CLAMAV_PORT: ${process.env["CLAMAV_PORT"]}` };
  }
  return scanViaClamAv(host, port, bytes);
}
