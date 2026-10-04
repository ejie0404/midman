// Evidence retention (P-12): encrypted originals 2 years post-settlement,
// manifests/proofs 5 years; deletion only by dual authorization
// (ops + arbitration lead). Purge deletes ciphertext but keeps manifest
// tombstones — the audit trail is never deleted by this path.
import type { ManifestRegistry } from "./registry.js";
import type { EncryptedBlobStore } from "./store.js";

export const RETENTION_SECONDS = {
  originals: 2 * 365 * 86_400,
  manifests: 5 * 365 * 86_400,
} as const;

export type RetentionRecordType = keyof typeof RETENTION_SECONDS;

export interface PurgeApprovalInput {
  readonly role: "ops" | "arbitration";
  readonly signature?: string;
}

/** True when `now` is at/past settledAt + the retention window. */
export function dueForPurge(recordType: RetentionRecordType, settledAt: number, now: number): boolean {
  if (!Number.isFinite(settledAt) || !Number.isFinite(now)) return false;
  return now - settledAt >= RETENTION_SECONDS[recordType];
}

export interface PurgeResult {
  readonly purged: ReadonlyArray<{ dealId: string; fileHash: string }>;
  readonly skipped: readonly string[];
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Delete expired originals. Requires TWO distinct roles (ops + arbitration)
 * or throws; deals without a recorded settlement are skipped (never purged
 * on unknown age). Manifest entries are preserved as tombstones.
 */
export async function purgeExpired(
  registry: ManifestRegistry,
  blobstore: EncryptedBlobStore,
  now: number,
  approvals: readonly PurgeApprovalInput[],
): Promise<PurgeResult> {
  const roles = new Set(approvals.map((approval) => approval.role));
  if (!roles.has("ops") || !roles.has("arbitration")) {
    throw httpError(403, "Purge requires dual authorization: distinct ops + arbitration approvals");
  }
  const purged: Array<{ dealId: string; fileHash: string }> = [];
  const skipped: string[] = [];
  for (const dealId of registry.listDealIds()) {
    const settledAt = registry.getSettlement(dealId);
    if (settledAt === null || !dueForPurge("originals", settledAt, now)) {
      skipped.push(dealId);
      continue;
    }
    for (const entry of registry.getManifest(dealId)) {
      if (registry.isBlobPurged(dealId, entry.fileHash)) continue;
      await blobstore.delete(dealId, entry.fileHash);
      registry.markBlobPurged(dealId, entry.fileHash, now);
      purged.push({ dealId, fileHash: entry.fileHash });
    }
  }
  return { purged, skipped };
}
