// Durable auth-state boundary (Round-2 Phase 2).
//
// Challenges, consumed nonces, session revocations, invitation state, and the
// append-only reviewer-assignment audit used to live in process-local Maps.
// They now sit behind this tiny `AuthPersistence` adapter. The default is an
// in-memory adapter (dev/test, preserving prior behavior); Phase 3 supplies a
// Postgres-backed adapter implementing the same interface WITHOUT touching
// `@midman/store` (`setAuthPersistence(adapter)`).
//
// Invitation redemption is compare-and-set: `redeemInvitation` re-checks the
// stored token hash, expiry, revocation and consumed flag and flips the record
// to consumed inside one call, so a raw invite token is single-use even under
// concurrent accepts.
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Persisted login challenge (mirrors StoredLoginChallenge in challenge.ts). */
export interface PersistedChallenge {
  readonly domain: string;
  readonly chainId: number;
  readonly wallet: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly purpose: string;
  readonly issuedAt: number;
  readonly uri: string;
  consumed: boolean;
}

/** Durable invitation state. Only sha256(token) is ever stored. */
export interface StoredInvitation {
  readonly draftId: string;
  readonly dealId: string;
  readonly tokenHash: string;
  readonly intendedCounterparty: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  revoked: boolean;
  consumed: boolean;
  redeemedBy: string | null;
  redeemTx: string | null;
}

export type RedeemFailureReason =
  | "unknown"
  | "expired"
  | "revoked"
  | "consumed"
  | "bad-token"
  | "wrong-wallet";

export type RedeemInvitationResult =
  | { readonly ok: true; readonly invitation: StoredInvitation }
  | { readonly ok: false; readonly reason: RedeemFailureReason };

/** Append-only reviewer-assignment audit entry. */
export interface AssignmentAuditEntry {
  readonly dealId: string;
  readonly action: "assign" | "recuse";
  readonly actor: string;
  readonly operatorRole: "arbitration";
  /** True only when validated against the on-chain panel for `authEpoch`. */
  readonly verified: boolean;
  readonly attestation: string | null;
  readonly authEpoch: string | null;
  readonly primary?: readonly string[];
  readonly fallback?: readonly string[];
  readonly reviewer?: string;
  readonly reason?: string;
  readonly at: string;
}

export interface RedeemInvitationInput {
  readonly tokenHash: string;
  readonly wallet: string;
  readonly nowIso: string;
  readonly redeemTx?: string | null;
}

/**
 * Single durability contract for auth state. Implementations MUST treat
 * `redeemInvitation` as compare-and-set (atomic single-use redemption).
 */
export interface AuthPersistence {
  putChallenge(nonce: string, challenge: PersistedChallenge): Promise<void>;
  getChallenge(nonce: string): Promise<PersistedChallenge | null>;
  /** Remove-and-return the challenge; concurrent callers see at most one hit. */
  delConsumeChallenge(nonce: string): Promise<PersistedChallenge | null>;
  revokeSession(nonce: string): Promise<void>;
  isRevoked(nonce: string): Promise<boolean>;
  recordInvitation(invitation: StoredInvitation): Promise<void>;
  getInvitation(draftId: string): Promise<StoredInvitation | null>;
  redeemInvitation(draftId: string, input: RedeemInvitationInput): Promise<RedeemInvitationResult>;
  revokeInvitation(draftId: string): Promise<void>;
  appendAssignmentAudit(entry: AssignmentAuditEntry): Promise<void>;
  listAssignmentAudit(dealId?: string): Promise<AssignmentAuditEntry[]>;
  /** Optional: enables revocation hydration after a restart (Phase 3). */
  listRevokedSessions?(): Promise<string[]>;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

const MEMORY_CHALLENGE_CAP = 20_000;

/** In-memory adapter (default). Also the fallback when no durable adapter is set. */
export class MemoryAuthPersistence implements AuthPersistence {
  private readonly challenges = new Map<string, PersistedChallenge>();
  private readonly revoked = new Set<string>();
  private readonly invitations = new Map<string, StoredInvitation>();
  private readonly assignmentAudit = new Map<string, AssignmentAuditEntry[]>();
  private readonly assignmentAuditAll: AssignmentAuditEntry[] = [];

  async putChallenge(nonce: string, challenge: PersistedChallenge): Promise<void> {
    // Bounded like the challenge cache: unauthenticated issuance must not
    // grow memory without limit (oldest evicted first).
    while (this.challenges.size >= MEMORY_CHALLENGE_CAP) {
      const oldest = this.challenges.keys().next();
      if (oldest.done) break;
      this.challenges.delete(oldest.value);
    }
    this.challenges.set(nonce.toLowerCase(), { ...challenge });
  }

  async getChallenge(nonce: string): Promise<PersistedChallenge | null> {
    const record = this.challenges.get(nonce.toLowerCase());
    return record ? { ...record } : null;
  }

  async delConsumeChallenge(nonce: string): Promise<PersistedChallenge | null> {
    const key = nonce.toLowerCase();
    const record = this.challenges.get(key) ?? null;
    if (record) this.challenges.delete(key);
    return record ? { ...record } : null;
  }

  async revokeSession(nonce: string): Promise<void> {
    this.revoked.add(nonce);
  }

  async isRevoked(nonce: string): Promise<boolean> {
    return this.revoked.has(nonce);
  }

  async listRevokedSessions(): Promise<string[]> {
    return [...this.revoked];
  }

  async recordInvitation(invitation: StoredInvitation): Promise<void> {
    this.invitations.set(invitation.draftId.toLowerCase(), { ...invitation });
  }

  async getInvitation(draftId: string): Promise<StoredInvitation | null> {
    const record = this.invitations.get(draftId.toLowerCase());
    return record ? { ...record } : null;
  }

  async redeemInvitation(draftId: string, input: RedeemInvitationInput): Promise<RedeemInvitationResult> {
    const key = draftId.toLowerCase();
    const record = this.invitations.get(key);
    if (!record) return { ok: false, reason: "unknown" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (record.consumed) return { ok: false, reason: "consumed" };
    if (input.nowIso >= record.expiresAt) return { ok: false, reason: "expired" };
    if (!constantTimeHexEqual(record.tokenHash, input.tokenHash)) return { ok: false, reason: "bad-token" };
    if (
      record.intendedCounterparty !== null &&
      record.intendedCounterparty.toLowerCase() !== input.wallet.toLowerCase()
    ) {
      return { ok: false, reason: "wrong-wallet" };
    }
    const updated: StoredInvitation = {
      ...record,
      consumed: true,
      redeemedBy: input.wallet,
      redeemTx: input.redeemTx ?? null,
    };
    this.invitations.set(key, updated);
    return { ok: true, invitation: { ...updated } };
  }

  async revokeInvitation(draftId: string): Promise<void> {
    const key = draftId.toLowerCase();
    const record = this.invitations.get(key);
    if (record) this.invitations.set(key, { ...record, revoked: true });
  }

  async appendAssignmentAudit(entry: AssignmentAuditEntry): Promise<void> {
    const key = entry.dealId.toLowerCase();
    const list = this.assignmentAudit.get(key) ?? [];
    const copy: AssignmentAuditEntry = { ...entry };
    list.push(copy);
    this.assignmentAudit.set(key, list);
    this.assignmentAuditAll.push(copy);
  }

  async listAssignmentAudit(dealId?: string): Promise<AssignmentAuditEntry[]> {
    if (dealId === undefined) return this.assignmentAuditAll.map((entry) => ({ ...entry }));
    return (this.assignmentAudit.get(dealId.toLowerCase()) ?? []).map((entry) => ({ ...entry }));
  }
}

let activeAdapter: AuthPersistence = new MemoryAuthPersistence();

/**
 * The durable store surface this adapter needs. Satisfied by @midman/store
 * (`hasAuthStateStore`) — a scoped kv plus optional transactions.
 */
export interface AuthKvStore {
  authGet(scope: string, key: string): Promise<unknown | null>;
  authPut(scope: string, key: string, value: unknown, expiresAt?: string | null): Promise<void>;
  authDelete(scope: string, key: string): Promise<void>;
  authList(scope: string): Promise<Array<{ key: string; value: unknown; expiresAt?: string | null }>>;
  /** Atomic delete-and-return; required for single-use challenge consumption. */
  authConsume?(scope: string, key: string): Promise<unknown | null>;
  /** Row-locked read for compare-and-set inside `withTransaction`. */
  authGetForUpdate?(scope: string, key: string): Promise<unknown | null>;
  withTransaction?<T>(fn: (store: AuthKvStore) => Promise<T>): Promise<T>;
}

const SCOPE = {
  challenge: "auth.challenge",
  revoked: "auth.session-revoked",
  invitation: "auth.invitation",
  auditAll: "auth.assignment-audit",
  auditDeal: (dealId: string) => `auth.assignment-audit:${dealId.toLowerCase()}`,
} as const;

/**
 * Durable domain adapter over the store's scoped auth kv. `redeemInvitation`
 * and `revokeInvitation` run inside a transaction when the store supports it,
 * making invitation redemption compare-and-set (single-use) across processes.
 */
export function createStoreAuthPersistence(store: AuthKvStore): AuthPersistence {
  const read = async <T>(scope: string, key: string): Promise<T | null> =>
    (await store.authGet(scope, key)) as T | null;
  return {
    async putChallenge(nonce, challenge) {
      await store.authPut(SCOPE.challenge, nonce.toLowerCase(), challenge, new Date(challenge.expiresAt * 1000).toISOString());
    },
    async getChallenge(nonce) {
      return read<PersistedChallenge>(SCOPE.challenge, nonce.toLowerCase());
    },
    async delConsumeChallenge(nonce) {
      const key = nonce.toLowerCase();
      // Preferred path: a single DELETE ... RETURNING is atomic even without an
      // explicit transaction, so concurrent verifies cannot both win.
      if (typeof store.authConsume === "function") {
        return (await store.authConsume(SCOPE.challenge, key)) as PersistedChallenge | null;
      }
      // Fallback (legacy adapters): lock the row to serialize the read+delete.
      const run = async (tx: AuthKvStore) => {
        const reader = tx.authGetForUpdate ?? tx.authGet;
        const record = (await reader.call(tx, SCOPE.challenge, key)) as PersistedChallenge | null;
        if (record) await tx.authDelete(SCOPE.challenge, key);
        return record;
      };
      return store.withTransaction ? store.withTransaction(run) : run(store);
    },
    async revokeSession(nonce) {
      await store.authPut(SCOPE.revoked, nonce, true);
    },
    async isRevoked(nonce) {
      return (await store.authGet(SCOPE.revoked, nonce)) !== null;
    },
    async listRevokedSessions() {
      return (await store.authList(SCOPE.revoked)).map((e) => e.key);
    },
    async recordInvitation(invitation) {
      await store.authPut(SCOPE.invitation, invitation.draftId.toLowerCase(), invitation, invitation.expiresAt);
    },
    async getInvitation(draftId) {
      return read<StoredInvitation>(SCOPE.invitation, draftId.toLowerCase());
    },
    async redeemInvitation(draftId, input) {
      const key = draftId.toLowerCase();
      const run = async (tx: AuthKvStore): Promise<RedeemInvitationResult> => {
        // Row-locked read: a second transaction blocks until the first commits,
        // then observes `consumed` and loses the CAS.
        const reader = tx.authGetForUpdate ?? tx.authGet;
        const record = (await reader.call(tx, SCOPE.invitation, key)) as StoredInvitation | null;
        if (!record) return { ok: false, reason: "unknown" };
        if (record.revoked) return { ok: false, reason: "revoked" };
        if (record.consumed) return { ok: false, reason: "consumed" };
        if (input.nowIso >= record.expiresAt) return { ok: false, reason: "expired" };
        if (!constantTimeHexEqual(record.tokenHash, input.tokenHash)) return { ok: false, reason: "bad-token" };
        if (
          record.intendedCounterparty !== null &&
          record.intendedCounterparty.toLowerCase() !== input.wallet.toLowerCase()
        ) {
          return { ok: false, reason: "wrong-wallet" };
        }
        const updated: StoredInvitation = {
          ...record,
          consumed: true,
          redeemedBy: input.wallet,
          redeemTx: input.redeemTx ?? null,
        };
        await tx.authPut(SCOPE.invitation, key, updated, updated.expiresAt);
        return { ok: true, invitation: updated };
      };
      return store.withTransaction ? store.withTransaction(run) : run(store);
    },
    async revokeInvitation(draftId) {
      const key = draftId.toLowerCase();
      const run = async (tx: AuthKvStore) => {
        const reader = tx.authGetForUpdate ?? tx.authGet;
        const record = (await reader.call(tx, SCOPE.invitation, key)) as StoredInvitation | null;
        if (record) await tx.authPut(SCOPE.invitation, key, { ...record, revoked: true }, record.expiresAt);
      };
      await (store.withTransaction ? store.withTransaction(run) : run(store));
    },
    async appendAssignmentAudit(entry) {
      const key = `${entry.at}|${randomBytes(8).toString("hex")}`;
      await store.authPut(SCOPE.auditDeal(entry.dealId), key, entry, null);
      await store.authPut(SCOPE.auditAll, key, entry, null);
    },
    async listAssignmentAudit(dealId) {
      const scope = dealId === undefined ? SCOPE.auditAll : SCOPE.auditDeal(dealId);
      const rows = await store.authList(scope);
      return rows
        .map((e) => e.value as AssignmentAuditEntry)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    },
  };
}

/** Install the active adapter (null restores the in-memory default). */
export function setAuthPersistence(adapter: AuthPersistence | null): void {
  activeAdapter = adapter ?? new MemoryAuthPersistence();
}

export function getAuthPersistence(): AuthPersistence {
  return activeAdapter;
}

/** Generate a fresh opaque invitation token (256-bit). */
export function newInvitationSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Test helper: restore a fresh in-memory adapter. */
export function __resetAuthPersistenceForTests(): void {
  activeAdapter = new MemoryAuthPersistence();
}
