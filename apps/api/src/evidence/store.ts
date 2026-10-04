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
// Key rotation: rotateKek(newKekId, newKek) registers the new KEK, re-wraps
// every known DEK under it, and keeps a process-local keyring keyed by the
// `kekId` recorded in each envelope, so wrapped DEKs written under a previous
// KEK remain resolvable. Historical KEKs can be re-supplied after restart via
// EVIDENCE_KEK_HISTORY (comma-separated 64-hex keys).
//
// Layout (local): <EVIDENCE_DIR>/<dealId>/<fileHash>.enc (iv||tag||ciphertext)
//                 <EVIDENCE_DIR>/<dealId>.dek.json   (wrapped per-deal DEK)
// S3 layout mirrors this: <dealId>/<fileHash>.enc + _keys/<dealId>.dek.json.
// Selector: S3_BUCKET set -> S3EncryptedStore (PutObject/GetObject/
// DeleteObject, forcePathStyle honoring S3_ENDPOINT), else LocalEncryptedStore.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { access as fsAccess, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface BackupEnvelope {
  readonly dealId: string;
  readonly dekWrapped: string;
  readonly kekId: string;
}

export interface KeyRotationResult {
  readonly kekId: string;
  readonly rotated: string[];
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
}

interface DekEntry {
  readonly dek: Buffer;
  readonly envelope: BackupEnvelope;
}

// ---- KEK management (+ historical keyring) ----

const KEK_BYTES = 32;
const keyring = new Map<string, Buffer>();
let activeKEK: Buffer | null = null;
let activeKEKId: string | null = null;
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

/** Install `newKek` as the active KEK under the caller-supplied id. */
function installActiveKek(id: string, key: Buffer): void {
  registerKek(id, key);
  activeKEK = key;
  activeKEKId = id;
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
  const hex = (process.env["EVIDENCE_KEK_HEX"] ?? "").trim();
  if (hex !== "") {
    const key = parseKekHex(hex, "EVIDENCE_KEK_HEX");
    const id = kekIdFor(key);
    registerKek(id, key);
    loadHistoricalKeks();
    if (!activeKEK || activeKEKId !== id) {
      activeKEK = key;
      activeKEKId = id;
    }
    return { key: activeKEK as Buffer, id: activeKEKId as string };
  }
  if (activeKEK && activeKEKId) return { key: activeKEK, id: activeKEKId };
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
  return { key, id };
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
  found = keyring.get(kekId.toLowerCase());
  if (found) return found;
  if (activeKEKId && activeKEKId.toLowerCase() === kekId.toLowerCase() && activeKEK) return activeKEK;
  throw new Error(`Unknown KEK id "${kekId}": historical key not configured (set EVIDENCE_KEK_HISTORY)`);
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

function unwrapDEK(wrapped: string, kekId?: string): Buffer {
  const parts = wrapped.split(".");
  if (parts.length !== 3) throw new Error("Malformed wrapped DEK");
  const [ivHex, tagHex, encHex] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", resolveKek(kekId), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
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

  async rotateKek(newKekId: string, newKek: Uint8Array): Promise<KeyRotationResult> {
    const key = Buffer.from(newKek);
    if (key.length !== KEK_BYTES) throw new Error("Rotated KEK must be 32 bytes");
    installActiveKek(newKekId, key);
    const rotated: string[] = [];
    for (const dealId of await this.knownDealIds()) {
      const cached = this.keys.get(dealId.toLowerCase());
      let current = cached;
      if (!current) {
        const persisted = await this.readPersisted(dealId);
        if (!persisted) continue;
        current = { dek: unwrapDEK(persisted.dekWrapped, persisted.kekId), envelope: persisted };
      }
      const envelope: BackupEnvelope = { dealId, dekWrapped: wrapDEKWith(key, current.dek), kekId: newKekId };
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.keyPath(dealId), JSON.stringify(envelope), "utf8");
      this.keys.set(dealId.toLowerCase(), { dek: current.dek, envelope });
      rotated.push(dealId);
    }
    return { kekId: newKekId, rotated };
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

  async exportBackup(dealId: string): Promise<BackupEnvelope> {
    return (await this.getOrCreate(dealId)).envelope;
  }

  async importBackup(dealId: string, backup: BackupEnvelope): Promise<void> {
    const dek = unwrapDEK(backup.dekWrapped, backup.kekId); // throws on wrong KEK: fail closed
    await mkdir(this.dir, { recursive: true });
    const envelope: BackupEnvelope = { dealId, dekWrapped: backup.dekWrapped, kekId: backup.kekId };
    await writeFile(this.keyPath(dealId), JSON.stringify(envelope), "utf8");
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

  async rotateKek(newKekId: string, newKek: Uint8Array): Promise<KeyRotationResult> {
    const key = Buffer.from(newKek);
    if (key.length !== KEK_BYTES) throw new Error("Rotated KEK must be 32 bytes");
    installActiveKek(newKekId, key);
    const rotated: string[] = [];
    for (const dealId of this.knownDeals) {
      const cached = this.keys.get(dealId.toLowerCase());
      let current = cached;
      if (!current) {
        const persisted = await this.readPersisted(dealId);
        if (!persisted) continue;
        current = { dek: unwrapDEK(persisted.dekWrapped, persisted.kekId), envelope: persisted };
      }
      const envelope: BackupEnvelope = { dealId, dekWrapped: wrapDEKWith(key, current.dek), kekId: newKekId };
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.dekKey(dealId),
          Body: Buffer.from(JSON.stringify(envelope), "utf8"),
        }),
      );
      this.keys.set(dealId.toLowerCase(), { dek: current.dek, envelope });
      rotated.push(dealId);
    }
    return { kekId: newKekId, rotated };
  }

  async exportBackup(dealId: string): Promise<BackupEnvelope> {
    return (await this.getOrCreate(dealId)).envelope;
  }

  async importBackup(dealId: string, backup: BackupEnvelope): Promise<void> {
    const dek = unwrapDEK(backup.dekWrapped, backup.kekId); // throws on wrong KEK: fail closed
    const envelope: BackupEnvelope = { dealId, dekWrapped: backup.dekWrapped, kekId: backup.kekId };
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.dekKey(dealId), Body: Buffer.from(JSON.stringify(envelope), "utf8") }),
    );
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
  warnedEphemeralKEK = false;
}
