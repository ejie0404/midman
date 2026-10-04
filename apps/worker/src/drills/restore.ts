// Phase 10 restore drill (database/object/key recovery rehearsal).
//
// Framework-agnostic and injected: the drill talks only to the small
// BlobStoreLike / ManifestRegistryLike interfaces below, which the real
// apps/api EncryptedBlobStore + manifest registry satisfy structurally. This
// avoids fragile cross-app relative imports while still exercising the exact
// method names (put/get/exists/delete/exportBackup/importBackup/dropCachedKey).
//
// restoreDrillWithLocalStore() runs the same logic against a tiny in-test
// AES-256-GCM store, proving ciphertext + wrapped-DEK restoration without a
// live object store or KEK environment.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface DrillStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DrillResult {
  readonly ok: boolean;
  readonly steps: DrillStep[];
  readonly detail: string;
}

export interface BackupEnvelopeLike {
  readonly dealId: string;
  readonly dekWrapped: string;
  readonly kekId: string;
}

export interface BlobStoreLike {
  put(dealId: string, fileHash: string, bytes: Uint8Array): Promise<void>;
  get(dealId: string, fileHash: string): Promise<Uint8Array | null>;
  exists?(dealId: string, fileHash: string): Promise<boolean>;
  delete(dealId: string, fileHash: string): Promise<void>;
  exportBackup(dealId: string): Promise<BackupEnvelopeLike>;
  importBackup(dealId: string, backup: BackupEnvelopeLike): Promise<void>;
  /** Drop the in-memory DEK cache (process-restart simulation). */
  dropCachedKey?(dealId: string): void;
  /** Optional raw-ciphertext export (versioned object backup). */
  exportRaw?(dealId: string, fileHash: string): Promise<Uint8Array | null>;
  /** Optional raw-ciphertext import (object restore). */
  importRaw?(dealId: string, fileHash: string, raw: Uint8Array): Promise<void>;
}

export interface ManifestRegistryLike {
  getManifest(dealId: string): ReadonlyArray<{ readonly fileHash: string }>;
}

export interface RestoreDrillInput {
  readonly blobStore: BlobStoreLike;
  readonly dealId: string;
  readonly fileHash: string;
  readonly bytes: Uint8Array;
  readonly registry?: ManifestRegistryLike | null;
  /** Optional overrides; default to blobStore.exportBackup / importBackup. */
  readonly exportBackup?: (dealId: string) => Promise<BackupEnvelopeLike>;
  readonly importBackup?: (dealId: string, backup: BackupEnvelopeLike) => Promise<void>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return Buffer.from(a).equals(Buffer.from(b));
}

async function blobExists(store: BlobStoreLike, dealId: string, fileHash: string): Promise<boolean> {
  if (store.exists) return store.exists(dealId, fileHash);
  return (await store.get(dealId, fileHash)) !== null;
}

/**
 * Export wrapped DEK + encrypted blob, delete the ciphertext, re-import the
 * DEK, re-download and re-hash, and assert the plaintext is byte-identical.
 * Any failed step (or a tampered ciphertext leaving an unusable blob) makes
 * the drill fail closed.
 */
export async function restoreDrill(input: RestoreDrillInput): Promise<DrillResult> {
  const steps: DrillStep[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
  };
  const exportBackup =
    input.exportBackup ?? ((dealId: string) => input.blobStore.exportBackup(dealId));
  const importBackup =
    input.importBackup ??
    ((dealId: string, backup: BackupEnvelopeLike) => input.blobStore.importBackup(dealId, backup));
  const expectedHash = sha256Hex(input.bytes);

  try {
    await input.blobStore.put(input.dealId, input.fileHash, input.bytes);
    const present = await blobExists(input.blobStore, input.dealId, input.fileHash);
    add("store-encrypted-blob", present, `dealId=${input.dealId} fileHash=${input.fileHash}`);

    const backup = await exportBackup(input.dealId);
    const hasDek = typeof backup.dekWrapped === "string" && backup.dekWrapped.length > 0;
    add("export-wrapped-dek", hasDek, `kekId=${backup.kekId}`);

    const rawSnapshot = input.blobStore.exportRaw
      ? await input.blobStore.exportRaw(input.dealId, input.fileHash)
      : null;
    add(
      "export-encrypted-blob",
      rawSnapshot !== null,
      rawSnapshot ? `${rawSnapshot.length} bytes ciphertext` : "raw export unavailable",
    );

    await input.blobStore.delete(input.dealId, input.fileHash);
    const gone = !(await blobExists(input.blobStore, input.dealId, input.fileHash));
    add("delete-ciphertext", gone, "ciphertext removed; wrapped DEK retained");

    input.blobStore.dropCachedKey?.(input.dealId);
    add("drop-cached-key", true, "in-memory DEK cache cleared (process-restart simulation)");

    let importOk = true;
    let importDetail = `kekId=${backup.kekId}`;
    try {
      await importBackup(input.dealId, backup);
    } catch (error) {
      importOk = false;
      importDetail = error instanceof Error ? error.message : "import failed";
    }
    add("reimport-wrapped-dek", importOk, importDetail);

    if (importOk) {
      if (rawSnapshot && input.blobStore.importRaw) {
        await input.blobStore.importRaw(input.dealId, input.fileHash, rawSnapshot);
        add("restore-encrypted-blob", true, "ciphertext restored from versioned snapshot");
      } else {
        await input.blobStore.put(input.dealId, input.fileHash, input.bytes);
        add("restore-encrypted-blob", true, "ciphertext re-encrypted with recovered DEK");
      }
    }

    const restored = importOk ? await input.blobStore.get(input.dealId, input.fileHash) : null;
    const restoredHash = restored ? sha256Hex(restored) : "";
    const identical =
      restored !== null && bytesEqual(restored, input.bytes) && restoredHash === expectedHash;
    add(
      "re-download-and-rehash",
      identical,
      restored === null
        ? "missing after restore"
        : `sha256=${restoredHash}${identical ? "" : ` expected=${expectedHash}`}`,
    );

    if (input.registry) {
      const manifest = input.registry.getManifest(input.dealId);
      const matches = manifest.some(
        (entry) => entry.fileHash.toLowerCase() === input.fileHash.toLowerCase(),
      );
      add("registry-manifest-hash-match", matches, `entries=${manifest.length}`);
    }
  } catch (error) {
    add("drill-error", false, error instanceof Error ? error.message : "unknown drill error");
  }

  const ok = steps.length > 0 && steps.every((step) => step.ok);
  return {
    ok,
    steps,
    detail: ok
      ? `restore drill passed for ${input.dealId}`
      : `restore drill failed for ${input.dealId}`,
  };
}

// ---- Self-contained AES-256-GCM store (drill proof, no cross-app import) ----

function wrapDEK(kek: Buffer, dek: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${enc.toString("hex")}`;
}

function unwrapDEK(kek: Buffer, wrapped: string): Buffer {
  const parts = wrapped.split(".");
  if (parts.length !== 3) throw new Error("Malformed wrapped DEK");
  const [ivHex, tagHex, encHex] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
}

function encryptWithDEK(dek: Buffer, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
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

/**
 * Tiny in-memory AES-256-GCM blob store mirroring EncryptedBlobStore method
 * names. Lives here so the drill can be proven without importing apps/api.
 */
export class AesGcmBlobStore implements BlobStoreLike {
  private readonly deks = new Map<string, Buffer>();
  private readonly blobs = new Map<string, Buffer>();

  constructor(private readonly kek: Buffer) {}

  private key(dealId: string, fileHash: string): string {
    return `${dealId.toLowerCase()}/${fileHash.toLowerCase()}`;
  }

  private dek(dealId: string): Buffer {
    const cacheKey = dealId.toLowerCase();
    const existing = this.deks.get(cacheKey);
    if (existing) return existing;
    const dek = randomBytes(32);
    this.deks.set(cacheKey, dek);
    return dek;
  }

  async put(dealId: string, fileHash: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(this.key(dealId, fileHash), encryptWithDEK(this.dek(dealId), bytes));
  }

  async get(dealId: string, fileHash: string): Promise<Uint8Array | null> {
    const raw = this.blobs.get(this.key(dealId, fileHash));
    if (!raw) return null;
    return decryptWithDEK(this.dek(dealId), raw);
  }

  async exists(dealId: string, fileHash: string): Promise<boolean> {
    return this.blobs.has(this.key(dealId, fileHash));
  }

  async delete(dealId: string, fileHash: string): Promise<void> {
    this.blobs.delete(this.key(dealId, fileHash));
  }

  async exportBackup(dealId: string): Promise<BackupEnvelopeLike> {
    return {
      dealId,
      dekWrapped: wrapDEK(this.kek, this.dek(dealId)),
      kekId: "kek-local-drill",
    };
  }

  async importBackup(dealId: string, backup: BackupEnvelopeLike): Promise<void> {
    this.deks.set(dealId.toLowerCase(), unwrapDEK(this.kek, backup.dekWrapped));
  }

  dropCachedKey(dealId: string): void {
    this.deks.delete(dealId.toLowerCase());
  }

  async exportRaw(dealId: string, fileHash: string): Promise<Uint8Array | null> {
    return this.blobs.get(this.key(dealId, fileHash)) ?? null;
  }

  async importRaw(dealId: string, fileHash: string, raw: Uint8Array): Promise<void> {
    this.blobs.set(this.key(dealId, fileHash), Buffer.from(raw));
  }
}

/** Run the restore drill end-to-end against the self-contained local store. */
export async function restoreDrillWithLocalStore(): Promise<DrillResult> {
  const kek = randomBytes(32);
  const store = new AesGcmBlobStore(kek);
  const bytes = Buffer.from("midman restore drill payload v1", "utf8");
  const fileHash = sha256Hex(bytes);
  return restoreDrill({
    blobStore: store,
    dealId: "0xdealdrill",
    fileHash,
    bytes,
  });
}
