// Evidence restore drill (P-13 recovery, Phase 6/8 gate).
//
// `runEvidenceRestoreDrill` simulates a cold restore: it drops the in-memory
// DEK cache, re-imports the supplied wrapped key envelopes (pre- AND
// post-rotation), re-downloads every manifest object's bytes, re-hashes them,
// and checks each against the committed fileHash. Purged blobs are reported as
// tombstoned (not failures); missing or undecryptable bytes are reported
// per-object so an operator can see exactly what could not be recovered.
import { createHash } from "node:crypto";
import type { BackupEnvelope, EncryptedBlobStore } from "./store.js";
import type { ManifestRegistry } from "./registry.js";

export interface RestoreDrillInput {
  readonly blobStore: EncryptedBlobStore;
  readonly registry: ManifestRegistry;
  readonly dealId: string;
  /**
   * Wrapped per-deal key envelopes to re-import, covering both pre- and
   * post-rotation keys. Imported into the reader before any decryption, so a
   * cold process that only has these envelopes (plus the persisted keyring)
   * can recover the bytes.
   */
  readonly keyHistory?: readonly BackupEnvelope[];
  /** Clean reader; defaults to `blobStore` (cache still dropped). */
  readonly reader?: EncryptedBlobStore;
  /** Override the set of objects to check; defaults to the manifest. */
  readonly fileHashes?: readonly string[];
}

export type RestoreObjectStatus = "ok" | "missing" | "purged" | "undecryptable" | "hash-mismatch";

export interface RestoreObjectResult {
  readonly fileHash: string;
  readonly ok: boolean;
  readonly status: RestoreObjectStatus;
  readonly reason?: string;
}

export interface RestoreDrillResult {
  readonly dealId: string;
  readonly ok: boolean;
  readonly objects: readonly RestoreObjectResult[];
  /** File hashes whose ciphertext could not be decrypted with the key history. */
  readonly undecryptable: readonly string[];
  /** Key ids that were successfully re-imported during the drill. */
  readonly importedKekIds: readonly string[];
  readonly keyImportFailures: readonly string[];
}

export async function runEvidenceRestoreDrill(input: RestoreDrillInput): Promise<RestoreDrillResult> {
  const store = input.reader ?? input.blobStore;
  // Clean context: forget any cached DEK so only the re-imported envelopes can
  // satisfy decryption.
  store.dropCachedKey(input.dealId);

  const importedKekIds: string[] = [];
  const keyImportFailures: string[] = [];
  for (const envelope of input.keyHistory ?? []) {
    try {
      await store.importBackup(input.dealId, envelope);
      importedKekIds.push(envelope.kekId);
    } catch (error) {
      keyImportFailures.push(
        `${envelope.kekId}: ${error instanceof Error ? error.message : "import failed"}`,
      );
    }
  }

  const manifest = input.registry.getManifest(input.dealId);
  const targets =
    input.fileHashes !== undefined
      ? input.fileHashes.map((fileHash) => ({ fileHash }))
      : manifest.map((entry) => ({ fileHash: entry.fileHash }));

  const objects: RestoreObjectResult[] = [];
  const undecryptable: string[] = [];

  for (const target of targets) {
    const fileHash = target.fileHash;
    if (input.registry.isBlobPurged(input.dealId, fileHash)) {
      objects.push({ fileHash, ok: true, status: "purged" });
      continue;
    }
    let bytes: Buffer | null;
    try {
      bytes = await store.get(input.dealId, fileHash);
    } catch (error) {
      undecryptable.push(fileHash);
      objects.push({
        fileHash,
        ok: false,
        status: "undecryptable",
        reason: error instanceof Error ? error.message : "decryption failed",
      });
      continue;
    }
    if (!bytes) {
      objects.push({ fileHash, ok: false, status: "missing", reason: "ciphertext not found" });
      continue;
    }
    const recomputed = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    if (recomputed.toLowerCase() !== fileHash.toLowerCase()) {
      objects.push({
        fileHash,
        ok: false,
        status: "hash-mismatch",
        reason: `recomputed ${recomputed}`,
      });
      continue;
    }
    objects.push({ fileHash, ok: true, status: "ok" });
  }

  return {
    dealId: input.dealId,
    ok: objects.every((object) => object.ok),
    objects,
    undecryptable,
    importedKekIds,
    keyImportFailures,
  };
}
