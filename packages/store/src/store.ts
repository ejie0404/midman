// Store: Postgres when DATABASE_URL is set, in-memory otherwise.
// Same interface both ways so dev/test run without docker.
import { PgStore } from "./pg.js";
import { createPgExecutor, pgExecutorOptionsFromEnv, type SqlExecutor } from "./sql.js";

export interface DraftRecord {
  readonly id: string;
  readonly dealId: string;
  readonly creatorWallet: string;
  readonly counterpartyHint: string | null;
  counterpartyAddress: string | null;
  terms: Record<string, string>;
  signatures: Record<string, string>;
  admission: Record<string, string> | null;
  revocationNote: Record<string, string> | null;
  status: string;
  /** Optimistic-concurrency version; 0 for newly created records. */
  readonly version?: number;
}

export interface ChainEventRow {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly contractAddress: string;
  readonly dealId: string | null;
  readonly eventName: string;
  readonly args: Record<string, unknown>;
  orphaned: boolean;
}

export interface IndexerTip {
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export interface RelayJob {
  readonly idempotencyKey: string;
  readonly queue: string;
  readonly action: string;
  readonly params: Record<string, unknown>;
  status: string;
  attempts: number;
  txHash: string | null;
  result: Record<string, unknown> | null;
  /** Lease owner (worker id) while processing, else null. */
  leaseOwner?: string | null;
  /** Lease expiry (ISO-8601) while processing, else null. */
  leaseExpiresAt?: string | null;
  /** Optimistic-concurrency version for lease updates. */
  version?: number;
}

export interface InvitationRecord {
  readonly tokenHash: string;
  /** Local draft id (invitations are pre-funding private records). */
  readonly dealId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

export interface DealMetaRecord {
  readonly dealId: string;
  readonly source: string;
  readonly firstSeenAt: string;
  readonly updatedAt: string;
}

export interface KvEntry {
  readonly key: string;
  readonly value: unknown;
}

export interface VersionedValue {
  readonly value: unknown;
  readonly version: number;
}

export interface AuthStateEntry {
  readonly key: string;
  readonly value: unknown;
  readonly expiresAt: string | null;
}

/** Optimistic-concurrency conflict (409). */
export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface Store {
  createDraft(draft: DraftRecord): Promise<void>;
  getDraft(id: string): Promise<DraftRecord | null>;
  getDraftByDeal(dealId: string): Promise<DraftRecord | null>;
  updateDraft(id: string, patch: Partial<DraftRecord>): Promise<void>;
  /** Compare-and-set update; throws ConflictError on version mismatch. Returns the new version. */
  updateDraftCas(id: string, expectedVersion: number, patch: Partial<DraftRecord>): Promise<number>;
  /** JSONB merge of one signature slot under a row lock (both parties persist). */
  mergeDraftSignature(id: string, role: string, signature: string): Promise<void>;
  putEvents(events: ChainEventRow[]): Promise<number>;
  getEventsByDeal(dealId: string): Promise<ChainEventRow[]>;
  /** Distinct, non-orphaned deal ids seen in chain events (audit #10). */
  listChainEventDealIds(): Promise<string[]>;
  blockHashAt(contract: string, blockNumber: bigint): Promise<string | null>;
  markOrphanedFrom(contract: string, blockNumber: bigint): Promise<number>;
  getTip(contract: string): Promise<IndexerTip | null>;
  setTip(contract: string, tip: IndexerTip): Promise<void>;
  clearContractData(contract: string): Promise<void>;
  enqueueRelay(job: RelayJob): Promise<{ inserted: boolean; existing: RelayJob | null }>;
  getRelay(key: string): Promise<RelayJob | null>;
  claimRelay(key: string): Promise<RelayJob | null>;
  /** Atomic lease claim: queued or processing-with-expired-lease -> processing. */
  claimRelayLease(key: string, owner: string, ttlSeconds: number): Promise<RelayJob | null>;
  /** Extend a held lease; false when the caller no longer owns it. */
  renewRelayLease(key: string, owner: string, ttlSeconds: number): Promise<boolean>;
  /** Reset expired processing leases back to queued. Returns rows affected. */
  reapExpiredRelayLeases(): Promise<number>;
  finishRelay(key: string, status: string, txHash: string | null, result: Record<string, unknown> | null): Promise<void>;
  /**
   * Ownership-guarded finish: mutates the job ONLY while `owner` still holds
   * the lease. Returns false when the lease was lost, so a stale worker never
   * overwrites the state of the worker that actually owns the job.
   */
  finishRelayOwned(
    key: string,
    status: string,
    txHash: string | null,
    result: Record<string, unknown> | null,
    owner: string,
  ): Promise<boolean>;
  listQueuedRelay(queue: string, limit: number): Promise<RelayJob[]>;
  /**
   * Mandatory recovery query: every job in a given lifecycle status (newest
   * first). Used by the worker to discover 'processing', 'submitted',
   * 'failed' and 'queued' work without optional capability probing.
   */
  listRelayByStatus(status: string, limit: number): Promise<RelayJob[]>;
  recordSponsor(txHash: string, dealId: string | null, action: string): Promise<void>;
  countSponsorsSince(sinceIso: string): Promise<number>;
  /** Transactional sponsorship reservation: advisory-locked count + insert. */
  reserveSponsorship(
    txHash: string,
    dealId: string | null,
    action: string,
    limit: number,
    sinceIso: string,
  ): Promise<{ granted: boolean; count: number }>;
  listDealIds(): Promise<string[]>;
  recordDealMeta(dealId: string, source: string): Promise<void>;

  // ---- Registry / durable metadata kv (RegistryKvStore-compatible) ----
  kvGet(ns: string, dealId: string, key: string): Promise<unknown | null>;
  kvGetWithVersion(ns: string, dealId: string, key: string): Promise<VersionedValue | null>;
  kvList(ns: string, dealId: string): Promise<KvEntry[]>;
  kvPut(ns: string, dealId: string, key: string, value: unknown): Promise<void>;
  /** Create-only put: returns false if the key already exists (single-use slots). */
  kvPutIfAbsent(ns: string, dealId: string, key: string, value: unknown): Promise<boolean>;
  /** Compare-and-set put; throws ConflictError when the expected version is stale. */
  kvPutCas(ns: string, dealId: string, key: string, value: unknown, expectedVersion: number): Promise<number>;
  kvDelete(ns: string, dealId: string, key: string): Promise<void>;
  /** Alias of kvDelete (Phase-2 AuthPersistence surface). */
  kvDel(ns: string, dealId: string, key: string): Promise<void>;
  kvDeals(ns: string): Promise<string[]>;

  // ---- Database-backed sequences ----
  /** Monotonic, collision-safe counter (invitation ids, message/manifest seq). */
  nextSeq(name: string): Promise<number>;

  // ---- Auth state (challenges / nonces / revocations) ----
  authGet(scope: string, key: string): Promise<unknown | null>;
  authPut(scope: string, key: string, value: unknown, expiresAt?: string | null): Promise<void>;
  authDelete(scope: string, key: string): Promise<void>;
  authList(scope: string): Promise<AuthStateEntry[]>;
  /**
   * Atomically delete-and-return the value (single `DELETE ... RETURNING` in
   * SQL). Exactly one concurrent caller receives a non-null result; this is the
   * single-use primitive for login-challenge consumption.
   */
  authConsume(scope: string, key: string): Promise<unknown | null>;
  /**
   * Read a row under an exclusive lock so a compare-and-set can run atomically
   * inside `withTransaction` on Postgres. Falls back to `authGet` where row
   * locks are not available (in-memory).
   */
  authGetForUpdate(scope: string, key: string): Promise<unknown | null>;

  // ---- Invitations / revocations ----
  saveInvitation(record: InvitationRecord): Promise<void>;
  getInvitation(tokenHash: string): Promise<InvitationRecord | null>;
  revokeInvitation(tokenHash: string): Promise<void>;
  /** Atomic redemption: consume the token and assign the draft counterparty. */
  redeemInvitation(input: {
    draftId: string;
    tokenHash: string;
    counterpartyAddress: string;
  }): Promise<{ redeemed: boolean; reason?: string }>;

  // ---- Transactions + lifecycle ----
  /** Run `fn` atomically when the backing supports it (Row-level commit/rollback). */
  withTransaction<T>(fn: (store: Store) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function key(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

function normalizeDeal(dealId: string): string {
  return dealId.toLowerCase();
}

export class MemoryStore implements Store {
  private drafts = new Map<string, DraftRecord>();
  private events = new Map<string, ChainEventRow>();
  private tips = new Map<string, IndexerTip>();
  private relay = new Map<string, RelayJob>();
  private sponsors: Array<{ txHash: string; dealId: string | null; action: string; at: string }> = [];
  private kv = new Map<string, Map<string, Map<string, { value: unknown; version: number }>>>();
  private seq = new Map<string, number>();
  private auth = new Map<string, Map<string, { value: unknown; expiresAt: string | null }>>();
  private invitations = new Map<string, InvitationRecord>();
  private dealsMeta = new Map<string, DealMetaRecord>();

  async createDraft(draft: DraftRecord): Promise<void> {
    this.drafts.set(draft.id, { ...draft, version: draft.version ?? 0 });
  }
  async getDraft(id: string): Promise<DraftRecord | null> {
    const draft = this.drafts.get(id);
    return draft ? { ...draft } : null;
  }
  async getDraftByDeal(dealId: string): Promise<DraftRecord | null> {
    for (const draft of this.drafts.values()) {
      if (draft.dealId.toLowerCase() === dealId.toLowerCase()) return { ...draft };
    }
    return null;
  }
  async updateDraft(id: string, patch: Partial<DraftRecord>): Promise<void> {
    const current = this.drafts.get(id);
    if (!current) throw new Error("Draft not found");
    this.drafts.set(id, { ...current, ...patch, version: (current.version ?? 0) + 1 });
  }
  async updateDraftCas(id: string, expectedVersion: number, patch: Partial<DraftRecord>): Promise<number> {
    const current = this.drafts.get(id);
    if (!current) throw new Error("Draft not found");
    if ((current.version ?? 0) !== expectedVersion) {
      throw new ConflictError(`Draft ${id} version conflict: expected ${expectedVersion}, found ${current.version ?? 0}`);
    }
    const next = (current.version ?? 0) + 1;
    this.drafts.set(id, { ...current, ...patch, version: next });
    return next;
  }
  async mergeDraftSignature(id: string, role: string, signature: string): Promise<void> {
    const current = this.drafts.get(id);
    if (!current) throw new Error("Draft not found");
    const signatures = { ...current.signatures, [role]: signature };
    const status = Object.keys(signatures).length >= 1 ? "signed" : current.status;
    this.drafts.set(id, { ...current, signatures, status, version: (current.version ?? 0) + 1 });
  }
  async putEvents(events: ChainEventRow[]): Promise<number> {
    let added = 0;
    for (const event of events) {
      const k = key(event.txHash, event.logIndex);
      const existing = this.events.get(k);
      if (existing) {
        // Re-included after a reorg: clear the orphan flag and refresh the
        // block linkage instead of skipping the row (audit #10).
        this.events.set(k, {
          ...existing,
          orphaned: false,
          blockHash: event.blockHash,
          blockNumber: event.blockNumber,
        });
        continue;
      }
      this.events.set(k, { ...event });
      added += 1;
      if (event.dealId !== null && !event.orphaned) {
        this.dealsMeta.set(normalizeDeal(event.dealId), {
          dealId: event.dealId,
          source: "chain",
          firstSeenAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return added;
  }
  async getEventsByDeal(dealId: string): Promise<ChainEventRow[]> {
    return [...this.events.values()]
      .filter((e) => e.dealId !== null && e.dealId.toLowerCase() === dealId.toLowerCase() && !e.orphaned)
      .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
  }
  async listChainEventDealIds(): Promise<string[]> {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const event of this.events.values()) {
      if (event.dealId === null || event.orphaned) continue;
      const lower = event.dealId.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(event.dealId);
    }
    return out;
  }
  async markOrphanedFrom(contract: string, blockNumber: bigint): Promise<number> {
    let count = 0;
    for (const event of this.events.values()) {
      if (event.contractAddress.toLowerCase() === contract.toLowerCase() && event.blockNumber >= blockNumber && !event.orphaned) {
        event.orphaned = true;
        count += 1;
      }
    }
    return count;
  }
  async blockHashAt(contract: string, blockNumber: bigint): Promise<string | null> {
    for (const event of this.events.values()) {
      if (
        event.contractAddress.toLowerCase() === contract.toLowerCase() &&
        event.blockNumber === blockNumber &&
        !event.orphaned
      ) {
        return event.blockHash;
      }
    }
    return null;
  }
  async getTip(contract: string): Promise<IndexerTip | null> {
    return this.tips.get(contract.toLowerCase()) ?? null;
  }
  async setTip(contract: string, tip: IndexerTip): Promise<void> {
    this.tips.set(contract.toLowerCase(), tip);
  }
  async clearContractData(contract: string): Promise<void> {
    const lower = contract.toLowerCase();
    for (const k of [...this.events.keys()]) {
      if (this.events.get(k)!.contractAddress.toLowerCase() === lower) this.events.delete(k);
    }
    this.tips.delete(lower);
  }
  async enqueueRelay(job: RelayJob): Promise<{ inserted: boolean; existing: RelayJob | null }> {
    const existing = this.relay.get(job.idempotencyKey);
    if (existing) return { inserted: false, existing: { ...existing } };
    this.relay.set(job.idempotencyKey, { ...job, version: job.version ?? 0 });
    return { inserted: true, existing: null };
  }
  async getRelay(key: string): Promise<RelayJob | null> {
    const job = this.relay.get(key);
    return job ? { ...job } : null;
  }
  async claimRelay(key: string): Promise<RelayJob | null> {
    const job = this.relay.get(key);
    if (!job || job.status !== "queued") return null;
    job.status = "processing";
    job.attempts += 1;
    job.version = (job.version ?? 0) + 1;
    return { ...job };
  }
  async claimRelayLease(key: string, owner: string, ttlSeconds: number): Promise<RelayJob | null> {
    const job = this.relay.get(key);
    if (!job) return null;
    const now = Date.now();
    const leaseExpired = job.leaseExpiresAt == null || new Date(job.leaseExpiresAt).getTime() < now;
    if (job.status !== "queued" && !(job.status === "processing" && leaseExpired)) return null;
    job.status = "processing";
    job.attempts += 1;
    job.leaseOwner = owner;
    job.leaseExpiresAt = new Date(now + ttlSeconds * 1_000).toISOString();
    job.version = (job.version ?? 0) + 1;
    return { ...job };
  }
  async renewRelayLease(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const job = this.relay.get(key);
    if (!job || job.status !== "processing" || job.leaseOwner !== owner) return false;
    job.leaseExpiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    job.version = (job.version ?? 0) + 1;
    return true;
  }
  async reapExpiredRelayLeases(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const job of this.relay.values()) {
      if (
        job.status === "processing" &&
        job.leaseExpiresAt != null &&
        new Date(job.leaseExpiresAt).getTime() < now
      ) {
        job.status = "queued";
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.version = (job.version ?? 0) + 1;
        count += 1;
      }
    }
    return count;
  }
  async finishRelay(
    key: string,
    status: string,
    txHash: string | null,
    result: Record<string, unknown> | null,
  ): Promise<void> {
    const job = this.relay.get(key);
    if (!job) return;
    job.status = status;
    job.txHash = txHash;
    job.result = result;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.version = (job.version ?? 0) + 1;
  }
  async finishRelayOwned(
    key: string,
    status: string,
    txHash: string | null,
    result: Record<string, unknown> | null,
    owner: string,
  ): Promise<boolean> {
    const job = this.relay.get(key);
    if (!job || job.leaseOwner !== owner) return false;
    job.status = status;
    job.txHash = txHash;
    job.result = result;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.version = (job.version ?? 0) + 1;
    return true;
  }
  async listQueuedRelay(queue: string, limit: number): Promise<RelayJob[]> {
    return [...this.relay.values()].filter((j) => j.queue === queue && j.status === "queued").slice(0, limit);
  }
  async listRelayByStatus(status: string, limit: number): Promise<RelayJob[]> {
    return [...this.relay.values()]
      .filter((j) => j.status === status)
      .slice(0, Math.max(0, limit))
      .map((j) => ({ ...j }));
  }
  async recordSponsor(txHash: string, dealId: string | null, action: string): Promise<void> {
    this.sponsors.push({ txHash, dealId, action, at: new Date().toISOString() });
  }
  async countSponsorsSince(sinceIso: string): Promise<number> {
    return this.sponsors.filter((s) => s.at >= sinceIso).length;
  }
  async reserveSponsorship(
    txHash: string,
    dealId: string | null,
    action: string,
    limit: number,
    sinceIso: string,
  ): Promise<{ granted: boolean; count: number }> {
    const count = this.sponsors.filter((s) => s.at >= sinceIso).length;
    if (count >= limit) return { granted: false, count };
    this.sponsors.push({ txHash, dealId, action, at: new Date().toISOString() });
    return { granted: true, count: count + 1 };
  }

  async listDealIds(): Promise<string[]> {
    const seen = new Map<string, string>();
    const add = (dealId: string | null | undefined): void => {
      if (typeof dealId !== "string" || dealId.length === 0) return;
      const lower = dealId.toLowerCase();
      if (!seen.has(lower)) seen.set(lower, dealId);
    };
    for (const draft of this.drafts.values()) add(draft.dealId);
    for (const event of this.events.values()) if (!event.orphaned) add(event.dealId);
    for (const deals of this.kv.values()) for (const dealId of deals.keys()) add(dealId);
    for (const meta of this.dealsMeta.values()) add(meta.dealId);
    return [...seen.values()];
  }

  async recordDealMeta(dealId: string, source: string): Promise<void> {
    const lower = normalizeDeal(dealId);
    const existing = this.dealsMeta.get(lower);
    this.dealsMeta.set(lower, {
      dealId,
      source,
      firstSeenAt: existing?.firstSeenAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  private kvDealMap(ns: string, dealId: string, create: boolean): Map<string, { value: unknown; version: number }> | undefined {
    let byNs = this.kv.get(ns);
    if (!byNs && create) {
      byNs = new Map();
      this.kv.set(ns, byNs);
    }
    if (!byNs) return undefined;
    const lower = normalizeDeal(dealId);
    let byDeal = byNs.get(lower);
    if (!byDeal && create) {
      byDeal = new Map();
      byNs.set(lower, byDeal);
    }
    return byDeal;
  }

  async kvGet(ns: string, dealId: string, key: string): Promise<unknown | null> {
    const entry = this.kvDealMap(ns, dealId, false)?.get(key);
    return entry === undefined ? null : entry.value;
  }
  async kvGetWithVersion(ns: string, dealId: string, key: string): Promise<VersionedValue | null> {
    const entry = this.kvDealMap(ns, dealId, false)?.get(key);
    return entry === undefined ? null : { value: entry.value, version: entry.version };
  }
  async kvList(ns: string, dealId: string): Promise<KvEntry[]> {
    const byDeal = this.kvDealMap(ns, dealId, false);
    if (!byDeal) return [];
    return [...byDeal.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, entry]) => ({ key, value: entry.value }));
  }
  async kvPut(ns: string, dealId: string, key: string, value: unknown): Promise<void> {
    const byDeal = this.kvDealMap(ns, dealId, true)!;
    const existing = byDeal.get(key);
    byDeal.set(key, { value, version: existing ? existing.version + 1 : 1 });
    this.dealsMeta.set(normalizeDeal(dealId), {
      dealId,
      source: "registry",
      firstSeenAt: this.dealsMeta.get(normalizeDeal(dealId))?.firstSeenAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  async kvPutIfAbsent(ns: string, dealId: string, key: string, value: unknown): Promise<boolean> {
    const byDeal = this.kvDealMap(ns, dealId, false);
    if (byDeal?.has(key)) return false;
    this.kvDealMap(ns, dealId, true)!.set(key, { value, version: 1 });
    this.dealsMeta.set(normalizeDeal(dealId), {
      dealId,
      source: "registry",
      firstSeenAt: this.dealsMeta.get(normalizeDeal(dealId))?.firstSeenAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async kvPutCas(ns: string, dealId: string, key: string, value: unknown, expectedVersion: number): Promise<number> {
    const byDeal = this.kvDealMap(ns, dealId, false);
    const existing = byDeal?.get(key);
    const current = existing?.version ?? 0;
    if (current !== expectedVersion) {
      throw new ConflictError(`registry_kv conflict for ${ns}/${dealId}/${key}: expected ${expectedVersion}, found ${current}`);
    }
    const next = expectedVersion + 1;
    this.kvDealMap(ns, dealId, true)!.set(key, { value, version: next });
    return next;
  }
  async kvDelete(ns: string, dealId: string, key: string): Promise<void> {
    this.kvDealMap(ns, dealId, false)?.delete(key);
  }
  async kvDel(ns: string, dealId: string, key: string): Promise<void> {
    return this.kvDelete(ns, dealId, key);
  }
  async kvDeals(ns: string): Promise<string[]> {
    const byNs = this.kv.get(ns);
    if (!byNs) return [];
    return [...byNs.keys()].sort();
  }

  async nextSeq(name: string): Promise<number> {
    const next = (this.seq.get(name) ?? 0) + 1;
    this.seq.set(name, next);
    return next;
  }

  async authGet(scope: string, key: string): Promise<unknown | null> {
    const entry = this.auth.get(scope)?.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= Date.now()) {
      this.auth.get(scope)?.delete(key);
      return null;
    }
    return entry.value;
  }
  async authPut(scope: string, key: string, value: unknown, expiresAt: string | null = null): Promise<void> {
    let byScope = this.auth.get(scope);
    if (!byScope) {
      byScope = new Map();
      this.auth.set(scope, byScope);
    }
    byScope.set(key, { value, expiresAt });
  }
  async authDelete(scope: string, key: string): Promise<void> {
    this.auth.get(scope)?.delete(key);
  }
  async authList(scope: string): Promise<AuthStateEntry[]> {
    const byScope = this.auth.get(scope);
    if (!byScope) return [];
    const out: AuthStateEntry[] = [];
    for (const [key, entry] of byScope) {
      if (entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= Date.now()) continue;
      out.push({ key, value: entry.value, expiresAt: entry.expiresAt });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  async authConsume(scope: string, key: string): Promise<unknown | null> {
    // No `await` between the read and the delete, so the get+delete is a single
    // critical section on the event loop: exactly one caller observes the value.
    const byScope = this.auth.get(scope);
    const entry = byScope?.get(key);
    if (!entry) return null;
    byScope!.delete(key);
    if (entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= Date.now()) return null;
    return entry.value;
  }
  async authGetForUpdate(scope: string, key: string): Promise<unknown | null> {
    return this.authGet(scope, key);
  }

  async saveInvitation(record: InvitationRecord): Promise<void> {
    this.invitations.set(record.tokenHash, { ...record });
  }
  async getInvitation(tokenHash: string): Promise<InvitationRecord | null> {
    const record = this.invitations.get(tokenHash);
    return record ? { ...record } : null;
  }
  async revokeInvitation(tokenHash: string): Promise<void> {
    const record = this.invitations.get(tokenHash);
    if (record) this.invitations.set(tokenHash, { ...record, revoked: true });
  }
  async redeemInvitation(input: { draftId: string; tokenHash: string; counterpartyAddress: string }): Promise<{ redeemed: boolean; reason?: string }> {
    const record = this.invitations.get(input.tokenHash);
    if (!record) return { redeemed: false, reason: "unknown-invitation" };
    if (record.revoked) return { redeemed: false, reason: "revoked" };
    if (new Date(record.expiresAt).getTime() <= Date.now()) return { redeemed: false, reason: "expired" };
    const draft = this.drafts.get(input.draftId);
    if (!draft) return { redeemed: false, reason: "unknown-draft" };
    this.invitations.set(input.tokenHash, { ...record, revoked: true });
    this.drafts.set(input.draftId, {
      ...draft,
      counterpartyAddress: input.counterpartyAddress,
      status: "accepted",
      version: (draft.version ?? 0) + 1,
    });
    return { redeemed: true };
  }

  // Serializes in-memory transactions so a read-check-write CAS cannot
  // interleave at an `await` (mirrors Postgres row locking).
  private txChain: Promise<unknown> = Promise.resolve();

  async withTransaction<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    // In-memory store has no rollback; serialize execution to emulate a lock.
    const run = this.txChain.then(() => fn(this));
    this.txChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

/**
 * Union of draft-linked deals, chain-discovered deals (from indexed events)
 * and registry-known deals (deals_meta/kv). Worker passes must use this rather
 * than `listDealIds` so externally funded deals are not invisible.
 * Deduplicates case-insensitively; tolerates stores without the capabilities.
 */
export async function listKnownDealIds(store: Store): Promise<string[]> {
  const seen = new Map<string, string>();
  const add = (dealId: unknown): void => {
    if (typeof dealId !== "string" || dealId.length === 0) return;
    const lower = dealId.toLowerCase();
    if (!seen.has(lower)) seen.set(lower, dealId);
  };
  for (const dealId of await store.listDealIds()) add(dealId);
  if (typeof store.listChainEventDealIds === "function") {
    for (const dealId of await store.listChainEventDealIds()) add(dealId);
  }
  return [...seen.values()];
}

/** Resolve pool sizing from the environment and build a store. */
export function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env["DATABASE_URL"];
  if (url) return new PgStore(createPgExecutor(url, pgExecutorOptionsFromEnv(env)));
  if (env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL required in production; refusing in-memory store");
  }
  return new MemoryStore();
}

export function createStore(executor?: SqlExecutor): Store {
  if (executor) return new PgStore(executor);
  return createStoreFromEnv();
}

/** Release a store's resources (pool) for graceful shutdown. No-op for memory. */
export async function closeStore(store: Store): Promise<void> {
  if (store && typeof store.close === "function") await store.close();
}
