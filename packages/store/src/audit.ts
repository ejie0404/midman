// Redacted audit logging. Invitation tokens, signatures, and secrets MUST NOT enter logs.
const SENSITIVE_KEYS = new Set([
  "invitationToken",
  "invitation_token",
  "signature",
  "sessionToken",
  "secret",
  "password",
  "mnemonic",
  "privateKey",
]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

export interface AuditEvent {
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly dealId?: string;
  readonly details?: unknown;
}

export function auditLog(event: Omit<AuditEvent, "at">): AuditEvent {
  const entry: AuditEvent = { ...event, at: new Date().toISOString(), details: redact(event.details) };
  // Durable append-only store is wired in Phase 6; stdout is the dev sink (still redacted).
  console.log(JSON.stringify({ audit: entry }));
  return entry;
}
