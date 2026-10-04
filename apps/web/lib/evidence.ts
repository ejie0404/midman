// Evidence, category delivery-form, and message API wrappers (Midman V1).
// Signed-request auth is applied to every route per the endpoint contract:
//   x-wallet-address, x-wallet-expiry (unix s, <=15min out),
//   x-wallet-signature = EIP-191 personal_sign of
//   `${METHOD}\n${path}\n${sha256hex(bodyBytes)}\n${expiry}`
// (body = raw request bytes; GET/DELETE sign the empty hash).
//
// Uploads additionally bind the FILE CONTENT: the signature is the 5-line
// form `${METHOD}\n${path}\n${sha256hex('')}\n${contentSha256}\n${expiry}`
// (multipart boundaries are not canonical, so the body hash is the empty
// hash) and the exact `x-content-sha256` header carries sha256 of the file
// bytes. The server recomputes it over the received bytes and rejects a
// mismatch, so a signature cannot be replayed against different content.
//
// Defensive posture: the API routes may not be deployed yet (parallel workers
// own apps/api). Every helper throws ApiError carrying the HTTP status so UI
// can fall back gracefully on 404/501/503 and show "reviewer access pending"
// on 403. Pure helpers (sha256hex, secret prescreen, multipart encoder,
// delivery-form reducer) are unit-tested with mocked fetch.
//
// Only erasable TypeScript is used so Node 24 can import this file directly
// in tests (no enums, namespaces, or parameter properties).

import { API_BASE, ApiError } from "./api.ts";
import { signRequest } from "./requestAuth.ts";
import type { RequestSigner } from "./requestAuth.ts";

// ---- SHA-256 (Node tests/SSR via node:crypto, browser via WebCrypto) ----

/** Lowercase hex SHA-256 of the empty string (used for GET/DELETE bodies). */
export const EMPTY_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function toBytes(data: string | Uint8Array): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data;
}

interface NodeCryptoHash {
  update: (data: Uint8Array) => { digest: (encoding: string) => string };
}

interface NodeCryptoModule {
  createHash: (algorithm: string) => NodeCryptoHash;
}

/** SHA-256 over a UTF-8 string or raw bytes, returned as lowercase hex. */
export async function sha256hex(data: string | Uint8Array): Promise<string> {
  const bytes = toBytes(data);
  if (typeof window === "undefined") {
    // Server / Node tests. The specifier is resolved through an indirect
    // import so client bundlers never try to statically include node:crypto.
    const dynamicImport = Function("return import('node:crypto')") as () => Promise<NodeCryptoModule>;
    const nodeCrypto = await dynamicImport();
    return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("No SHA-256 provider available (WebCrypto subtle is missing)");
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Client-side secret prescreen (warning only; server is authoritative) ----

export interface SecretPattern {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Light client-side patterns. These warn, never block: the server rescan is
 * authoritative. The bare 0x 32-byte pattern intentionally requires key
 * context words so pasted file hashes do not false-positive.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "private-key-pem",
    label: "PEM private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    id: "aws-access-key",
    label: "AWS-style access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: "api-secret",
    label: "sk- style API secret",
    pattern: /\bsk-(?:live|test)-[A-Za-z0-9_-]{8,}\b|\bsk_[A-Za-z0-9_-]{16,}\b/,
  },
  {
    id: "hex-private-key",
    label: "0x private key (with key context)",
    pattern: /(?:private[\s_-]?key|secret[\s_-]?key|mnemonic|seed)[\s\S]{0,60}\b0x[0-9a-fA-F]{64}\b|\b0x[0-9a-fA-F]{64}\b[\s\S]{0,60}(?:private[\s_-]?key|secret[\s_-]?key)/i,
  },
  {
    id: "seed-phrase",
    label: "possible seed / recovery phrase",
    pattern: /\b(?:mnemonic|seed phrase|recovery phrase)\b/i,
  },
];

export interface PrescreenResult {
  readonly hit: boolean;
  /** Pattern ids that matched. The secret itself is never echoed back. */
  readonly matched: readonly string[];
}

/** Scan free text for credential-looking content. Warning only. */
export function prescreenSecrets(text: string): PrescreenResult {
  const matched: string[] = [];
  for (const entry of SECRET_PATTERNS) {
    // Reset in case a pattern is ever global; ours are not, but be safe.
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(text)) matched.push(entry.id);
  }
  return { hit: matched.length > 0, matched };
}

// ---- Upload pre-checks (client-side; server scan is authoritative) ----

/** Hard client cap: evidence files larger than this are rejected before upload. */
export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

/** Executable extensions blocked client-side (server rescan decides finally). */
export const BLOCKED_UPLOAD_EXTENSIONS: readonly string[] = [
  "exe",
  "dll",
  "msi",
  "bat",
  "cmd",
  "ps1",
  "scr",
  "com",
  "cpl",
  "msc",
];

export interface UploadFileMeta {
  readonly name: string;
  readonly sizeBytes: number;
}

export type UploadValidation = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function validateUploadFile(file: UploadFileMeta): UploadValidation {
  if (file.sizeBytes <= 0) return { ok: false, error: "File is empty." };
  if (file.sizeBytes > MAX_EVIDENCE_BYTES) {
    return { ok: false, error: `File exceeds the 25 MB client limit (${file.sizeBytes} bytes).` };
  }
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot + 1).toLowerCase();
  if (ext && BLOCKED_UPLOAD_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `Executable type .${ext} is blocked. Upload a document, archive, or media file instead.` };
  }
  return { ok: true };
}

// ---- Multipart encoder (exact raw bytes, so the signature matches) ----

export interface MultipartFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface EncodedMultipart {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly boundary: string;
}

function randomBoundary(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `----midman-${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "upload.bin";
  return base.replace(/["\r\n]/g, "_").slice(0, 180) || "upload.bin";
}

/**
 * Encode multipart/form-data with a known boundary and return the EXACT raw
 * bytes. The signed-request scheme hashes raw request bytes, which the
 * browser will not reveal for a FormData object — so we build the body
 * manually and sign these bytes. Pass `boundary` in tests for determinism.
 */
export function encodeMultipartForm(args: {
  readonly fields: Record<string, string>;
  readonly fileField: string;
  readonly file: MultipartFile;
  readonly boundary?: string;
}): EncodedMultipart {
  const boundary = args.boundary ?? randomBoundary();
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const push = (text: string): void => {
    chunks.push(encoder.encode(text));
  };
  for (const [name, value] of Object.entries(args.fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${args.fileField}"; filename="${sanitizeFilename(args.file.name)}"\r\nContent-Type: ${args.file.contentType || "application/octet-stream"}\r\n\r\n`,
  );
  chunks.push(args.file.bytes);
  push(`\r\n--${boundary}--\r\n`);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}

/** Read a browser File/Blob into bytes for uploadEvidence. */
export async function fileToBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

// ---- Category + delivery-form types and reducer ----

export type CategoryFieldType = "text" | "textarea" | "number" | "select" | "date";

export interface CategoryFieldDef {
  readonly name: string;
  readonly label: string;
  readonly type: CategoryFieldType;
  readonly required: boolean;
  readonly maxLen?: number;
  readonly options?: readonly string[];
  readonly placeholder?: string;
}

export interface CategoryDef {
  readonly id: string;
  readonly minInspection: number;
  readonly fields: readonly CategoryFieldDef[];
  readonly completionCriteria: string;
}

export interface DeliveryFormState {
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly serverErrors: readonly string[];
}

export type DeliveryFormAction =
  | { readonly type: "init" }
  | { readonly type: "clear" }
  | { readonly type: "set"; readonly name: string; readonly value: string }
  | { readonly type: "validate"; readonly category: CategoryDef }
  | { readonly type: "serverErrors"; readonly errors: readonly string[] };

export function createInitialDeliveryForm(): DeliveryFormState {
  return { values: {}, errors: {}, serverErrors: [] };
}

/** Pure field validation: required, maxLen, and numeric shape. */
export function validateDeliveryForm(
  category: CategoryDef,
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of category.fields) {
    const raw = values[field.name] ?? "";
    const value = raw.trim();
    if (field.required && value === "") {
      errors[field.name] = `${field.label} is required.`;
      continue;
    }
    if (value === "") continue;
    if (field.maxLen !== undefined && value.length > field.maxLen) {
      errors[field.name] = `${field.label} must be at most ${field.maxLen} characters.`;
      continue;
    }
    if (field.type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) {
      errors[field.name] = `${field.label} must be a number.`;
      continue;
    }
    if (field.type === "select" && field.options && !field.options.includes(value)) {
      errors[field.name] = `${field.label} must be one of the listed options.`;
    }
  }
  return errors;
}

export function deliveryFormReducer(state: DeliveryFormState, action: DeliveryFormAction): DeliveryFormState {
  switch (action.type) {
    case "init":
    case "clear":
      return createInitialDeliveryForm();
    case "set": {
      const values = { ...state.values, [action.name]: action.value };
      const errors = { ...state.errors };
      delete errors[action.name];
      return { values, errors, serverErrors: state.serverErrors };
    }
    case "validate":
      return { values: state.values, errors: validateDeliveryForm(action.category, state.values), serverErrors: [] };
    case "serverErrors":
      return { values: state.values, errors: state.errors, serverErrors: [...action.errors] };
  }
}

// ---- Evidence / message result types ----

export interface EvidenceManifestEntry {
  readonly seq: number;
  readonly fileHash: string;
  readonly prevHash: string;
  readonly kind: string;
  readonly description: string;
  readonly uploader: string;
  readonly uploadedAt: string;
  readonly scan: string;
}

export interface EvidenceManifestResult {
  readonly manifest: readonly EvidenceManifestEntry[];
  readonly head: string;
}

export interface EvidenceReceiptResult {
  readonly fileHash: string;
  readonly seq: number;
  readonly commitment: string;
  readonly receipt: Record<string, unknown>;
}

export interface UploadEvidenceResult {
  readonly seq: number;
  readonly fileHash: string;
  readonly commitment: string;
  readonly receipt: Record<string, unknown>;
  readonly scan: string;
}

export interface UploadEvidenceInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly fileBytes: Uint8Array;
  readonly kind: string;
  readonly description: string;
}

export interface EvidenceDownload {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

export interface ExportBundle {
  readonly raw: string;
  readonly json: unknown;
}

export interface RestoreCheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ChatMessage {
  readonly seq: number;
  readonly author: string;
  readonly text: string;
  readonly at: string;
}

export interface DeliveryFormResult {
  readonly ok: boolean;
  readonly deliveryManifestHash: string;
}

export interface EvidencePayloadResult {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, unknown>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
  readonly calldata: string;
}

export class DeliveryFormError extends ApiError {
  readonly errors: readonly string[];
  constructor(status: number, body: string, errors: readonly string[]) {
    super(status, body);
    this.name = "DeliveryFormError";
    this.errors = errors;
  }
}

// ---- Status helpers + shared copy ----

/** The endpoint is not deployed (or moved): UI should fall back, not crash. */
export function isEndpointMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501 || error.status === 503);
}

/** 403 on signed routes: non-party, or reviewer allowlist has not cleared you. */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export const REVIEWER_PENDING_COPY =
  "Access denied (403). If you are a reviewer, your reviewer access is still pending allowlist approval; " +
  "if you are not a deal party, evidence and messages are not visible to you.";

export const NO_CREDENTIALS_UPLOAD_COPY =
  "Do not upload or describe secrets: no seed phrases, private keys, passwords, or API tokens " +
  "in files, file names, or descriptions. Automated prescreen warnings are advisory only — " +
  "the server scan is authoritative.";

export const NO_CREDENTIALS_MESSAGE_COPY =
  "Messages are visible to deal parties (and reviewers on dispute). Never post seed phrases, " +
  "private keys, passwords, or API tokens here.";

export const NO_CREDENTIALS_DELIVERY_COPY =
  "Do not enter wallet seed phrases, private keys, or passwords in this form. " +
  "Only include the delivery details the buyer needs to verify completion.";

export const EVIDENCE_CUTOFF_COPY =
  "Evidence cutoff: only what the on-chain manifest hash commits to counts. " +
  "Upload every delivery file BEFORE the seller marks delivered — files added afterwards " +
  "are not covered by the committed manifest and will not match on-chain verification.";

export const MAX_MESSAGE_LEN = 2000;

/** Shorten a 0x hash for badges: 0x12345678…9abcdef0. */
export function shortHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

// ---- Signed fetch core ----

function extractMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // keep raw text
  }
  return text;
}

async function requestSigned<T>(args: {
  readonly auth: RequestSigner;
  readonly method: string;
  readonly path: string;
  readonly rawBody?: Uint8Array | undefined;
  /** Bytes covered by the signature. Defaults to rawBody. Multipart uploads
   * must sign the EMPTY body (server rule: boundaries are not canonical). */
  readonly signBody?: Uint8Array | undefined;
  /** sha256 (lowercase hex) of the file content; binds an upload to its bytes. */
  readonly contentSha256?: string | undefined;
  readonly contentType?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<T> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let headers: Record<string, string>;
  if (args.contentSha256 !== undefined) {
    // Content-bound upload signature (5-line). Multipart bodies are not
    // canonical, so the body hash is the empty-string hash.
    const expiry = Math.floor(Date.now() / 1_000) + 300;
    const bodyHash = await sha256hex(args.signBody ?? args.rawBody ?? new Uint8Array(0));
    const message = `${args.method.toUpperCase()}\n${args.path}\n${bodyHash}\n${args.contentSha256}\n${expiry}`;
    const signature = await args.auth.signMessage(message);
    headers = {
      "x-wallet-address": args.auth.address,
      "x-wallet-expiry": String(expiry),
      "x-wallet-signature": signature,
      "x-content-sha256": args.contentSha256,
    };
  } else {
    const signed = await signRequest(args.auth, args.method, args.path, args.signBody ?? args.rawBody);
    headers = { ...signed.headers };
  }
  if (args.contentType !== undefined) headers["content-type"] = args.contentType;
  const init: RequestInit = { method: args.method.toUpperCase(), headers };
  if (args.rawBody !== undefined) init.body = args.rawBody as BodyInit;
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${args.path}`, init);
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
  }
  const text = await res.text();
  if (args.method.toUpperCase() === "POST" && args.path.endsWith("/delivery-form") && res.status === 400) {
    let errors: readonly string[] = [text || "Delivery form rejected."];
    try {
      const parsed = JSON.parse(text) as { errors?: unknown };
      if (Array.isArray(parsed.errors)) errors = parsed.errors.map(String);
    } catch {
      // keep default
    }
    throw new DeliveryFormError(res.status, extractMessage(text), errors);
  }
  if (!res.ok) throw new ApiError(res.status, extractMessage(text));
  return (text ? JSON.parse(text) : {}) as T;
}

async function getSigned<T>(path: string, auth: RequestSigner, fetchImpl?: typeof fetch): Promise<T> {
  return requestSigned<T>({ auth, method: "GET", path, fetchImpl });
}

async function postSignedJson<T>(
  path: string,
  body: Record<string, unknown>,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const raw = JSON.stringify(body);
  return requestSigned<T>({
    auth,
    method: "POST",
    path,
    rawBody: new TextEncoder().encode(raw),
    contentType: "application/json",
    fetchImpl,
  });
}

function normalizeList<T>(payload: unknown): readonly T[] {
  if (Array.isArray(payload)) return payload as readonly T[];
  if (payload && typeof payload === "object") {
    const inner = (payload as Record<string, unknown>)["messages"] ?? (payload as Record<string, unknown>)["manifest"];
    if (Array.isArray(inner)) return inner as readonly T[];
  }
  return [];
}

// ---- Endpoint wrappers (exactly per contract) ----

/** GET /categories — signed. Throws ApiError(404/…) when not yet deployed. */
export function fetchCategories(auth: RequestSigner, fetchImpl?: typeof fetch): Promise<readonly CategoryDef[]> {
  return getSigned<readonly CategoryDef[]>("/categories", auth, fetchImpl);
}

/**
 * POST /deals/:dealId/delivery-form — signed JSON body `{ category, data }`;
 * a 400 `{ errors[] }` surfaces as DeliveryFormError.
 */
export function submitDeliveryForm(
  dealId: string,
  category: string,
  values: Record<string, string>,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<DeliveryFormResult> {
  return postSignedJson<DeliveryFormResult>(
    `/deals/${encodeURIComponent(dealId)}/delivery-form`,
    { category, data: values },
    auth,
    fetchImpl,
  );
}

/**
 * POST /deals/:dealId/evidence — multipart upload. Per server rule the
 * signature covers the EMPTY body (multipart boundaries are not canonical);
 * integrity comes from the sha256 file hash + server receipt.
 */
export async function uploadEvidence(
  dealId: string,
  input: UploadEvidenceInput,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<UploadEvidenceResult> {
  const checked = validateUploadFile({ name: input.fileName, sizeBytes: input.fileBytes.length });
  if (!checked.ok) throw new Error(checked.error);
  if (!input.kind.trim()) throw new Error("Evidence kind is required.");
  const encoded = encodeMultipartForm({
    fields: { kind: input.kind, description: input.description },
    fileField: "file",
    file: { name: input.fileName, contentType: input.contentType, bytes: input.fileBytes },
  });
  const contentSha256 = await sha256hex(input.fileBytes);
  return requestSigned<UploadEvidenceResult>({
    auth,
    method: "POST",
    path: `/deals/${encodeURIComponent(dealId)}/evidence`,
    rawBody: encoded.body,
    signBody: new Uint8Array(0),
    contentSha256,
    contentType: encoded.contentType,
    fetchImpl,
  });
}

/** GET /deals/:dealId/evidence — signed. Returns the chained manifest + head. */
export async function fetchManifest(
  dealId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<EvidenceManifestResult> {
  const payload = await getSigned<{ manifest: readonly EvidenceManifestEntry[]; head: string }>(
    `/deals/${encodeURIComponent(dealId)}/evidence`,
    auth,
    fetchImpl,
  );
  return { manifest: normalizeList<EvidenceManifestEntry>(payload.manifest ?? payload), head: payload.head ?? "" };
}

/** GET /evidence/:fileHash/receipt?dealId= — signed. */
export function fetchReceipt(
  fileHash: string,
  dealId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<EvidenceReceiptResult> {
  return getSigned<EvidenceReceiptResult>(
    `/evidence/${encodeURIComponent(fileHash)}/receipt?dealId=${encodeURIComponent(dealId)}`,
    auth,
    fetchImpl,
  );
}

/** GET /evidence/:fileHash?dealId= — signed blob download. */
export async function downloadEvidence(
  fileHash: string,
  dealId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<EvidenceDownload> {
  const impl = fetchImpl ?? fetch;
  const path = `/evidence/${encodeURIComponent(fileHash)}?dealId=${encodeURIComponent(dealId)}`;
  const signed = await signRequest(auth, "GET", path);
  let res: Response;
  try {
    res = await impl(`${API_BASE}${path}`, { method: "GET", headers: signed.headers });
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
  }
  if (!res.ok) throw new ApiError(res.status, extractMessage(await res.text()));
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get("content-type") };
}

/** GET /deals/:dealId/export — signed JSON bundle (caller triggers download). */
export async function fetchExportBundle(
  dealId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<ExportBundle> {
  const impl = fetchImpl ?? fetch;
  const path = `/deals/${encodeURIComponent(dealId)}/export`;
  const signed = await signRequest(auth, "GET", path);
  let res: Response;
  try {
    res = await impl(`${API_BASE}${path}`, { method: "GET", headers: signed.headers });
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? `Network unreachable: ${error.message}` : "Network unreachable");
  }
  const raw = await res.text();
  if (!res.ok) throw new ApiError(res.status, extractMessage(raw));
  return { raw, json: (raw ? JSON.parse(raw) : {}) as unknown };
}

/**
 * POST /deals/:dealId/restore-check — signed empty-object body.
 * Assumption: route path + `{}` body; a 404 falls back to a UI notice.
 */
export async function postRestoreCheck(
  dealId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<RestoreCheckResult> {
  const payload = await postSignedJson<{ ok: boolean; detail?: unknown }>(
    `/deals/${encodeURIComponent(dealId)}/restore-check`,
    {},
    auth,
    fetchImpl,
  );
  return { ok: payload.ok === true, detail: typeof payload.detail === "string" ? payload.detail : "" };
}

/** GET /deals/:dealId/messages — signed. Accepts a bare array or {messages}. */
export async function fetchMessages(
  dealId: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<readonly ChatMessage[]> {
  const payload = await getSigned<readonly ChatMessage[] | { messages: readonly ChatMessage[] }>(
    `/deals/${encodeURIComponent(dealId)}/messages`,
    auth,
    fetchImpl,
  );
  return normalizeList<ChatMessage>(payload);
}

/** POST /deals/:dealId/messages {text} — signed. Enforces the 2000-char cap. */
export async function postMessage(
  dealId: string,
  text: string,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<ChatMessage> {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Message is empty.");
  if (trimmed.length > MAX_MESSAGE_LEN) {
    throw new Error(`Message exceeds ${MAX_MESSAGE_LEN} characters.`);
  }
  return postSignedJson<ChatMessage>(
    `/deals/${encodeURIComponent(dealId)}/messages`,
    { text: trimmed },
    auth,
    fetchImpl,
  );
}

/**
 * POST /deals/:dealId/evidence/payload — signed. Full commitment input:
 * uploader/sequence/prevCommitment/fileHashes/metadataCommitment/nonce/
 * expiresAt (+ agreementDigest from the signed-term download when known).
 */
export interface EvidencePayloadInput {
  readonly uploader: string;
  readonly sequence: number;
  readonly prevCommitment: string;
  readonly fileHashes: readonly string[];
  readonly metadataCommitment: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly agreementDigest?: string | undefined;
}

export function postEvidencePayload(
  dealId: string,
  input: EvidencePayloadInput,
  auth: RequestSigner,
  fetchImpl?: typeof fetch,
): Promise<EvidencePayloadResult> {
  const body: Record<string, unknown> = {
    uploader: input.uploader,
    sequence: input.sequence,
    prevCommitment: input.prevCommitment,
    fileHashes: [...input.fileHashes],
    metadataCommitment: input.metadataCommitment,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
  };
  if (input.agreementDigest !== undefined) body["agreementDigest"] = input.agreementDigest;
  return postSignedJson<EvidencePayloadResult>(
    `/deals/${encodeURIComponent(dealId)}/evidence/payload`,
    body,
    auth,
    fetchImpl,
  );
}
