import { createHash, randomBytes } from "node:crypto";

// Private invitations are bearer secrets (256-bit), distinct from dealId/auth.
// Only sha256(token) is stored; tokens are redacted from logs/telemetry.
export function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface InvitationRecord {
  readonly tokenHash: string;
  readonly dealId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

export function isInvitationUsable(record: InvitationRecord, nowIso: string): boolean {
  return !record.revoked && nowIso < record.expiresAt;
}
