// Evidence upload validation (P-12): size cap, extension/MIME allowlist,
// magic-byte verification, and secret-pattern rejection.
//
// Import note: scanTextForSecrets lives in src/categories/secrets.ts (exact
// export `scanTextForSecrets(text): string[]`), owned by the parallel
// categories worker; this module statically imports it and does not stub it.
import { createHash } from "node:crypto";
import { scanTextForSecrets } from "../categories/secrets.js";

/** 25 MB hard cap (also enforced as the multipart fileSize limit). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface AllowedType {
  readonly ext: string;
  readonly mimes: readonly string[];
  /** Text types additionally have their BYTES scanned for secrets. */
  readonly text: boolean;
}

const ALLOWED: readonly AllowedType[] = [
  { ext: "png", mimes: ["image/png"], text: false },
  { ext: "jpg", mimes: ["image/jpeg"], text: false },
  { ext: "jpeg", mimes: ["image/jpeg"], text: false },
  { ext: "gif", mimes: ["image/gif"], text: false },
  { ext: "webp", mimes: ["image/webp"], text: false },
  { ext: "pdf", mimes: ["application/pdf"], text: false },
  { ext: "txt", mimes: ["text/plain"], text: true },
  { ext: "md", mimes: ["text/markdown", "text/plain"], text: true },
  { ext: "json", mimes: ["application/json", "text/plain"], text: true },
  { ext: "mp4", mimes: ["video/mp4"], text: false },
  { ext: "zip", mimes: ["application/zip"], text: false },
];

export interface UploadInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimetype: string;
  readonly description: string;
}

export interface UploadCheckResult {
  /** Always empty on success (non-empty findings throw instead). */
  readonly findings: readonly string[];
  readonly fileHash: string;
  readonly size: number;
  readonly ext: string;
}

export type UploadRejectedError = Error & { statusCode: number; findings?: string[] };

function reject(message: string, findings?: string[]): UploadRejectedError {
  const error = new Error(message) as UploadRejectedError;
  error.statusCode = 400;
  if (findings !== undefined) error.findings = findings;
  return error;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** Magic-byte verification for types where spoofing is cheap. Throws 400 on mismatch. */
export function checkMagicBytes(bytes: Uint8Array, ext: string): void {
  switch (ext) {
    case "png":
      if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        throw reject("Magic bytes do not match .png (expected PNG signature)");
      }
      break;
    case "jpg":
    case "jpeg":
      if (!startsWith(bytes, [0xff, 0xd8, 0xff])) {
        throw reject("Magic bytes do not match .jpg (expected JPEG SOI marker)");
      }
      break;
    case "gif": {
      const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
      if (header !== "GIF87a" && header !== "GIF89a") {
        throw reject("Magic bytes do not match .gif (expected GIF87a/GIF89a)");
      }
      break;
    }
    case "pdf":
      if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
        throw reject("Magic bytes do not match .pdf (expected %PDF-)");
      }
      break;
    case "zip":
      if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
        throw reject("Magic bytes do not match .zip (expected PK\\x03\\x04)");
      }
      break;
    default:
      break; // webp/mp4/txt/md/json: extension+MIME allowlist only
  }
}

/**
 * Validate an upload. Throws a 400 UploadRejectedError on size, extension,
 * MIME, or magic-byte violations, and on secret patterns (with `findings`
 * codes attached). Returns the sha256 fileHash on success.
 */
export function validateUpload(input: UploadInput): UploadCheckResult {
  const size = input.bytes.length;
  if (size === 0) throw reject("Upload is empty");
  if (size > MAX_UPLOAD_BYTES) {
    throw reject(`Upload exceeds 25MB limit (${size} bytes)`);
  }
  const ext = (input.filename.split(".").pop() ?? "").toLowerCase();
  const rule = ALLOWED.find((entry) => entry.ext === ext);
  if (!rule) throw reject(`Extension .${ext || "?"} is not in the allowlist`);
  if (!rule.mimes.includes(input.mimetype.toLowerCase())) {
    throw reject(`MIME ${input.mimetype} does not match extension .${ext}`);
  }
  checkMagicBytes(input.bytes, ext);

  const haystacks: string[] = [input.description ?? ""];
  if (rule.text) haystacks.push(Buffer.from(input.bytes).toString("utf8"));
  const findings = [...new Set(haystacks.flatMap((text) => scanTextForSecrets(text)))];
  if (findings.length > 0) {
    throw reject(`Upload rejected: secret patterns detected (${findings.join(",")})`, findings);
  }

  const fileHash = `0x${createHash("sha256").update(input.bytes).digest("hex")}`;
  return { findings: [], fileHash, size, ext };
}
