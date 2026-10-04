// Evidence retention (P-12): encrypted originals 2 years post-settlement,
// manifests/proofs 5 years; deletion only by dual authorization
// (ops + arbitration lead). Purge deletes ciphertext but keeps manifest
// tombstones — the audit trail is never deleted by this path.
//
// Round-2 Phase 6: approvals may be SIGNED (`SignedRetentionApproval`) and are
// verified against the policy, the SPECIFIC deal, and (when supplied) the
// specific object — not against a supplied role label. Each signature is
// recovered with viem and the signer must be allowlisted for its role
// (RETENTION_OPS_WALLETS / RETENTION_ARBITRATION_WALLETS). Deletion outcomes
// are recorded durably while tombstones preserve the manifest chain.
import { recoverMessageAddress, type Address, type Hash } from "viem";
import type { ManifestRegistry, PurgeOutcome } from "./registry.js";
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

export interface SignedRetentionApproval {
  readonly role: "ops" | "arbitration";
  /** Recovered signer address (EIP-191 personal_sign of the approval message). */
  readonly approver: string;
  readonly dealId: string;
  /** Specific object this approval covers; omitted means the whole deal. */
  readonly fileHash?: string;
  readonly policy: RetentionRecordType;
  readonly issuedAt: number;
  readonly expiry: number;
  readonly signature: string;
}

/** True when `now` is at/past settledAt + the retention window. */
export function dueForPurge(recordType: RetentionRecordType, settledAt: number, now: number): boolean {
  if (!Number.isFinite(settledAt) || !Number.isFinite(now)) return false;
  return now - settledAt >= RETENTION_SECONDS[recordType];
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** Canonical signed retention-approval message (exported for clients/tests). */
export function purgeApprovalMessage(
  approval: Omit<SignedRetentionApproval, "signature">,
): string {
  return [
    "MidmanRetentionApproval|v1",
    `role: ${approval.role}`,
    `approver: ${approval.approver}`,
    `deal: ${approval.dealId}`,
    `fileHash: ${approval.fileHash ?? "*"}`,
    `policy: ${approval.policy}`,
    `issuedAt: ${approval.issuedAt}`,
    `expiry: ${approval.expiry}`,
  ].join("\n");
}

function allowlistFor(role: "ops" | "arbitration"): Set<string> {
  const env = role === "ops" ? "RETENTION_OPS_WALLETS" : "RETENTION_ARBITRATION_WALLETS";
  const raw = process.env[env] ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export type PurgeApprovalVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a signed retention approval: the signature must recover to the
 * declared approver, the approver must be allowlisted for the role, the policy
 * must be a known retention record type, and the approval must be live.
 */
export async function verifyPurgeApproval(
  approval: SignedRetentionApproval,
  now: number,
): Promise<PurgeApprovalVerdict> {
  if (approval.role !== "ops" && approval.role !== "arbitration") {
    return { ok: false, reason: "unknown role" };
  }
  if (!(approval.policy in RETENTION_SECONDS)) return { ok: false, reason: "unknown policy" };
  if (!Number.isFinite(approval.issuedAt) || !Number.isFinite(approval.expiry)) {
    return { ok: false, reason: "invalid timestamps" };
  }
  if (approval.expiry <= now) return { ok: false, reason: "approval expired" };
  if (approval.issuedAt > now + 900) return { ok: false, reason: "approval issued in the future" };
  let recovered: Address;
  try {
    const message = purgeApprovalMessage({ ...approval });
    recovered = await recoverMessageAddress({ message, signature: approval.signature as Hash });
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  if (recovered.toLowerCase() !== approval.approver.toLowerCase()) {
    return { ok: false, reason: "signature does not match approver" };
  }
  if (!allowlistFor(approval.role).has(recovered.toLowerCase())) {
    return { ok: false, reason: "approver not authorized for role" };
  }
  return { ok: true };
}

export interface PurgeResult {
  readonly purged: ReadonlyArray<{ dealId: string; fileHash: string }>;
  readonly skipped: readonly string[];
  readonly outcomes: readonly PurgeOutcome[];
}

export interface PurgeOptions {
  /** Require signed, allowlisted approvals even if only role labels are given. */
  readonly requireSigned?: boolean;
}

function isSignedApproval(value: unknown): value is SignedRetentionApproval {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SignedRetentionApproval>;
  return (
    typeof candidate.signature === "string" &&
    typeof candidate.approver === "string" &&
    typeof candidate.dealId === "string" &&
    (candidate.role === "ops" || candidate.role === "arbitration")
  );
}

/**
 * Delete expired originals. In strict/signed mode TWO distinct allowlisted
 * identities (ops + arbitration) must sign for the policy and the SPECIFIC
 * object or deal; legacy role-label approvals are only accepted when no signed
 * approval is supplied and `requireSigned` is not set. Deals without a
 * recorded settlement are skipped (never purged on unknown age). Manifest
 * entries are preserved as tombstones; outcomes are recorded durably.
 */
export async function purgeExpired(
  registry: ManifestRegistry,
  blobstore: EncryptedBlobStore,
  now: number,
  approvals: readonly (PurgeApprovalInput | SignedRetentionApproval)[],
  options: PurgeOptions = {},
): Promise<PurgeResult> {
  const purged: Array<{ dealId: string; fileHash: string }> = [];
  const skipped: string[] = [];
  const outcomes: PurgeOutcome[] = [];

  const signedInputs = approvals.filter(isSignedApproval);
  const strict = options.requireSigned === true || signedInputs.length > 0;

  let validSigned: SignedRetentionApproval[] = [];
  if (strict) {
    validSigned = [];
    for (const approval of signedInputs) {
      const verdict = await verifyPurgeApproval(approval, now);
      if (verdict.ok) validSigned.push(approval);
    }
    if (validSigned.length === 0) {
      throw httpError(403, "Purge requires valid signed ops + arbitration approvals");
    }
  } else {
    // Legacy behavior: distinct role labels (ops + arbitration) required.
    const roles = new Set(approvals.map((approval) => approval.role));
    if (!roles.has("ops") || !roles.has("arbitration")) {
      throw httpError(403, "Purge requires dual authorization: distinct ops + arbitration approvals");
    }
  }

  for (const dealId of registry.listDealIds()) {
    const settledAt = registry.getSettlement(dealId);
    if (settledAt === null || !dueForPurge("originals", settledAt, now)) {
      skipped.push(dealId);
      continue;
    }
    for (const entry of registry.getManifest(dealId)) {
      if (registry.isBlobPurged(dealId, entry.fileHash)) continue;
      if (strict) {
        const applicable = validSigned.filter(
          (approval) =>
            approval.policy === "originals" &&
            approval.dealId.toLowerCase() === dealId.toLowerCase() &&
            (approval.fileHash === undefined ||
              approval.fileHash.toLowerCase() === entry.fileHash.toLowerCase()),
        );
        const roles = new Set(applicable.map((approval) => approval.role));
        const approvers = new Set(applicable.map((approval) => approval.approver.toLowerCase()));
        if (!roles.has("ops") || !roles.has("arbitration") || approvers.size < 2) {
          const outcome = registry.recordPurgeOutcome({
            dealId,
            fileHash: entry.fileHash,
            outcome: "skipped",
            reason: "missing signed ops+arbitration approvals for this object",
            at: now,
          });
          outcomes.push(outcome);
          continue;
        }
      }
      try {
        await blobstore.delete(dealId, entry.fileHash);
        registry.markBlobPurged(dealId, entry.fileHash, now);
        purged.push({ dealId, fileHash: entry.fileHash });
        outcomes.push(registry.recordPurgeOutcome({ dealId, fileHash: entry.fileHash, outcome: "purged", at: now }));
      } catch (error) {
        outcomes.push(
          registry.recordPurgeOutcome({
            dealId,
            fileHash: entry.fileHash,
            outcome: "error",
            reason: error instanceof Error ? error.message : "delete failed",
            at: now,
          }),
        );
      }
    }
  }
  return { purged, skipped, outcomes };
}
