// In-memory evidence manifest registry (P-13 append-only manifest).
// Phase 6/8 runtime uses this registry; hosted pg wiring (migrations/003)
// lands later — see 003_evidence.sql. Each entry chains prevHash == head,
// seq == count, so reviewers can verify the chain off-platform.
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
const PURGE_NS = "evidence.purge-approvals";
const SETTLEMENT_NS = "evidence.settlement";
const TOMBSTONE_NS = "evidence.tombstones";

export interface ScanRecord {
  readonly status: "clean" | "infected" | "deferred" | "error";
  readonly detail?: string;
}

export interface ReceiptRef {
  readonly payload: string;
  readonly signature: string;
  readonly signer: string;
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

/** Genesis prevHash for the first manifest entry of a deal. */
export const GENESIS_PREVHASH = `0x${"00".repeat(32)}`;

/** Manifest commitment: sha256(dealId|seq|fileHash|prevHash), 0x-hex. */
export function commitmentFor(dealId: string, seq: number, fileHash: string, prevHash: string): string {
  return `0x${createHash("sha256").update(`${dealId}|${seq}|${fileHash}|${prevHash}`, "utf8").digest("hex")}`;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export interface ManifestRegistry {
  appendManifest(dealId: string, input: AppendManifestInput): ManifestEntry;
  getManifest(dealId: string): ManifestEntry[];
  getHead(dealId: string): string;
  attachReceipt(dealId: string, seq: number, receipt: ReceiptRef): ManifestEntry;
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
    void this.entries.set(key, orderedKey(seq), entry);
    return { ...entry };
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
