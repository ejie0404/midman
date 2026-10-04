// Postgres-backed Store. Every caller-supplied value is passed as a query
// parameter and never interpolated into SQL. Money and hashes stay exact
// strings (TEXT/NUMERIC) so no JavaScript float is ever introduced; block
// numbers travel as decimal strings and are returned as bigint.
import type { ChainEventRow, DraftRecord, IndexerTip, RelayJob, Store } from "./store.js";
import type { SqlExecutor } from "./sql.js";

const DRAFT_COLUMNS: Record<string, string> = {
  // `id` is intentionally absent from updates: it is the WHERE key.
  dealId: "deal_id",
  creatorWallet: "creator_wallet",
  counterpartyHint: "counterparty_hint",
  counterpartyAddress: "counterparty_address",
  terms: "terms",
  signatures: "signatures",
  admission: "admission",
  revocationNote: "revocation_note",
  status: "status",
};

const JSON_DRAFT_COLUMNS = new Set(["terms", "signatures", "admission", "revocationNote"]);

function jsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

interface DraftRow {
  id: string;
  deal_id: string;
  creator_wallet: string;
  counterparty_hint: string | null;
  counterparty_address: string | null;
  terms: Record<string, string> | null;
  signatures: Record<string, string> | null;
  admission: Record<string, string> | null;
  revocation_note: Record<string, string> | null;
  status: string;
}

function toDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    dealId: row.deal_id,
    creatorWallet: row.creator_wallet,
    counterpartyHint: row.counterparty_hint,
    counterpartyAddress: row.counterparty_address,
    terms: row.terms ?? {},
    signatures: row.signatures ?? {},
    admission: row.admission,
    revocationNote: row.revocation_note,
    status: row.status,
  };
}

interface ChainEventDbRow {
  tx_hash: string;
  log_index: number;
  block_number: string | number | bigint;
  block_hash: string;
  contract_address: string;
  deal_id: string | null;
  event_name: string;
  args: Record<string, unknown> | null;
  orphaned: boolean;
}

function toEvent(row: ChainEventDbRow): ChainEventRow {
  return {
    txHash: row.tx_hash,
    logIndex: Number(row.log_index),
    blockNumber: BigInt(row.block_number),
    blockHash: row.block_hash,
    contractAddress: row.contract_address,
    dealId: row.deal_id,
    eventName: row.event_name,
    args: row.args ?? {},
    orphaned: row.orphaned,
  };
}

interface RelayDbRow {
  idempotency_key: string;
  queue: string;
  action: string;
  params: Record<string, unknown> | null;
  status: string;
  attempts: number;
  tx_hash: string | null;
  result: Record<string, unknown> | null;
}

function toRelay(row: RelayDbRow): RelayJob {
  return {
    idempotencyKey: row.idempotency_key,
    queue: row.queue,
    action: row.action,
    params: row.params ?? {},
    status: row.status,
    attempts: Number(row.attempts),
    txHash: row.tx_hash,
    result: row.result,
  };
}

export class PgStore implements Store {
  constructor(private readonly db: SqlExecutor) {}

  async createDraft(draft: DraftRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO drafts
         (id, deal_id, creator_wallet, counterparty_hint, counterparty_address, terms, signatures, admission, revocation_note, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         deal_id = EXCLUDED.deal_id,
         creator_wallet = EXCLUDED.creator_wallet,
         counterparty_hint = EXCLUDED.counterparty_hint,
         counterparty_address = EXCLUDED.counterparty_address,
         terms = EXCLUDED.terms,
         signatures = EXCLUDED.signatures,
         admission = EXCLUDED.admission,
         revocation_note = EXCLUDED.revocation_note,
         status = EXCLUDED.status,
         updated_at = now()`,
      [
        draft.id,
        draft.dealId,
        draft.creatorWallet,
        draft.counterpartyHint,
        draft.counterpartyAddress,
        jsonParam(draft.terms),
        jsonParam(draft.signatures),
        jsonParam(draft.admission),
        jsonParam(draft.revocationNote),
        draft.status,
      ],
    );
  }

  async getDraft(id: string): Promise<DraftRecord | null> {
    const { rows } = await this.db.query<DraftRow>("SELECT * FROM drafts WHERE id = $1", [id]);
    const row = rows[0];
    return row ? toDraft(row) : null;
  }

  async getDraftByDeal(dealId: string): Promise<DraftRecord | null> {
    const { rows } = await this.db.query<DraftRow>(
      "SELECT * FROM drafts WHERE lower(deal_id) = lower($1) ORDER BY updated_at DESC LIMIT 1",
      [dealId],
    );
    const row = rows[0];
    return row ? toDraft(row) : null;
  }

  async updateDraft(id: string, patch: Partial<DraftRecord>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const column = DRAFT_COLUMNS[field];
      if (column === undefined) continue;
      params.push(JSON_DRAFT_COLUMNS.has(field) ? jsonParam(value) : value);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = now()");
    await this.db.query(`UPDATE drafts SET ${sets.join(", ")} WHERE id = $1`, params);
  }

  async putEvents(events: ChainEventRow[]): Promise<number> {
    if (events.length === 0) return 0;
    const params: unknown[] = [];
    const tuples = events.map((event, index) => {
      const base = index * 9;
      params.push(
        event.txHash,
        event.logIndex,
        String(event.blockNumber),
        event.blockHash,
        event.contractAddress,
        event.dealId,
        event.eventName,
        jsonParam(event.args),
        event.orphaned,
      );
      return `($${base + 1}, $${base + 2}::int, $${base + 3}::bigint, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9}::boolean)`;
    });
    // New rows insert (deduped on the primary key); rows that come back after a
    // reorg are revived in the same statement by clearing orphaned and
    // refreshing the block linkage (audit #10). The data-modifying `revived`
    // CTE executes even though only `inserted` is selected.
    const { rows } = await this.db.query<{ inserted: number | string }>(
      `WITH input(tx_hash, log_index, block_number, block_hash, contract_address, deal_id, event_name, args, orphaned) AS (
         VALUES ${tuples.join(", ")}
       ),
       inserted AS (
         INSERT INTO chain_events
           (tx_hash, log_index, block_number, block_hash, contract_address, deal_id, event_name, args, orphaned)
         SELECT tx_hash, log_index, block_number, block_hash, contract_address, deal_id, event_name, args, orphaned FROM input
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING 1 AS inserted
       ),
       revived AS (
         UPDATE chain_events AS ce
         SET orphaned = false, block_hash = i.block_hash, block_number = i.block_number
         FROM input AS i
         WHERE ce.tx_hash = i.tx_hash AND ce.log_index = i.log_index AND ce.orphaned = true
         RETURNING 1 AS revived
       )
       SELECT (SELECT count(*)::int FROM inserted) AS inserted`,
      params,
    );
    return Number(rows[0]?.inserted ?? 0);
  }

  async getEventsByDeal(dealId: string): Promise<ChainEventRow[]> {
    const { rows } = await this.db.query<ChainEventDbRow>(
      `SELECT * FROM chain_events
       WHERE deal_id IS NOT NULL AND lower(deal_id) = lower($1) AND orphaned = false
       ORDER BY block_number ASC, log_index ASC`,
      [dealId],
    );
    return rows.map(toEvent);
  }

  async listChainEventDealIds(): Promise<string[]> {
    const { rows } = await this.db.query<{ deal_id: string }>(
      `SELECT DISTINCT deal_id FROM chain_events
       WHERE deal_id IS NOT NULL AND orphaned = false
       ORDER BY deal_id ASC`,
    );
    return rows.map((row) => row.deal_id);
  }

  async blockHashAt(contract: string, blockNumber: bigint): Promise<string | null> {
    const { rows } = await this.db.query<{ block_hash: string }>(
      `SELECT block_hash FROM chain_events
       WHERE lower(contract_address) = lower($1) AND block_number = $2 AND orphaned = false
       ORDER BY log_index ASC
       LIMIT 1`,
      [contract, String(blockNumber)],
    );
    return rows[0]?.block_hash ?? null;
  }

  async markOrphanedFrom(contract: string, blockNumber: bigint): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE chain_events SET orphaned = true
       WHERE lower(contract_address) = lower($1) AND block_number >= $2 AND orphaned = false
       RETURNING 1 AS updated`,
      [contract, String(blockNumber)],
    );
    return rows.length;
  }

  async getTip(contract: string): Promise<IndexerTip | null> {
    const { rows } = await this.db.query<{ block_number: string | number | bigint; block_hash: string }>(
      "SELECT block_number, block_hash FROM indexer_tip WHERE contract_address = $1",
      [contract.toLowerCase()],
    );
    const row = rows[0];
    return row ? { blockNumber: BigInt(row.block_number), blockHash: row.block_hash } : null;
  }

  async setTip(contract: string, tip: IndexerTip): Promise<void> {
    await this.db.query(
      `INSERT INTO indexer_tip (contract_address, block_number, block_hash, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (contract_address) DO UPDATE SET
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         updated_at = now()`,
      [contract.toLowerCase(), String(tip.blockNumber), tip.blockHash],
    );
  }

  async clearContractData(contract: string): Promise<void> {
    await this.db.query("DELETE FROM chain_events WHERE lower(contract_address) = lower($1)", [contract]);
    await this.db.query("DELETE FROM indexer_tip WHERE contract_address = $1", [contract.toLowerCase()]);
  }

  async enqueueRelay(job: RelayJob): Promise<{ inserted: boolean; existing: RelayJob | null }> {
    const { rows } = await this.db.query(
      `INSERT INTO relay_outbox
         (idempotency_key, queue, action, params, status, attempts, tx_hash, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [
        job.idempotencyKey,
        job.queue,
        job.action,
        jsonParam(job.params),
        job.status,
        job.attempts,
        job.txHash,
        jsonParam(job.result),
      ],
    );
    if (rows.length > 0) return { inserted: true, existing: null };
    return { inserted: false, existing: await this.getRelay(job.idempotencyKey) };
  }

  async getRelay(key: string): Promise<RelayJob | null> {
    const { rows } = await this.db.query<RelayDbRow>(
      "SELECT * FROM relay_outbox WHERE idempotency_key = $1",
      [key],
    );
    const row = rows[0];
    return row ? toRelay(row) : null;
  }

  async claimRelay(key: string): Promise<RelayJob | null> {
    // Single atomic statement: only a queued row transitions, and the row is
    // locked for the duration of the transaction/statement.
    const { rows } = await this.db.query<RelayDbRow>(
      `UPDATE relay_outbox
       SET status = 'processing', attempts = attempts + 1, updated_at = now()
       WHERE idempotency_key = $1 AND status = 'queued'
       RETURNING *`,
      [key],
    );
    const row = rows[0];
    return row ? toRelay(row) : null;
  }

  async finishRelay(
    key: string,
    status: string,
    txHash: string | null,
    result: Record<string, unknown> | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE relay_outbox
       SET status = $2, tx_hash = $3, result = $4, updated_at = now()
       WHERE idempotency_key = $1`,
      [key, status, txHash, jsonParam(result)],
    );
  }

  async listQueuedRelay(queue: string, limit: number): Promise<RelayJob[]> {
    const { rows } = await this.db.query<RelayDbRow>(
      `SELECT * FROM relay_outbox
       WHERE queue = $1 AND status = 'queued'
       ORDER BY created_at ASC, idempotency_key ASC
       LIMIT $2`,
      [queue, limit],
    );
    return rows.map(toRelay);
  }

  async recordSponsor(txHash: string, dealId: string | null, action: string): Promise<void> {
    await this.db.query(
      "INSERT INTO sponsor_ledger (tx_hash, deal_id, action) VALUES ($1, $2, $3)",
      [txHash, dealId, action],
    );
  }

  async countSponsorsSince(sinceIso: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number | string }>(
      "SELECT COUNT(*)::int AS n FROM sponsor_ledger WHERE created_at >= $1",
      [sinceIso],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async listDealIds(): Promise<string[]> {
    const { rows } = await this.db.query<{ deal_id: string }>(
      "SELECT DISTINCT deal_id FROM drafts ORDER BY deal_id ASC",
    );
    return rows.map((row) => row.deal_id);
  }

  // ---- Registry kv (durable metadata; see registry.ts) ----
  // Parameter order mirrors RegistryKvStore: (ns, dealId, key).
  async kvGet(ns: string, dealId: string, key: string): Promise<unknown | null> {
    const { rows } = await this.db.query<{ value: unknown }>(
      "SELECT value FROM registry_kv WHERE ns = $1 AND deal_id = $2 AND key = $3",
      [ns, dealId, key],
    );
    return rows.length > 0 ? rows[0]!.value : null;
  }

  async kvList(ns: string, dealId: string): Promise<Array<{ key: string; value: unknown }>> {
    const { rows } = await this.db.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM registry_kv WHERE ns = $1 AND deal_id = $2 ORDER BY key ASC",
      [ns, dealId],
    );
    return rows;
  }

  async kvPut(ns: string, dealId: string, key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO registry_kv (ns, deal_id, key, value, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (ns, deal_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ns, dealId, key, JSON.stringify(value)],
    );
  }

  async kvDelete(ns: string, dealId: string, key: string): Promise<void> {
    await this.db.query("DELETE FROM registry_kv WHERE ns = $1 AND deal_id = $2 AND key = $3", [ns, dealId, key]);
  }

  async kvDeals(ns: string): Promise<string[]> {
    const { rows } = await this.db.query<{ deal_id: string }>(
      "SELECT DISTINCT deal_id FROM registry_kv WHERE ns = $1 ORDER BY deal_id ASC",
      [ns],
    );
    return rows.map((row) => row.deal_id);
  }
}

export function createPgStore(executor: SqlExecutor): PgStore {
  return new PgStore(executor);
}
