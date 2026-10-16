// Postgres-backed Store. Every caller-supplied value is passed as a query
// parameter and never interpolated into SQL. Money and hashes stay exact
// strings (TEXT/NUMERIC) so no JavaScript float is ever introduced; block
// numbers travel as decimal strings and are returned as bigint.
import {
  ConflictError,
  type AuthStateEntry,
  type ChainEventRow,
  type DealMetaRecord,
  type DraftRecord,
  type IndexerTip,
  type InvitationRecord,
  type KvEntry,
  type RelayJob,
  type Store,
  type VersionedValue,
} from "./store.js";
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
  version?: number | string;
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
    version: Number(row.version ?? 0),
  };
}

/** Build the SET list for a draft patch (excluding id). */
function draftPatch(patch: Partial<DraftRecord>): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = DRAFT_COLUMNS[field];
    if (column === undefined) continue;
    values.push(JSON_DRAFT_COLUMNS.has(field) ? jsonParam(value) : value);
    sets.push(`${column} = $${values.length + 1}`);
  }
  return { sets, values };
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
  lease_owner?: string | null;
  lease_expires_at?: string | Date | null;
  version?: number | string;
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
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
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: isoOrNull(row.lease_expires_at),
    version: Number(row.version ?? 0),
  };
}

export class PgStore implements Store {
  constructor(private readonly db: SqlExecutor) {}

  /** Backing executor (used by migrateStore and for shutdown). */
  get executor(): SqlExecutor {
    return this.db;
  }

  async close(): Promise<void> {
    if (typeof this.db.close === "function") await this.db.close();
  }

  async createDraft(draft: DraftRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO drafts
         (id, deal_id, creator_wallet, counterparty_hint, counterparty_address, terms, signatures, admission, revocation_note, status, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        draft.version ?? 0,
      ],
    );
  }

  async getDraft(id: string): Promise<DraftRecord | null> {
    const { rows } = await this.db.query<DraftRow>("SELECT * FROM drafts WHERE id = $1", [id]);
    const row = rows[0];
    return row ? toDraft(row) : null;
  }

  async listDraftsForWallet(wallet: string, limit: number): Promise<DraftRecord[]> {
    const { rows } = await this.db.query<DraftRow>(
      `SELECT * FROM drafts
       WHERE lower(creator_wallet) = lower($1)
          OR lower(terms->>'buyer') = lower($1)
          OR lower(terms->>'seller') = lower($1)
       ORDER BY updated_at DESC
       LIMIT $2`,
      [wallet, limit],
    );
    return rows.map(toDraft);
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
    const { sets, values } = draftPatch(patch);
    if (sets.length === 0) return;
    sets.push("version = version + 1");
    sets.push("updated_at = now()");
    await this.db.query(`UPDATE drafts SET ${sets.join(", ")} WHERE id = $1`, [id, ...values]);
  }

  async updateDraftCas(id: string, expectedVersion: number, patch: Partial<DraftRecord>): Promise<number> {
    const { sets, values } = draftPatch(patch);
    const params: unknown[] = [id, ...values];
    sets.push("version = version + 1");
    sets.push("updated_at = now()");
    params.push(expectedVersion);
    const { rows } = await this.db.query<{ version: number | string }>(
      `UPDATE drafts SET ${sets.join(", ")} WHERE id = $1 AND version = $${params.length} RETURNING version`,
      params,
    );
    if (rows.length === 0) {
      throw new ConflictError(`Draft ${id} version conflict (expected ${expectedVersion})`);
    }
    return Number(rows[0]!.version);
  }

  async mergeDraftSignature(id: string, role: string, signature: string): Promise<void> {
    const apply = async (db: SqlExecutor): Promise<void> => {
      const { rows } = await db.query<DraftRow>("SELECT * FROM drafts WHERE id = $1 FOR UPDATE", [id]);
      const current = rows[0];
      if (!current) throw new Error("Draft not found");
      const signatures = { ...(current.signatures ?? {}), [role]: signature };
      const status = Object.keys(signatures).length >= 1 ? "signed" : current.status;
      await db.query(
        `UPDATE drafts
         SET signatures = $2::jsonb, status = $3, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, JSON.stringify(signatures), status],
      );
    };
    if (typeof this.db.withTransaction === "function") await this.db.withTransaction(apply);
    else await apply(this.db);
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
       ),
       meta AS (
         INSERT INTO deals_meta (deal_id, source)
         SELECT DISTINCT deal_id, 'chain' FROM input
         WHERE deal_id IS NOT NULL AND orphaned = false
         ON CONFLICT (deal_id) DO NOTHING
         RETURNING 1
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
       SET status = 'processing', attempts = attempts + 1, version = version + 1, updated_at = now()
       WHERE idempotency_key = $1 AND status = 'queued'
       RETURNING *`,
      [key],
    );
    const row = rows[0];
    return row ? toRelay(row) : null;
  }

  async claimRelayLease(key: string, owner: string, ttlSeconds: number): Promise<RelayJob | null> {
    const { rows } = await this.db.query<RelayDbRow>(
      `UPDATE relay_outbox
       SET status = 'processing',
           attempts = attempts + 1,
           lease_owner = $2,
           lease_expires_at = now() + make_interval(secs => $3::double precision),
           version = version + 1,
           updated_at = now()
       WHERE idempotency_key = $1
         AND (
           status = 'queued'
           OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
         )
       RETURNING *`,
      [key, owner, ttlSeconds],
    );
    const row = rows[0];
    return row ? toRelay(row) : null;
  }

  async renewRelayLease(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE relay_outbox
       SET lease_expires_at = now() + make_interval(secs => $3::double precision),
           version = version + 1,
           updated_at = now()
       WHERE idempotency_key = $1 AND lease_owner = $2 AND status = 'processing'
       RETURNING 1 AS renewed`,
      [key, owner, ttlSeconds],
    );
    return rows.length > 0;
  }

  async reapExpiredRelayLeases(): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE relay_outbox
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
           version = version + 1, updated_at = now()
       WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
       RETURNING 1 AS reaped`,
    );
    return rows.length;
  }

  async finishRelay(
    key: string,
    status: string,
    txHash: string | null,
    result: Record<string, unknown> | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE relay_outbox
       SET status = $2, tx_hash = $3, result = $4, lease_owner = NULL, lease_expires_at = NULL,
           version = version + 1, updated_at = now()
       WHERE idempotency_key = $1`,
      [key, status, txHash, jsonParam(result)],
    );
  }

  async finishRelayOwned(
    key: string,
    status: string,
    txHash: string | null,
    result: Record<string, unknown> | null,
    owner: string,
  ): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE relay_outbox
       SET status = $2, tx_hash = $3, result = $4, lease_owner = NULL, lease_expires_at = NULL,
           version = version + 1, updated_at = now()
       WHERE idempotency_key = $1 AND lease_owner = $5
       RETURNING 1 AS done`,
      [key, status, txHash, jsonParam(result), owner],
    );
    return rows.length > 0;
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

  async listRelayByStatus(status: string, limit: number): Promise<RelayJob[]> {
    const { rows } = await this.db.query<RelayDbRow>(
      `SELECT * FROM relay_outbox
       WHERE status = $1
       ORDER BY updated_at ASC, idempotency_key ASC
       LIMIT $2`,
      [status, limit],
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

  async reserveSponsorship(
    txHash: string,
    dealId: string | null,
    action: string,
    limit: number,
    sinceIso: string,
  ): Promise<{ granted: boolean; count: number }> {
    const apply = async (db: SqlExecutor): Promise<{ granted: boolean; count: number }> => {
      // Serialize reservations in the same budget window across processes.
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sponsor:${sinceIso}`]);
      const { rows } = await db.query<{ n: number | string }>(
        "SELECT COUNT(*)::int AS n FROM sponsor_ledger WHERE created_at >= $1",
        [sinceIso],
      );
      const count = Number(rows[0]?.n ?? 0);
      if (count >= limit) return { granted: false, count };
      await db.query("INSERT INTO sponsor_ledger (tx_hash, deal_id, action) VALUES ($1, $2, $3)", [
        txHash,
        dealId,
        action,
      ]);
      return { granted: true, count: count + 1 };
    };
    if (typeof this.db.withTransaction === "function") return this.db.withTransaction(apply);
    return apply(this.db);
  }

  async listDealIds(): Promise<string[]> {
    // Drafts, chain-discovered (externally funded) deals, and registry-known
    // deals. Distinct + case-insensitive via lower(); deterministic order.
    const { rows } = await this.db.query<{ deal_id: string }>(
      `SELECT DISTINCT deal_id FROM drafts
       UNION
       SELECT deal_id FROM chain_events WHERE deal_id IS NOT NULL AND orphaned = false
       UNION
       SELECT deal_id FROM registry_kv
       UNION
       SELECT deal_id FROM deals_meta
       ORDER BY deal_id ASC`,
    );
    return rows.map((row) => row.deal_id);
  }

  async recordDealMeta(dealId: string, source: string): Promise<void> {
    await this.db.query(
      `INSERT INTO deals_meta (deal_id, source, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (deal_id) DO UPDATE SET source = EXCLUDED.source, updated_at = now()`,
      [dealId, source],
    );
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

  async kvGetWithVersion(ns: string, dealId: string, key: string): Promise<VersionedValue | null> {
    const { rows } = await this.db.query<{ value: unknown; version: number | string }>(
      "SELECT value, version FROM registry_kv WHERE ns = $1 AND deal_id = $2 AND key = $3",
      [ns, dealId, key],
    );
    const row = rows[0];
    return row ? { value: row.value, version: Number(row.version) } : null;
  }

  async kvList(ns: string, dealId: string): Promise<KvEntry[]> {
    const { rows } = await this.db.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM registry_kv WHERE ns = $1 AND deal_id = $2 ORDER BY key ASC",
      [ns, dealId],
    );
    return rows;
  }

  async kvPut(ns: string, dealId: string, key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO registry_kv (deal_id, ns, key, value, version, updated_at)
       VALUES ($2, $1, $3, $4::jsonb, 1, now())
       ON CONFLICT (deal_id, ns, key) DO UPDATE SET
         value = EXCLUDED.value,
         version = registry_kv.version + 1,
         updated_at = now()`,
      [ns, dealId, key, JSON.stringify(value)],
    );
  }

  async kvPutIfAbsent(ns: string, dealId: string, key: string, value: unknown): Promise<boolean> {
    const { rows } = await this.db.query<{ inserted: number }>(
      `INSERT INTO registry_kv (deal_id, ns, key, value, version, updated_at)
       VALUES ($2, $1, $3, $4::jsonb, 1, now())
       ON CONFLICT (deal_id, ns, key) DO NOTHING
       RETURNING 1 AS inserted`,
      [ns, dealId, key, JSON.stringify(value)],
    );
    return rows.length > 0;
  }

  async kvPutCas(ns: string, dealId: string, key: string, value: unknown, expectedVersion: number): Promise<number> {
    const { rows } = await this.db.query<{ version: number | string }>(
      `UPDATE registry_kv
       SET value = $4::jsonb, version = version + 1, updated_at = now()
       WHERE ns = $1 AND deal_id = $2 AND key = $3 AND version = $5
       RETURNING version`,
      [ns, dealId, key, JSON.stringify(value), expectedVersion],
    );
    if (rows.length === 0) {
      throw new ConflictError(`registry_kv conflict for ${ns}/${dealId}/${key} (expected version ${expectedVersion})`);
    }
    return Number(rows[0]!.version);
  }

  async kvDelete(ns: string, dealId: string, key: string): Promise<void> {
    await this.db.query("DELETE FROM registry_kv WHERE ns = $1 AND deal_id = $2 AND key = $3", [ns, dealId, key]);
  }

  async kvDel(ns: string, dealId: string, key: string): Promise<void> {
    return this.kvDelete(ns, dealId, key);
  }

  async kvDeals(ns: string): Promise<string[]> {
    const { rows } = await this.db.query<{ deal_id: string }>(
      "SELECT DISTINCT deal_id FROM registry_kv WHERE ns = $1 ORDER BY deal_id ASC",
      [ns],
    );
    return rows.map((row) => row.deal_id);
  }

  // ---- Sequences ----
  async nextSeq(name: string): Promise<number> {
    const { rows } = await this.db.query<{ value: number | string }>(
      `INSERT INTO seq (name, value, updated_at)
       VALUES ($1, 1, now())
       ON CONFLICT (name) DO UPDATE SET value = seq.value + 1, updated_at = now()
       RETURNING value`,
      [name],
    );
    return Number(rows[0]?.value ?? 0);
  }

  // ---- Auth state ----
  async authGet(scope: string, key: string): Promise<unknown | null> {
    const { rows } = await this.db.query<{ value: unknown }>(
      `SELECT value FROM auth_kv
       WHERE scope = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > now())`,
      [scope, key],
    );
    return rows.length > 0 ? rows[0]!.value : null;
  }

  async authPut(scope: string, key: string, value: unknown, expiresAt: string | null = null): Promise<void> {
    await this.db.query(
      `INSERT INTO auth_kv (scope, key, value, expires_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (scope, key) DO UPDATE SET
         value = EXCLUDED.value,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [scope, key, JSON.stringify(value), expiresAt],
    );
  }

  async authDelete(scope: string, key: string): Promise<void> {
    await this.db.query("DELETE FROM auth_kv WHERE scope = $1 AND key = $2", [scope, key]);
  }

  async authPruneExpired(): Promise<number> {
    const { rows } = await this.db.query(
      "DELETE FROM auth_kv WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING scope",
    );
    return rows.length;
  }

  async authList(scope: string): Promise<AuthStateEntry[]> {
    const { rows } = await this.db.query<{ key: string; value: unknown; expires_at: string | Date | null }>(
      `SELECT key, value, expires_at FROM auth_kv
       WHERE scope = $1 AND (expires_at IS NULL OR expires_at > now())
       ORDER BY key ASC`,
      [scope],
    );
    return rows.map((row) => ({ key: row.key, value: row.value, expiresAt: isoOrNull(row.expires_at) }));
  }

  async authConsume(scope: string, key: string): Promise<unknown | null> {
    // Single statement: the row is locked, returned and deleted atomically, so
    // concurrent consumers cannot both observe it.
    const { rows } = await this.db.query<{ value: unknown }>(
      `DELETE FROM auth_kv
       WHERE scope = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > now())
       RETURNING value`,
      [scope, key],
    );
    return rows.length > 0 ? rows[0]!.value : null;
  }

  async authGetForUpdate(scope: string, key: string): Promise<unknown | null> {
    const { rows } = await this.db.query<{ value: unknown }>(
      `SELECT value FROM auth_kv
       WHERE scope = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > now())
       FOR UPDATE`,
      [scope, key],
    );
    return rows.length > 0 ? rows[0]!.value : null;
  }

  // ---- Invitations / revocations ----
  async saveInvitation(record: InvitationRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO invitations (token_hash, deal_id, expires_at, revoked)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO UPDATE SET
         deal_id = EXCLUDED.deal_id,
         expires_at = EXCLUDED.expires_at,
         revoked = EXCLUDED.revoked`,
      [record.tokenHash, record.dealId, record.expiresAt, record.revoked],
    );
  }

  async getInvitation(tokenHash: string): Promise<InvitationRecord | null> {
    const { rows } = await this.db.query<{
      token_hash: string;
      deal_id: string;
      created_at: string | Date;
      expires_at: string | Date;
      revoked: boolean;
    }>("SELECT * FROM invitations WHERE token_hash = $1", [tokenHash]);
    const row = rows[0];
    if (!row) return null;
    return {
      tokenHash: row.token_hash,
      dealId: row.deal_id,
      createdAt: isoOrNull(row.created_at) ?? new Date().toISOString(),
      expiresAt: isoOrNull(row.expires_at) ?? new Date().toISOString(),
      revoked: row.revoked,
    };
  }

  async revokeInvitation(tokenHash: string): Promise<void> {
    await this.db.query("UPDATE invitations SET revoked = true WHERE token_hash = $1", [tokenHash]);
  }

  async redeemInvitation(input: {
    draftId: string;
    tokenHash: string;
    counterpartyAddress: string;
  }): Promise<{ redeemed: boolean; reason?: string }> {
    const apply = async (db: SqlExecutor): Promise<{ redeemed: boolean; reason?: string }> => {
      const { rows } = await db.query<{ revoked: boolean; expires_at: string | Date }>(
        "SELECT revoked, expires_at FROM invitations WHERE token_hash = $1 FOR UPDATE",
        [input.tokenHash],
      );
      const invitation = rows[0];
      if (!invitation) return { redeemed: false, reason: "unknown-invitation" };
      if (invitation.revoked) return { redeemed: false, reason: "revoked" };
      const expiresAt = new Date(isoOrNull(invitation.expires_at) ?? 0).getTime();
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return { redeemed: false, reason: "expired" };
      }
      await db.query("UPDATE invitations SET revoked = true WHERE token_hash = $1", [input.tokenHash]);
      await db.query(
        `UPDATE drafts
         SET counterparty_address = $2, status = 'accepted', version = version + 1, updated_at = now()
         WHERE id = $1`,
        [input.draftId, input.counterpartyAddress],
      );
      return { redeemed: true };
    };
    if (typeof this.db.withTransaction === "function") return this.db.withTransaction(apply);
    return apply(this.db);
  }

  // ---- Transactions + lifecycle ----
  async withTransaction<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    if (typeof this.db.withTransaction !== "function") return fn(this);
    return this.db.withTransaction((tx) => fn(new PgStore(tx)));
  }
}

export function createPgStore(executor: SqlExecutor): PgStore {
  return new PgStore(executor);
}
