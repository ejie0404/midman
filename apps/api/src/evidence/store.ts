// Encrypted evidence blob store (P-12/P-13).
// AES-256-GCM file encryption with a per-deal random DEK, envelope-wrapped
// by a KEK. KEK source: EVIDENCE_KEK_HEX (required 64-hex when set);
// otherwise an ephemeral in-memory KEK is used with a dev-only console
// warning (restarts lose keys — never for production). In production a
// durable KEK is REQUIRED: loadKEK throws rather than silently going ephemeral.
//
// Key creation is atomic + convergent: the wrapped per-deal DEK is written
// with an exclusive primitive (local: `wx`; S3: `If-None-Match: *`), then
// whatever was persisted is read back and used, so concurrent first uploads
// converge on ONE key instead of overwriting each other. A single-flight
// in-process lock coalesces concurrent creators for the same dealId.
//
// Key rotation (Round-2 Phase 6): rotateKek(newKekId, newKek) registers the
// new KEK, re-wraps every known DEK under it, and keeps a keyring keyed by the
// `kekId` recorded in each envelope. The KID -> wrapped-KEK history is
// PERSISTED (`_keyring.json` locally, `_keys/_keyring.json` in S3) so the
// mapping survives a restart and does NOT rely on env-only EVIDENCE_KEK_HISTORY
// (which remains a fallback). Envelopes are updated atomically
// (write-temp-then-rename locally; temp-put + copy + delete in S3) and an
// on-disk/S3 rotation-progress record lets an interrupted rotation resume.
//
// Layout (local): <EVIDENCE_DIR>/<dealId>/<fileHash>.enc (iv||tag||ciphertext)
//                 <EVIDENCE_DIR>/<dealId>.dek.json   (wrapped per-deal DEK)
//                 <EVIDENCE_DIR>/_keyring.json       (KID -> wrapped KEK)
//                 <EVIDENCE_DIR>/_rotation.json      (rotation progress)
// S3 layout mirrors this: <dealId>/<fileHash>.enc + _keys/<dealId>.dek.json.
// Selector: S3_BUCKET set -> S3EncryptedStore (PutObject/GetObject/
// DeleteObject/ListObjectsV2/CopyObject, forcePathStyle honoring S3_ENDPOINT),
// else LocalEncryptedStore.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { access as fsAccess, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface BackupEnvelope {
  readonly dealId: string;
  readonly dekWrapped: string;
  readonly kekId: string;
}

export interface KeyRotationResult {
  readonly kekId: string;
  readonly rotated: string[];
}

export interface KeyRotationProgress {
  readonly newKekId: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly rotated: readonly string[];
  readonly complete: boolean;
}

export interface EncryptedBlobStore {
  put(dealId: string, fileHash: string, bytes: Uint8Array): Promise<void>;
  get(dealId: string, fileHash: string): Promise<Buffer | null>;
  exists(dealId: string, fileHash: string): Promise<boolean>;
  delete(dealId: string, fileHash: string): Promise<void>;
  /**
   * Return the canonical wrapped per-deal DEK. Creates it exactly once with an
   * atomic if-not-exists primitive, reading back the winner on a lost race so
   * concurrent creators converge on a single key.
   */
  getOrCreateDek(dealId: string): Promise<BackupEnvelope>;
  /**
   * Register `newKek` (32 bytes) under `newKekId`, make it active, and re-wrap
   * every known DEK under it. Previously wrapped DEKs stay resolvable by the
   * `kekId` recorded in their envelope (historical keys preserved).
   */
  rotateKek(newKekId: string, newKek: Uint8Array): Promise<KeyRotationResult>;
  /** Export the wrapped per-deal DEK (+ kekId) for key-recovery drills. */
  exportBackup(dealId: string): Promise<BackupEnvelope>;
  /** Re-import a wrapped per-deal DEK (fails closed on wrong KEK). */
  importBackup(dealId: string, backup: BackupEnvelope): Promise<void>;
  /** Drop the in-memory DEK cache (key-loss drill helper; disk untouched). */
  dropCachedKey(dealId: string): void;
  /** Enumerate every deal with a persisted envelope (local dir + S3 listing). */
  enumerateDealIds(): Promise<string[]>;
  /** Current rotation progress record, if a rotation has been started. */
  getRotationProgress(): Promise<KeyRotationProgress | null>;
}

interface DekEntry {
  readonly dek: Buffer;
  readonly envelope: BackupEnvelope;
}

interface KeyringFile {
  readonly version: number;
  readonly activeId: string;
  readonly entries: Record<string, string>;
}

const KEYRING_FILE = "_keyring.json";
const ROTATION_FILE = "_rotation.json";
const S3_KEYRING_KEY = `_keys/${KEYRING_FILE}`;
const S3_ROTATION_KEY = `_keys/${ROTATION_FILE}`;

// ---- KEK management (+ historical keyring) ----

const KEK_BYTES = 32;
const keyring = new Map<string, Buffer>();
let activeKEK: Buffer | null = null;
let activeKEKId: string | null = null;
let pinnedActive: { key: Buffer; id: string } | null = null;
let warnedEphemeralKEK = false;

function kekIdFor(key: Buffer): string {
  return `kek-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function parseKekHex(raw: string, field: string): Buffer {
  const hex = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${field} must be 64 hex chars (32 bytes)`);
  }
  return Buffer.from(hex, "hex");
}

function registerKek(id: string, key: Buffer): void {
  keyring.set(id.toLowerCase(), key);
}

/** Install `newKek` as the active KEK under the caller-supplied id, pinned. */
function installActiveKek(id: string, key: Buffer): void {
  registerKek(id, key);
  activeKEK = key;
  activeKEKId = id;
  pinnedActive = { key, id };
}

/** Register historical KEKs (EVIDENCE_KEK_HISTORY) so old wrapped DEKs resolve. */
function loadHistoricalKeks(): void {
  const raw = (process.env["EVIDENCE_KEK_HISTORY"] ?? "").trim();
  if (raw === "") return;
  for (const entry of raw.split(",")) {
    if (entry.trim() === "") continue;
    const key = parseKekHex(entry, "EVIDENCE_KEK_HISTORY");
    registerKek(kekIdFor(key), key);
  }
}

function activeKekMaterial(): { key: Buffer; id: string } {
  if (pinnedActive) return pinnedActive;
  const hex = (process.env["EVIDENCE_KEK_HEX"] ?? "").trim();
  if (hex !== "") {
    const key = parseKekHex(hex, "EVIDENCE_KEK_HEX");
    const id = kekIdFor(key);
    registerKek(id, key);
    loadHistoricalKeks();
    installActiveKek(id, key);
    return pinnedActive!;
  }
  if (activeKEK && activeKEKId) {
    pinnedActive = { key: activeKEK, id: activeKEKId };
    return pinnedActive;
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "Evidence encryption requires a durable KEK in production: set EVIDENCE_KEK_HEX (64 hex chars) or a KMS-backed key",
    );
  }
  const key = randomBytes(KEK_BYTES);
  const id = kekIdFor(key);
  installActiveKek(id, key);
  if (!warnedEphemeralKEK) {
    warnedEphemeralKEK = true;
    console.warn("[evidence] EVIDENCE_KEK_HEX unset: using ephemeral in-memory KEK (dev-only; restarts lose keys)");
  }
  return pinnedActive!;
}

function loadKEK(): Buffer {
  return activeKekMaterial().key;
}

/** Short KEK fingerprint recorded alongside wrapped DEKs. */
export function currentKekId(): string {
  return activeKekMaterial().id;
}

/** Resolve a KEK by the id recorded in a wrapped-DEK envelope. */
function resolveKek(kekId?: string): Buffer {
  if (kekId === undefined || kekId === "") return loadKEK();
  let found = keyring.get(kekId.toLowerCase());
  if (found) return found;
  // Populate the keyring from env (active + historical) before giving up.
  activeKekMaterial();
  loadHistoricalKeks();
  found = keyring.get(kekId.toLowerCase());
  if (found) return found;
  if (activeKEKId && activeKEKId.toLowerCase() === kekId.toLowerCase() && activeKEK) return activeKEK;
  throw new Error(`Unknown KEK id "${kekId}": historical key not configured (set EVIDENCE_KEK_HISTORY or provide the persisted keyring)`);
}

// ---- Envelope primitives (AES-256-GCM) ----

function wrapDEKWith(kek: Buffer, dek: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${enc.toString("hex")}`;
}

function wrapDEK(dek: Buffer): string {
  return wrapDEKWith(loadKEK(), dek);
}

/** Raw unwrap with an explicitly supplied KEK (used when loading the keyring). */
function unwrapWith(kek: Buffer, wrapped: string): Buffer {
  const parts = wrapped.split(".");
  if (parts.length !== 3) throw new Error("Malformed wrapped DEK");
  const [ivHex, tagHex, encHex] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
}

function unwrapDEK(wrapped: string, kekId?: string): Buffer {
  return unwrapWith(resolveKek(kekId), wrapped);
}

function encryptWithDEK(dek: Buffer, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]); // 12 + 16 + n
}

function decryptWithDEK(dek: Buffer, blob: Buffer): Buffer {
  if (blob.length < 28) throw new Error("Ciphertext too short");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function safeSegment(value: string, field: string): string {
  if (!/^[0-9a-zA-Z][0-9a-zA-Z._:-]{0,127}$/.test(value) || value.includes("..")) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name ?? "";
  const code = (error as NodeJS.ErrnoException).code ?? "";
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || code === "ENOENT" || status === 404;
}

/** True for an S3 conditional-put conflict (If-None-Match: * lost the race). */
function isPreconditionFailure(error: unknown): boolean {
  const name = (error as { name?: string }).name ?? "";
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "PreconditionFailed" || status === 412;
}

function parseEnvelope(raw: string): BackupEnvelope {
  const parsed = JSON.parse(raw) as BackupEnvelope;
  if (
    !parsed ||
    typeof parsed.dekWrapped !== "string" ||
    typeof parsed.dealId !== "string" ||
    typeof parsed.kekId !== "string"
  ) {
    throw new Error("Malformed persisted DEK envelope");
  }
  return parsed;
}

function parseRotation(raw: string): KeyRotationProgress | null {
  try {
    const parsed = JSON.parse(raw) as Partial<KeyRotationProgress>;
    if (!parsed || typeof parsed.newKekId !== "string") return null;
    return {
      newKekId: parsed.newKekId,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      rotated: Array.isArray(parsed.rotated) ? parsed.rotated.filter((v): v is string => typeof v === "string") : [],
      complete: parsed.complete === true,
    };
  } catch {
    return null;
  }
}

/** Load a persisted KID -> wrapped-KEK mapping into the in-memory keyring. */
function absorbKeyring(raw: string, activeKey: Buffer): void {
  let parsed: Partial<KeyringFile>;
  try {
    parsed = JSON.parse(raw) as Partial<KeyringFile>;
  } catch {
    return;
  }
  const entries = parsed.entries ?? {};
  for (const [kid, wrapped] of Object.entries(entries)) {
    if (typeof wrapped !== "string") continue;
    try {
      registerKek(kid, unwrapWith(activeKey, wrapped));
    } catch {
      // Wrapped under a different active KEK; env history may still resolve it.
    }
  }
}

function serializeKeyring(): string {
  const { key, id } = activeKekMaterial();
  const entries: Record<string, string> = {};
  for (const [kid, material] of keyring) {
    entries[kid] = wrapDEKWith(key, material);
  }
  return JSON.stringify({ version: 1, activeId: id, entries } satisfies KeyringFile);
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  const candidate = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  };
  if (typeof candidate.transformToByteArray === "function") {
    return Buffer.from(await candidate.transformToByteArray());
  }
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of candidate as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return Buffer.from(body as Uint8Array);
}

// ---- Local store ----

export class LocalEncryptedStore implements EncryptedBlobStore {
  private readonly keys = new Map<string, DekEntry>();
  private readonly inflight = new Map<string, Promise<DekEntry>>();
  private readonly knownDeals = new Set<string>();
  private keyringLoaded = false;

  constructor(private readonly dir: string = process.env["EVIDENCE_DIR"] ?? "./data/evidence") {}

  private dealDir(dealId: string): string {
    return join(this.dir, safeSegment(dealId, "dealId"));
  }

  private blobPath(dealId: string, fileHash: string): string {
    return join(this.dealDir(dealId), `${safeSegment(fileHash, "fileHash")}.enc`);
  }

  /** Persisted wrapped-DEK path (key-recovery drills target this file). */
  keyPath(dealId: string): string {
    return join(this.dir, `${safeSegment(dealId, "dealId")}.dek.json`);
  }

  private async ensureKeyringLoaded(): Promise<void> {
    if (this.keyringLoaded) return;
    this.keyringLoaded = true;
    let raw: string;
    try {
      raw = await readFile(join(this.dir, KEYRING_FILE), "utf8");
    } catch {
      return;
    }
    absorbKeyring(raw, activeKekMaterial().key);
  }

  private async persistKeyring(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${KEYRING_FILE}.tmp-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, serializeKeyring(), "utf8");
    await rename(tmp, join(this.dir, KEYRING_FILE));
  }

  async getRotationProgress(): Promise<KeyRotationProgress | null> {
    try {
      return parseRotation(await readFile(join(this.dir, ROTATION_FILE), "utf8"));
    } catch {
      return null;
    }
  }

  private async writeRotationProgress(progress: KeyRotationProgress): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${ROTATION_FILE}.tmp-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, JSON.stringify(progress), "utf8");
    await rename(tmp, join(this.dir, ROTATION_FILE));
  }

  private async readPersisted(dealId: string): Promise<BackupEnvelope | null> {
    try {
      return parseEnvelope(await readFile(this.keyPath(dealId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  /** Read back the winner of a create race, tolerating a briefly partial write. */
  private async readPersistedStable(dealId: string): Promise<BackupEnvelope> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const persisted = await this.readPersisted(dealId);
      if (persisted) return persisted;
      lastError = new Error("DEK envelope not yet visible");
      await sleep(2);
    }
    throw lastError instanceof Error ? lastError : new Error("DEK envelope unreadable after race");
  }

  getOrCreateDek(dealId: string): Promise<BackupEnvelope> {
    return this.getOrCreate(dealId).then((entry) => entry.envelope);
  }

  private getOrCreate(dealId: string): Promise<DekEntry> {
    const key = dealId.toLowerCase();
    this.knownDeals.add(dealId);
    const cached = this.keys.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.createDek(dealId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async createDek(dealId: string): Promise<DekEntry> {
    await this.ensureKeyringLoaded();
    const key = dealId.toLowerCase();
    const persisted = await this.readPersisted(dealId);
    if (persisted) {
      const entry: DekEntry = { dek: unwrapDEK(persisted.dekWrapped, persisted.kekId), envelope: persisted };
      this.keys.set(key, entry);
      return entry;
    }
    const dek = randomBytes(KEK_BYTES);
    const envelope: BackupEnvelope = { dealId, dekWrapped: wrapDEK(dek), kekId: currentKekId() };
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(this.keyPath(dealId), JSON.stringify(envelope), { encoding: "utf8", flag: "wx" });
      const entry: DekEntry = { dek, envelope };
      this.keys.set(key, entry);
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      // Lost the atomic-create race: converge on the persisted winner.
      const winner = await this.readPersistedStable(dealId);
      const entry: DekEntry = { dek: unwrapDEK(winner.dekWrapped, winner.kekId), envelope: winner };
      this.keys.set(key, entry);
      return entry;
    }
  }

  async put(dealId: string, fileHash: string, bytes: Uint8Array): Promise<void> {
    const { dek } = await this.getOrCreate(dealId);
    await mkdir(this.dealDir(dealId), { recursive: true });
    await writeFile(this.blobPath(dealId, fileHash), encryptWithDEK(dek, bytes));
  }

  async get(dealId: string, fileHash: string): Promise<Buffer | null> {
    let raw: Buffer;
    try {
      raw = await readFile(this.blobPath(dealId, fileHash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    const { dek } = await this.getOrCreate(dealId);
    return decryptWithDEK(dek, raw);
  }

  async exists(dealId: string, fileHash: string): Promise<boolean> {
    try {
      await fsAccess(this.blobPath(dealId, fileHash));
      return true;
    } catch {
      return false;
    }
  }

  /** Deletes ciphertext only; the wrapped DEK is retained for recovery. */
  async delete(dealId: string, fileHash: string): Promise<void> {
    await rm(this.blobPath(dealId, fileHash), { force: true });
  }

  private async knownDealIds(): Promise<string[]> {
    const ids = new Set<string>(this.knownDeals);
    try {
      for (const name of await readdir(this.dir)) {
        if (name.endsWith(".dek.json")) ids.add(name.slice(0, -".dek.json".length));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return [...ids];
  }

  enumerateDealIds(): Promise<string[]> {
    return this.knownDealIds();
  }

  private async writeEnvelopeAtomic(dealId: string, envelope: BackupEnvelope): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const finalPath = this.keyPath(dealId);
    const tmp = `${finalPath}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(envelope), "utf8");
    await rename(tmp, finalPath);
  }

  async rotateKek(newKekId: string, newKek: Uint8Array): Promise<KeyRotationResult> {
    const key = Buffer.from(newKek);
    if (key.length !== KEK_BYTES) throw new Error("Rotated KEK must be 32 bytes");
    await this.ensureKeyringLoaded();
    const previous = activeKekMaterial();
    registerKek(previous.id, previous.key);
    installActiveKek(newKekId, key);
    // Persist KID -> wrapped-KEK history (wrapped under the new active KEK)
    // BEFORE touching envelopes so an interrupted rotation stays recoverable.
    await this.persistKeyring();

    const prior = await this.getRotationProgress();
    const resuming = prior !== null && prior.newKekId === newKekId && !prior.complete;
    const startedAt = resuming && prior ? prior.startedAt : Date.now();
    const rotated: string[] = resuming && prior ? [...prior.rotated] : [];
    const rotatedSet = new Set(rotated.map((id) => id.toLowerCase()));
    await this.writeRotationProgress({
      newKekId,
      startedAt,
      updatedAt: Date.now(),
      rotated,
      complete: false,
    });

    try {
      for (const dealId of await this.knownDealIds()) {
        const persisted = await this.readPersisted(dealId);
        if (!persisted) continue;
        const dek = unwrapDEK(persisted.dekWrapped, persisted.kekId);
        const envelope: BackupEnvelope = { dealId, dekWrapped: wrapDEKWith(key, dek), kekId: newKekId };
        await this.writeEnvelopeAtomic(dealId, envelope);
        this.keys.set(dealId.toLowerCase(), { dek, envelope });
        if (!rotatedSet.has(dealId.toLowerCase())) {
          rotated.push(dealId);
          rotatedSet.add(dealId.toLowerCase());
        }
        await this.writeRotationProgress({ newKekId, startedAt, updatedAt: Date.now(), rotated, complete: false });
      }
    } catch (error) {
      await this.writeRotationProgress({ newKekId, startedAt, updatedAt: Date.now(), rotated, complete: false });
      throw error;
    }
    await this.writeRotationProgress({ newKekId, startedAt, updatedAt: Date.now(), rotated, complete: true });
    return { kekId: newKekId, rotated };
  }

  async exportBackup(dealId: string): Promise<BackupEnvelope> {
    return (await this.getOrCreate(dealId)).envelope;
  }

  async importBackup(dealId: string, backup: BackupEnvelope): Promise<void> {
    await this.ensureKeyringLoaded();
    const dek = unwrapDEK(backup.dekWrapped, backup.kekId); // throws on wrong KEK: fail closed
    await mkdir(this.dir, { recursive: true });
    const envelope: BackupEnvelope = { dealId, dekWrapped: backup.dekWrapped, kekId: backup.kekId };
    await this.writeEnvelopeAtomic(dealId, envelope);
    this.keys.set(dealId.toLowerCase(), { dek, envelope });
    this.knownDeals.add(dealId);
  }

  dropCachedKey(dealId: string): void {
    this.keys.delete(dealId.toLowerCase());
  }
}

// ---- S3 store ----

export class S3EncryptedStore implements EncryptedBlobStore {
  private readonly keys = new Map<string, DekEntry>();
  private readonly inflight = new Map<string, Promise<DekEntry>>();
  private readonly knownDeals = new Set<string>();
  private readonly client: S3Client;
  private readonly bucket: string;
  private keyringLoaded = false;

  constructor(bucket: string = process.env["S3_BUCKET"] ?? "", client?: S3Client) {
    if (!bucket) throw new Error("S3_BUCKET is required for S3EncryptedStore");
    this.bucket = bucket;
    const endpoint = process.env["S3_ENDPOINT"] || undefined;
    this.client =
      client ??
      new S3Client({
        region: process.env["S3_REGION"] ?? "us-east-1",
        ...(endpoint ? { endpoint } : {}),
        forcePathStyle: Boolean(endpoint),
      });
  }

  private blobKey(dealId: string, fileHash: string): string {
    return `${safeSegment(dealId, "dealId")}/${safeSegment(fileHash, "fileHash")}.enc`;
  }

  private dekKey(dealId: string): string {
    return `_keys/${safeSegment(dealId, "dealId")}.dek.json`;
  }

  private async ensureKeyringLoaded(): Promise<void> {
    if (this.keyringLoaded) return;
    this.keyringLoaded = true;
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: S3_KEYRING_KEY }),
      );
      absorbKeyring((await streamToBuffer(res.Body)).toString("utf8"), activeKekMaterial().key);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async persistKeyring(): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: S3_KEYRING_KEY,
        Body: Buffer.from(serializeKeyring(), "utf8"),
      }),
    );
  }

  async getRotationProgress(): Promise<KeyRotationProgress | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: S3_ROTATION_KEY }),
      );
      return parseRotation((await streamToBuffer(res.Body)).toString("utf8"));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async writeRotationProgress(progress: KeyRotationProgress): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: S3_ROTATION_KEY,
        Body: Buffer.from(JSON.stringify(progress), "utf8"),
      }),
    );
  }

  private async readPersisted(dealId: string): Promise<BackupEnvelope | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.dekKey(dealId) }));
      return parseEnvelope((await streamToBuffer(res.Body)).toString("utf8"));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async readPersistedStable(dealId: string): Promise<BackupEnvelope> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const persisted = await this.readPersisted(dealId);
      if (persisted) return persisted;
      lastError = new Error("DEK envelope not yet visible");
      await sleep(10);
    }
    throw lastError instanceof Error ? lastError : new Error("DEK envelope unreadable after race");
  }

  getOrCreateDek(dealId: string): Promise<BackupEnvelope> {
    return this.getOrCreate(dealId).then((entry) => entry.envelope);
  }

  private getOrCreate(dealId: string): Promise<DekEntry> {
    const key = dealId.toLowerCase();
    this.knownDeals.add(dealId);
    const cached = this.keys.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.createDek(dealId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async createDek(dealId: string): Promise<DekEntry> {
    await this.ensureKeyringLoaded();
    const key = dealId.toLowerCase();
    const persisted = await this.readPersisted(dealId);
    if (persisted) {
      const entry: DekEntry = { dek: unwrapDEK(persisted.dekWrapped, persisted.kekId), envelope: persisted };
      this.keys.set(key, entry);
      return entry;
    }
    const dek = randomBytes(KEK_BYTES);
    const envelope: BackupEnvelope = { dealId, dekWrapped: wrapDEK(dek), kekId: currentKekId() };
    try {
      // Conditional create: the winner's key is the only one persisted.
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.dekKey(dealId),
          Body: Buffer.from(JSON.stringify(envelope), "utf8"),
          IfNoneMatch: "*",
        }),
      );
      const entry: DekEntry = { dek, envelope };
      this.keys.set(key, entry);
      return entry;
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const winner = await this.readPersistedStable(dealId);
      const entry: DekEntry = { dek: unwrapDEK(winner.dekWrapped, winner.kekId), envelope: winner };
      this.keys.set(key, entry);
      return entry;
    }
  }

  async put(dealId: string, fileHash: string, bytes: Uint8Array): Promise<void> {
    const { dek } = await this.getOrCreate(dealId);
    const enc = encryptWithDEK(dek, bytes);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.blobKey(dealId, fileHash), Body: Buffer.from(enc) }),
    );
  }

  async get(dealId: string, fileHash: string): Promise<Buffer | null> {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.blobKey(dealId, fileHash) }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const { dek } = await this.getOrCreate(dealId);
    return decryptWithDEK(dek, await streamToBuffer(res.Body));
  }

  async exists(dealId: string, fileHash: string): Promise<boolean> {
    return (await this.get(dealId, fileHash)) !== null;
  }

  async delete(dealId: string, fileHash: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.blobKey(dealId, fileHash) }));
  }

  private async knownDealIds(): Promise<string[]> {
    const ids = new Set<string>(this.knownDeals);
    let token: string | undefined;
    do {
      const listing = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: "_keys/",
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const object of listing.Contents ?? []) {
        const key = object.Key ?? "";
        if (!key.endsWith(".dek.json")) continue;
        const dealId = key.slice("_keys/".length, -".dek.json".length);
        if (dealId !== "") ids.add(dealId);
      }
      token = listing.IsTruncated ? listing.NextContinuationToken : undefined;
    } while (token);
    return [...ids];
  }

  enumerateDealIds(): Promise<string[]> {
    return this.knownDealIds();
  }

  private async writeEnvelopeAtomic(dealId: string, envelope: BackupEnvelope): Promise<void> {
    const tmpKey = `_keys/.tmp-${randomBytes(6).toString("hex")}.json`;
    const finalKey = this.dekKey(dealId);
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: tmpKey, Body: body }));
    await this.client.send(
      new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${tmpKey}`, Key: finalKey }),
    );
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: tmpKey }));
  }

  async rotateKek(newKekId: string, newKek: Uint8Array): Promise<KeyRotationResult> {
    const key = Buffer.from(newKek);
    if (key.length !== KEK_BYTES) throw new Error("Rotated KEK must be 32 bytes");
    await this.ensureKeyringLoaded();
    const previous = activeKekMaterial();
    registerKek(previous.id, previous.key);
    installActiveKek(newKekId, key);
    await this.persistKeyring();

    const prior = await this.getRotationProgress();
    const resuming = prior !== null && prior.newKekId === newKekId && !prior.complete;
    const startedAt = resuming && prior ? prior.startedAt : Date.now();
    const rotated: string[] = resuming && prior ? [...prior.rotated] : [];
    const rotatedSet = new Set(rotated.map((id) => id.toLowerCase()));
    await this.writeRotationProgress({ newKekId, startedAt, updatedAt: Date.now(), rotated, complete: false });

    try {
      for (const dealId of await this.knownDealIds()) {
        const persisted = await this.readPersisted(dealId);
        if (!persisted) continue;
        const dek = unwrapDEK(persisted.dekWrapped, persisted.kekId);
        const envelope: BackupEnvelope = { dealId, dekWrapped: wrapDEKWith(key, dek), kekId: newKekId };
        await this.writeEnvelopeAtomic(dealId, envelope);
        this.keys.set(dealId.toLowerCase(), { dek, envelope });
        if (!rotatedSet.has(dealId.toLowerCase())) {
          rotated.push(dealId);
          rotatedSet.add(dealId.toLowerCase());
        }
        await this.writeRotationProgress({ newKekId, startedAt, updatedAt: Date.now(), rotated, complete: false });
      }
    } catch (error) {
      await this.writeRotationProgress({ newKekId, startedAt, updatedAt: Date.now(), rotated, complete: false });
      throw error;
    }
    await this.writeRotationProgress({ newKekId, startedAt, updatedAt: Date.now(), rotated, complete: true });
    return { kekId: newKekId, rotated };
  }

  async exportBackup(dealId: string): Promise<BackupEnvelope> {
    return (await this.getOrCreate(dealId)).envelope;
  }

  async importBackup(dealId: string, backup: BackupEnvelope): Promise<void> {
    await this.ensureKeyringLoaded();
    const dek = unwrapDEK(backup.dekWrapped, backup.kekId); // throws on wrong KEK: fail closed
    const envelope: BackupEnvelope = { dealId, dekWrapped: backup.dekWrapped, kekId: backup.kekId };
    await this.writeEnvelopeAtomic(dealId, envelope);
    this.keys.set(dealId.toLowerCase(), { dek, envelope });
    this.knownDeals.add(dealId);
  }

  dropCachedKey(dealId: string): void {
    this.keys.delete(dealId.toLowerCase());
  }
}

// ---- Selector + shared instance ----

/** S3_BUCKET set -> S3EncryptedStore, else local directory store. */
export function createBlobStore(): EncryptedBlobStore {
  if ((process.env["S3_BUCKET"] ?? "").trim() !== "") return new S3EncryptedStore();
  return new LocalEncryptedStore();
}

let sharedStore: EncryptedBlobStore | null = null;

/** Process-wide store used by routes (and key-recovery drills in tests). */
export function getSharedBlobStore(): EncryptedBlobStore {
  if (!sharedStore) {
    loadKEK(); // fail fast: never boot the evidence subsystem on an ephemeral production key
    sharedStore = createBlobStore();
  }
  return sharedStore;
}

/** Rotate the KEK on the shared store (re-wraps all known DEKs). */
export function rotateKek(newKekId: string, newKek: Uint8Array): Promise<KeyRotationResult> {
  return getSharedBlobStore().rotateKek(newKekId, newKek);
}

/** Test-only reset (drops the shared instance + KEK caches/keyring). */
export function __resetBlobStoreForTests(): void {
  sharedStore = null;
  keyring.clear();
  activeKEK = null;
  activeKEKId = null;
  pinnedActive = null;
  warnedEphemeralKEK = false;
}
