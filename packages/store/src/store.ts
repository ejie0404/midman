// Store: Postgres when DATABASE_URL is set, in-memory otherwise.
// Same interface both ways so dev/test run without docker.
import { PgStore } from "./pg.js";
import { createPgExecutor, type SqlExecutor } from "./sql.js";

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
}

export interface Store {
  createDraft(draft: DraftRecord): Promise<void>;
  getDraft(id: string): Promise<DraftRecord | null>;
  getDraftByDeal(dealId: string): Promise<DraftRecord | null>;
  updateDraft(id: string, patch: Partial<DraftRecord>): Promise<void>;
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
  finishRelay(key: string, status: string, txHash: string | null, result: Record<string, unknown> | null): Promise<void>;
  listQueuedRelay(queue: string, limit: number): Promise<RelayJob[]>;
  recordSponsor(txHash: string, dealId: string | null, action: string): Promise<void>;
  countSponsorsSince(sinceIso: string): Promise<number>;
  listDealIds(): Promise<string[]>;
}

function key(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

export class MemoryStore implements Store {
  private drafts = new Map<string, DraftRecord>();
  private events = new Map<string, ChainEventRow>();
  private tips = new Map<string, IndexerTip>();
  private relay = new Map<string, RelayJob>();
  private sponsors: Array<{ txHash: string; dealId: string | null; action: string; at: string }> = [];

  async createDraft(draft: DraftRecord): Promise<void> {
    this.drafts.set(draft.id, { ...draft });
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
    this.drafts.set(id, { ...current, ...patch });
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
    this.relay.set(job.idempotencyKey, { ...job });
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
    return { ...job };
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
  }
  async listQueuedRelay(queue: string, limit: number): Promise<RelayJob[]> {
    return [...this.relay.values()].filter((j) => j.queue === queue && j.status === "queued").slice(0, limit);
  }
  async recordSponsor(txHash: string, dealId: string | null, action: string): Promise<void> {
    this.sponsors.push({ txHash, dealId, action, at: new Date().toISOString() });
  }
  async countSponsorsSince(sinceIso: string): Promise<number> {
    return this.sponsors.filter((s) => s.at >= sinceIso).length;
  }

  async listDealIds(): Promise<string[]> {
    return [...new Set([...this.drafts.values()].map((d) => d.dealId))];
  }
}

/**
 * Union of draft-linked deals and chain-discovered deals (from indexed events).
 * Worker passes (progression/reminders/capacity) must use this rather than
 * `listDealIds` so externally funded deals are not invisible. Deduplicates
 * case-insensitively; tolerates stores without the chain-event capability.
 */
export async function listKnownDealIds(store: Store): Promise<string[]> {
  const draftDeals = await store.listDealIds();
  const chainDeals = typeof store.listChainEventDealIds === "function" ? await store.listChainEventDealIds() : [];
  const seen = new Map<string, string>();
  for (const dealId of [...draftDeals, ...chainDeals]) {
    if (typeof dealId !== "string" || dealId.length === 0) continue;
    const lower = dealId.toLowerCase();
    if (!seen.has(lower)) seen.set(lower, dealId);
  }
  return [...seen.values()];
}

export function createStore(executor?: SqlExecutor): Store {
  if (executor) return new PgStore(executor);
  if (process.env["DATABASE_URL"]) return new PgStore(createPgExecutor(process.env["DATABASE_URL"]));
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL required in production; refusing in-memory store");
  }
  return new MemoryStore();
}
