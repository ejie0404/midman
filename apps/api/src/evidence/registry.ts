// In-memory evidence manifest registry (P-13 append-only manifest).
// Phase 6/8 runtime uses this registry; hosted pg wiring (migrations/003)
// lands later — see 003_evidence.sql. Each entry chains prevHash == head,
// seq == count, so reviewers can verify the chain off-platform.
//
// Round-2 Phase 6 additions:
//   * `appendManifestAtomic` commits the durable manifest write BEFORE it is
//     acknowledged, coalesces concurrent retries for the same content hash,
//     and is idempotent (a retry with the same fileHash never duplicates an
//     entry). `attachReceiptAtomic` is the receipt counterpart.
//   * `consumeAuthNonce`/`hasAuthNonce` durably record metadata-bound signed
//     request nonces so a replayed signature is rejected across restarts.
//   * `recordAudit`/`getAudit` keep the authenticated export/access audit
//     trail (redacted), and `recordPurgeOutcome`/`getPurgeOutcomes` record
//     retention deletion outcomes while tombstones preserve the manifest.
//
// Retention hooks: per-deal settlement timestamps, dual-role purge
// approvals (ops + arbitration), and blob-purge tombstones. Purge deletes
// ciphertext via the blob store but NEVER deletes manifest entries — the
// tombstone preserves the audit trail (P-12: manifests/proofs 5 years).
import { createHash } from "node:crypto";
import {
  DurableCollection,
  hydrateNamespace,
  orderedKey,
  RegistryWriter,
  type RegistryAdapter,
} from "@midman/store";

export type EvidenceKind = "delivery" | "dispute";

// Durable namespaces (see packages/store/src/registry.ts). Values are JSON.
const MANIFEST_NS = "evidence.manifest";
const HEAD_NS = "evidence.manifest-head";
const PURGE_NS = "evidence.purge-approvals";
const SETTLEMENT_NS = "evidence.settlement";
const TOMBSTONE_NS = "evidence.tombstones";
const NONCE_NS = "evidence.auth-nonces";
const AUDIT_NS = "evidence.audit";
const PURGE_OUTCOME_NS = "evidence.purge-outcomes";

/** Nonce scope key; nonces are globally unique so a single bucket suffices. */
const NONCE_SCOPE = "auth";

export type ScanStatus = "pending" | "clean" | "infected" | "deferred" | "error";

export interface ScanRecord {
  readonly status: ScanStatus;
  readonly detail?: string;
}

export interface ReceiptRef {
  readonly payload: string;
  readonly signature: string;
  readonly signer: string;
  /** Stable receipt signer key id (resolvable after rotation). */
  readonly keyId?: string;
  /** Receipt format version. */
  readonly version?: number;
}

export interface AppendManifestInput {
  readonly uploader: string;
  readonly kind: EvidenceKind;
  readonly description: string;
  readonly fileHash: string;
  readonly prevHash: string;
  readonly scan: ScanRecord;
  readonly filename?: string;
  readonly mimetype?: string;
  readonly size?: number;
  readonly receipt?: ReceiptRef;
  /** Override quarantine state; defaults to true when scan.status === "infected". */
  readonly quarantined?: boolean;
}

export interface ManifestEntry {
  readonly dealId: string;
  readonly seq: number;
  readonly uploader: string;
  readonly kind: EvidenceKind;
  readonly description: string;
  readonly fileHash: string;
  readonly prevHash: string;
  /** Commitment after this entry (the new manifest head). */
  readonly head: string;
  readonly scan: ScanRecord;
  readonly filename: string | null;
  readonly mimetype: string | null;
  readonly size: number | null;
  readonly at: string;
  /** Infected uploads are stored but never served or listed as available. */
  readonly quarantined: boolean;
  receipt?: ReceiptRef | undefined;
}

export interface PurgeApproval {
  readonly role: "ops" | "arbitration";
  readonly signature?: string | undefined;
  readonly at: string;
}

export interface BlobTombstone {
  readonly dealId: string;
  readonly fileHash: string;
  readonly purgedAt: number;
}

export interface UsedNonce {
  readonly nonce: string;
  readonly dealId: string;
  readonly expiresAt: number;
  readonly at: string;
}

export interface AuthNonceInput {
  readonly nonce: string;
  readonly dealId: string;
  readonly expiresAt: number;
  readonly now?: number;
}

export interface EvidenceAuditRecord {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly dealId: string;
  readonly target?: string;
  readonly reason?: string;
  readonly detail?: string;
}

export interface PurgeOutcome {
  readonly dealId: string;
  readonly fileHash: string;
  readonly outcome: "purged" | "skipped" | "error";
  readonly reason?: string;
  readonly at: number;
}

export interface AtomicAppendResult {
  readonly entry: ManifestEntry;
  /** False when an existing identical-content entry was returned (retry). */
  readonly created: boolean;
}

/** Authoritative per-deal append head; CAS-advanced so instances never collide. */
interface ManifestHead {
  readonly seq: number;
  readonly head: string;
}

/** Genesis prevHash for the first manifest entry of a deal. */
export const GENESIS_PREVHASH = `0x${"00".repeat(32)}`;

/** Manifest commitment: sha256(dealId|seq|fileHash|prevHash), 0x-hex. */
export function commitmentFor(dealId: string, seq: number, fileHash: string, prevHash: string): string {
  return `0x${createHash("sha256").update(`${dealId}|${seq}|${fileHash}|${prevHash}`, "utf8").digest("hex")}`;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function scanStatusOf(entry: { quarantined?: boolean; scan?: { status?: string } } | undefined): string {
  if (!entry) return "missing";
  if (entry.quarantined === true) return "quarantined";
  return entry.scan?.status ?? "pending";
}

/** True for scan states that must never be served or acknowledged as usable. */
export function isBlockedScanState(state: string): boolean {
  return state === "infected" || state === "quarantined" || state === "pending" || state === "error";
}

/** True for scan states a normal party download may serve (never claims clean). */
export function isServableScanState(state: string): boolean {
  return state === "clean" || state === "deferred";
}

export interface ManifestRegistry {
  appendManifest(dealId: string, input: AppendManifestInput): ManifestEntry;
  /** Authoritative + idempotent append; awaits the durable commit. */
  appendManifestAtomic(dealId: string, input: AppendManifestInput): Promise<AtomicAppendResult>;
  getManifest(dealId: string): ManifestEntry[];
  getHead(dealId: string): string;
  getByFileHash(dealId: string, fileHash: string): ManifestEntry | null;
  attachReceipt(dealId: string, seq: number, receipt: ReceiptRef): ManifestEntry;
  /** Authoritative receipt attachment (awaits the durable write). */
  attachReceiptAtomic(dealId: string, seq: number, receipt: ReceiptRef): Promise<ManifestEntry>;
  /** Consume a signed-request nonce. Returns false on replay (durable). */
  consumeAuthNonce(input: AuthNonceInput): Promise<boolean>;
  hasAuthNonce(nonce: string, now?: number): boolean;
  recordAudit(
    record: Omit<EvidenceAuditRecord, "id" | "at"> & { id?: string; at?: string },
  ): EvidenceAuditRecord;
  getAudit(dealId: string): EvidenceAuditRecord[];
  getAllAudit(): EvidenceAuditRecord[];
  recordPurgeOutcome(outcome: Omit<PurgeOutcome, "at"> & { at?: number }): PurgeOutcome;
  getPurgeOutcomes(dealId: string): PurgeOutcome[];
  recordPurgeApproval(dealId: string, approval: { role: "ops" | "arbitration"; signature?: string }): PurgeApproval[];
  /** Plural alias of recordPurgeApproval. */
  recordPurgeApprovals(dealId: string, approval: { role: "ops" | "arbitration"; signature?: string }): PurgeApproval[];
  getPurgeApprovals(dealId: string): PurgeApproval[];
  clearPurgeApprovals(dealId: string): void;
  recordSettlement(dealId: string, settledAt: number): void;
  getSettlement(dealId: string): number | null;
  markBlobPurged(dealId: string, fileHash: string, purgedAt: number): void;
  isBlobPurged(dealId: string, fileHash: string): boolean;
  getTombstones(dealId: string): BlobTombstone[];
  listDealIds(): string[];
}

export class InMemoryManifestRegistry implements ManifestRegistry {
  private readonly writer = new RegistryWriter();
  private readonly entries = new DurableCollection<ManifestEntry>(MANIFEST_NS, this.writer, (entry) =>
    orderedKey(entry.seq),
  );
  private readonly approvals = new Map<string, PurgeApproval[]>();
  private readonly settlements = new Map<string, number>();
  private readonly tombstones = new DurableCollection<BlobTombstone>(TOMBSTONE_NS, this.writer, (tomb) =>
    tomb.fileHash.toLowerCase(),
  );
  private readonly authNonces = new Map<string, number>();
  private readonly audits = new Map<string, EvidenceAuditRecord[]>();
  private readonly purgeOutcomes = new Map<string, PurgeOutcome[]>();
  private readonly appendInflight = new Map<string, Promise<AtomicAppendResult>>();

  /** Attach the durability adapter (see configureRegistry). */
  setAdapter(adapter: RegistryAdapter | null): void {
    this.writer.setAdapter(adapter);
  }

  /** Resolve once all queued durable writes have settled. */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** Rebuild the in-memory working set from the adapter (restart / startup). */
  async hydrate(dealIds?: string[]): Promise<void> {
    await this.entries.hydrate(dealIds);
    await this.tombstones.hydrate(dealIds);
    const adapter = this.writer.getAdapter();
    if (!adapter) return;
    await hydrateNamespace<PurgeApproval>(adapter, PURGE_NS, dealIds, (dealId, approvals) => {
      this.approvals.set(dealId, approvals);
    });
    await hydrateNamespace<number>(adapter, SETTLEMENT_NS, dealIds, (dealId, values) => {
      const latest = values[values.length - 1];
      if (typeof latest === "number") this.settlements.set(dealId, latest);
    });
    await hydrateNamespace<UsedNonce>(adapter, NONCE_NS, undefined, (_dealId, values) => {
      for (const value of values) this.authNonces.set(value.nonce.toLowerCase(), value.expiresAt);
    });
    await hydrateNamespace<EvidenceAuditRecord>(adapter, AUDIT_NS, dealIds, (dealId, values) => {
      this.audits.set(dealId, values);
    });
    await hydrateNamespace<PurgeOutcome>(adapter, PURGE_OUTCOME_NS, dealIds, (dealId, values) => {
      this.purgeOutcomes.set(dealId, values);
    });
  }

  private buildEntry(dealId: string, seq: number, input: AppendManifestInput): ManifestEntry {
    const entry: ManifestEntry = {
      dealId,
      seq,
      uploader: input.uploader,
      kind: input.kind,
      description: input.description,
      fileHash: input.fileHash,
      prevHash: input.prevHash,
      head: commitmentFor(dealId, seq, input.fileHash, input.prevHash),
      scan: input.scan,
      filename: input.filename ?? null,
      mimetype: input.mimetype ?? null,
      size: input.size ?? null,
      at: new Date().toISOString(),
      quarantined: input.quarantined ?? input.scan.status === "infected",
    };
    if (input.receipt !== undefined) entry.receipt = input.receipt;
    return entry;
  }

  appendManifest(dealId: string, input: AppendManifestInput): ManifestEntry {
    if (input.kind !== "delivery" && input.kind !== "dispute") {
      throw httpError(400, "kind must be delivery or dispute");
    }
    if (!/^0x[0-9a-fA-F]+$/.test(input.fileHash)) throw httpError(400, "Invalid fileHash");
    const key = dealId.toLowerCase();
    const list = this.entries.list(key);
    const expectedPrev = list.length === 0 ? GENESIS_PREVHASH : (list[list.length - 1]?.head ?? GENESIS_PREVHASH);
    if (input.prevHash.toLowerCase() !== expectedPrev.toLowerCase()) {
      throw httpError(409, `prevHash mismatch: expected ${expectedPrev}`);
    }
    const seq = list.length;
    const entry = this.buildEntry(dealId, seq, input);
    void this.entries.set(key, orderedKey(seq), entry);
    return { ...entry };
  }

  getByFileHash(dealId: string, fileHash: string): ManifestEntry | null {
    const found = this.entries
      .list(dealId.toLowerCase())
      .find((entry) => entry.fileHash.toLowerCase() === fileHash.toLowerCase());
    return found ? { ...found } : null;
  }

  /**
   * Authoritative, idempotent append. Concurrent calls for the same content
   * hash coalesce; a retry after a committed append returns the existing entry
   * without creating a duplicate or touching the chain head.
   */
  appendManifestAtomic(dealId: string, input: AppendManifestInput): Promise<AtomicAppendResult> {
    const existing = this.getByFileHash(dealId, input.fileHash);
    if (existing) return Promise.resolve({ entry: existing, created: false });
    const lockKey = `${dealId.toLowerCase()}|${input.fileHash.toLowerCase()}`;
    const inflight = this.appendInflight.get(lockKey);
    if (inflight) return inflight;
    const promise = this.doAppendAtomic(dealId, input).finally(() => this.appendInflight.delete(lockKey));
    this.appendInflight.set(lockKey, promise);
    return promise;
  }

  private async doAppendAtomic(dealId: string, input: AppendManifestInput): Promise<AtomicAppendResult> {
    if (input.kind !== "delivery" && input.kind !== "dispute") {
      throw httpError(400, "kind must be delivery or dispute");
    }
    if (!/^0x[0-9a-fA-F]+$/.test(input.fileHash)) throw httpError(400, "Invalid fileHash");
    const key = dealId.toLowerCase();
    const adapter = this.writer.getAdapter();
    if (!adapter) {
      // No durable adapter: single-process path (unchanged behavior).
      const list = this.entries.list(key);
      const expectedPrev = list.length === 0 ? GENESIS_PREVHASH : (list[list.length - 1]?.head ?? GENESIS_PREVHASH);
      if (input.prevHash.toLowerCase() !== expectedPrev.toLowerCase()) {
        throw httpError(409, `prevHash mismatch: expected ${expectedPrev}`);
      }
      const raced = this.getByFileHash(dealId, input.fileHash);
      if (raced) return { entry: raced, created: false };
      const seq = list.length;
      const entry = this.buildEntry(dealId, seq, input);
      await this.entries.setAuthoritative(key, orderedKey(seq), entry);
      return { entry: { ...entry }, created: true };
    }

    // Durable path: reserve the next sequence slot with a create-only write and
    // advance the authoritative head with compare-and-set. A racing instance
    // fails one of the two and retries against the new head.
    const MAX_ATTEMPTS = 8;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const headRow = await this.writer.getVersioned<ManifestHead>(HEAD_NS, key, "head");
      const current: ManifestHead = headRow?.value ?? { seq: 0, head: GENESIS_PREVHASH };
      if (input.prevHash.toLowerCase() !== current.head.toLowerCase()) {
        throw httpError(409, `prevHash mismatch: expected ${current.head}`);
      }
      const raced = this.getByFileHash(dealId, input.fileHash);
      if (raced) return { entry: raced, created: false };

      const entry = this.buildEntry(dealId, current.seq, input);
      const slotCreated = await this.writer.putIfAbsent(MANIFEST_NS, key, orderedKey(current.seq), entry);
      if (!slotCreated) {
        // Another instance took this slot (or an unrelated entry already sits
        // there): refresh from the authoritative store and retry.
        await this.entries.refresh(key);
        continue;
      }

      const nextHead: ManifestHead = { seq: current.seq + 1, head: entry.head };
      try {
        if (headRow) {
          if (typeof adapter.putVersioned !== "function") {
            throw httpError(500, "durable adapter cannot advance the manifest head");
          }
          await adapter.putVersioned(HEAD_NS, key, "head", nextHead, headRow.version);
        } else {
          const created = await this.writer.putIfAbsent(HEAD_NS, key, "head", nextHead);
          if (!created) {
            await this.writer.delete(MANIFEST_NS, key, orderedKey(current.seq));
            await this.entries.refresh(key);
            continue;
          }
        }
      } catch {
        // Head advanced under us: roll back the reserved slot and retry.
        await this.writer.delete(MANIFEST_NS, key, orderedKey(current.seq));
        await this.entries.refresh(key);
        continue;
      }
      // Durable state committed; publish to the local cache only.
      this.entries.remember(key, orderedKey(current.seq), entry);
      return { entry: { ...entry }, created: true };
    }
    throw httpError(409, "concurrent manifest append; please retry");
  }

  getManifest(dealId: string): ManifestEntry[] {
    return this.entries.list(dealId.toLowerCase()).map((entry) => ({ ...entry }));
  }

  getHead(dealId: string): string {
    const list = this.entries.list(dealId.toLowerCase());
    return list.length === 0 ? GENESIS_PREVHASH : (list[list.length - 1]?.head ?? GENESIS_PREVHASH);
  }

  attachReceipt(dealId: string, seq: number, receipt: ReceiptRef): ManifestEntry {
    const key = dealId.toLowerCase();
    const entry = this.entries.get(key, orderedKey(seq));
    if (!entry) throw httpError(404, "Manifest entry not found");
    entry.receipt = receipt;
    void this.entries.set(key, orderedKey(seq), entry);
    return { ...entry };
  }

  async attachReceiptAtomic(dealId: string, seq: number, receipt: ReceiptRef): Promise<ManifestEntry> {
    const key = dealId.toLowerCase();
    const entry = this.entries.get(key, orderedKey(seq));
    if (!entry) throw httpError(404, "Manifest entry not found");
    entry.receipt = receipt;
    await this.entries.setAuthoritative(key, orderedKey(seq), entry);
    return { ...entry };
  }

  async consumeAuthNonce(input: AuthNonceInput): Promise<boolean> {
    const key = input.nonce.toLowerCase();
    const now = input.now ?? Math.floor(Date.now() / 1_000);
    const previous = this.authNonces.get(key);
    if (previous !== undefined && previous > now) return false;
    const record = {
      nonce: key,
      dealId: input.dealId,
      expiresAt: input.expiresAt,
      at: new Date().toISOString(),
    } satisfies UsedNonce;
    const adapter = this.writer.getAdapter();
    if (adapter) {
      // Create-only across instances: a concurrent or replayed nonce loses the
      // insert atomically instead of overwriting the first consumer.
      const created = await this.writer.putIfAbsent(NONCE_NS, NONCE_SCOPE, key, record);
      if (!created) return false;
    } else {
      await this.writer.put(NONCE_NS, NONCE_SCOPE, key, record);
    }
    this.authNonces.set(key, input.expiresAt);
    return true;
  }

  hasAuthNonce(nonce: string, now: number = Math.floor(Date.now() / 1_000)): boolean {
    const expiry = this.authNonces.get(nonce.toLowerCase());
    return expiry !== undefined && expiry > now;
  }

  recordAudit(
    record: Omit<EvidenceAuditRecord, "id" | "at"> & { id?: string; at?: string },
  ): EvidenceAuditRecord {
    const key = record.dealId.toLowerCase();
    const list = this.audits.get(key) ?? [];
    const entry: EvidenceAuditRecord = {
      id: record.id ?? `audit-${Date.now().toString(36)}-${list.length}`,
      at: record.at ?? new Date().toISOString(),
      actor: record.actor,
      action: record.action,
      dealId: record.dealId,
      ...(record.target !== undefined ? { target: record.target } : {}),
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      ...(record.detail !== undefined ? { detail: record.detail } : {}),
    };
    list.push(entry);
    this.audits.set(key, list);
    void this.writer.put(AUDIT_NS, key, orderedKey(list.length - 1), entry);
    return entry;
  }

  getAudit(dealId: string): EvidenceAuditRecord[] {
    return [...(this.audits.get(dealId.toLowerCase()) ?? [])];
  }

  getAllAudit(): EvidenceAuditRecord[] {
    return [...this.audits.values()].flat();
  }

  recordPurgeOutcome(outcome: Omit<PurgeOutcome, "at"> & { at?: number }): PurgeOutcome {
    const key = outcome.dealId.toLowerCase();
    const list = this.purgeOutcomes.get(key) ?? [];
    const record: PurgeOutcome = {
      dealId: outcome.dealId,
      fileHash: outcome.fileHash,
      outcome: outcome.outcome,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      at: outcome.at ?? Math.floor(Date.now() / 1_000),
    };
    list.push(record);
    this.purgeOutcomes.set(key, list);
    void this.writer.put(PURGE_OUTCOME_NS, key, orderedKey(list.length - 1), record);
    return record;
  }

  getPurgeOutcomes(dealId: string): PurgeOutcome[] {
    return [...(this.purgeOutcomes.get(dealId.toLowerCase()) ?? [])];
  }

  recordPurgeApproval(
    dealId: string,
    approval: { role: "ops" | "arbitration"; signature?: string },
  ): PurgeApproval[] {
    if (approval.role !== "ops" && approval.role !== "arbitration") {
      throw httpError(400, "Purge approval role must be ops or arbitration");
    }
    const key = dealId.toLowerCase();
    const list = this.approvals.get(key) ?? [];
    const record: PurgeApproval = {
      role: approval.role,
      ...(approval.signature !== undefined ? { signature: approval.signature } : {}),
      at: new Date().toISOString(),
    };
    list.push(record);
    this.approvals.set(key, list);
    void this.writer.put(PURGE_NS, key, orderedKey(list.length - 1), record);
    return [...list];
  }

  recordPurgeApprovals(
    dealId: string,
    approval: { role: "ops" | "arbitration"; signature?: string },
  ): PurgeApproval[] {
    return this.recordPurgeApproval(dealId, approval);
  }

  getPurgeApprovals(dealId: string): PurgeApproval[] {
    return [...(this.approvals.get(dealId.toLowerCase()) ?? [])];
  }

  clearPurgeApprovals(dealId: string): void {
    const key = dealId.toLowerCase();
    const list = this.approvals.get(key) ?? [];
    this.approvals.delete(key);
    void this.writer.deleteAll(PURGE_NS, key, list.map((_, i) => orderedKey(i)));
  }

  recordSettlement(dealId: string, settledAt: number): void {
    if (!Number.isFinite(settledAt)) throw httpError(400, "settledAt must be a unix timestamp");
    const key = dealId.toLowerCase();
    this.settlements.set(key, settledAt);
    void this.writer.put(SETTLEMENT_NS, key, "settlement", settledAt);
  }

  getSettlement(dealId: string): number | null {
    return this.settlements.get(dealId.toLowerCase()) ?? null;
  }

  markBlobPurged(dealId: string, fileHash: string, purgedAt: number): void {
    const key = dealId.toLowerCase();
    if (!this.tombstones.list(key).some((t) => t.fileHash.toLowerCase() === fileHash.toLowerCase())) {
      void this.tombstones.set(key, fileHash.toLowerCase(), { dealId, fileHash, purgedAt });
    }
  }

  isBlobPurged(dealId: string, fileHash: string): boolean {
    return this.tombstones.list(dealId.toLowerCase()).some(
      (t) => t.fileHash.toLowerCase() === fileHash.toLowerCase(),
    );
  }

  getTombstones(dealId: string): BlobTombstone[] {
    return this.tombstones.list(dealId.toLowerCase()).map((tomb) => ({ ...tomb }));
  }

  listDealIds(): string[] {
    const ids = new Set<string>();
    for (const dealId of this.entries.dealIds()) {
      for (const entry of this.entries.list(dealId)) ids.add(entry.dealId);
    }
    for (const dealId of this.tombstones.dealIds()) {
      for (const tomb of this.tombstones.list(dealId)) ids.add(tomb.dealId);
    }
    return [...ids];
  }
}

// Re-exported for callers that inspect scan gating without importing routes.
export { scanStatusOf };

let sharedRegistry: InMemoryManifestRegistry | null = null;

/** Process-wide registry used by routes (tests reset via __resetRegistryForTests). */
export function getSharedRegistry(): InMemoryManifestRegistry {
  if (!sharedRegistry) sharedRegistry = new InMemoryManifestRegistry();
  return sharedRegistry;
}

/**
 * Switch the shared evidence registry to durable mode and rehydrate. The lead
 * wires this in server.ts: `await configureRegistry(adapter)`. Without it the
 * registry stays purely in-memory (current behavior).
 */
export async function configureRegistry(adapter: RegistryAdapter | null, dealIds?: string[]): Promise<void> {
  const registry = getSharedRegistry();
  registry.setAdapter(adapter);
  await registry.hydrate(dealIds);
}

/** Sync test hook: attach an adapter without hydrating. */
export function __setRegistryForTests(adapter: RegistryAdapter | null): void {
  getSharedRegistry().setAdapter(adapter);
}

/** Await queued durable writes (tests only). */
export function __flushRegistryForTests(): Promise<void> {
  return getSharedRegistry().flush();
}

/** Test-only reset (drops all manifests, approvals, settlements, tombstones). */
export function __resetRegistryForTests(): void {
  sharedRegistry = null;
}
