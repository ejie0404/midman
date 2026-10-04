// Ordered, idempotent migration runner for the store-owned schema.
//
// SQL is embedded as string constants (rather than read from disk) so the
// bundled runner has no filesystem/path dependency: it behaves identically
// after tsc compiles to dist and when invoked from any working directory.
// The files under packages/store/migrations/*.sql are the human-readable
// source of truth and must stay in sync with the constants below.
import type { SqlExecutor } from "./sql.js";

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

const MIGRATION_0001 = `-- 0001: core tables. Invitations store sha256(token), never the token.
CREATE TABLE IF NOT EXISTS deals (
  deal_id TEXT PRIMARY KEY,
  agreement_digest TEXT NOT NULL,
  buyer TEXT NOT NULL,
  seller TEXT NOT NULL,
  principal_units NUMERIC NOT NULL,
  quoted_fee_units NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invitations (
  token_hash TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(deal_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  deal_id TEXT,
  details JSONB
);
`;

const MIGRATION_0002 = `-- 0002: Phase 6 tables. Private records live here; chain projections are
-- display-only and never override contract reads.
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  creator_wallet TEXT NOT NULL,
  counterparty_hint TEXT,
  counterparty_address TEXT,
  terms JSONB NOT NULL,
  signatures JSONB NOT NULL DEFAULT '{}',
  admission JSONB,
  revocation_note JSONB,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_deal_idx ON drafts(deal_id);

CREATE TABLE IF NOT EXISTS chain_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  deal_id TEXT,
  event_name TEXT NOT NULL,
  args JSONB NOT NULL,
  orphaned BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_deal_idx ON chain_events(deal_id, block_number);

CREATE TABLE IF NOT EXISTS indexer_tip (
  contract_address TEXT PRIMARY KEY,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay_outbox (
  idempotency_key TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  action TEXT NOT NULL,
  params JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sponsor_ledger (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  deal_id TEXT,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const MIGRATION_0003 = `-- 0003: hosted-pg landing zone for the encrypted evidence subsystem and the
-- durable generic registry used by evidence/review registries (Phase 3C).
CREATE TABLE IF NOT EXISTS evidence_files (
  deal_id TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  mimetype TEXT NOT NULL,
  filename TEXT NOT NULL,
  dek_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, file_hash)
);
CREATE INDEX IF NOT EXISTS evidence_files_deal_idx ON evidence_files(deal_id);

CREATE TABLE IF NOT EXISTS evidence_manifest (
  deal_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  uploader TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delivery', 'dispute')),
  description TEXT NOT NULL DEFAULT '',
  file_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  head TEXT NOT NULL,
  scan JSONB NOT NULL DEFAULT '{"status":"deferred"}',
  receipt JSONB,
  signer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, seq)
);
CREATE INDEX IF NOT EXISTS evidence_manifest_deal_idx ON evidence_manifest(deal_id, seq);

CREATE TABLE IF NOT EXISTS purge_approvals (
  deal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ops', 'arbitration')),
  signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purge_approvals_deal_idx ON purge_approvals(deal_id);

-- Generic durable key/value registry keyed by deal, namespace and key.
-- Stores arbitrary JSONB so evidence/review registries survive restarts.
CREATE TABLE IF NOT EXISTS registry_kv (
  deal_id TEXT NOT NULL,
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, ns, key)
);
CREATE INDEX IF NOT EXISTS registry_kv_ns_idx ON registry_kv(ns, key);
`;

const MIGRATION_0004 = `-- 0004: migration bookkeeping for the store-owned runner. Ids match the
-- ordered migration set and are recorded exactly once.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** The ordered migration set, embedded so no filesystem access is required. */
export function defaultMigrations(): Migration[] {
  return [
    { id: "0001_init", sql: MIGRATION_0001 },
    { id: "0002_phase6", sql: MIGRATION_0002 },
    { id: "0003_evidence", sql: MIGRATION_0003 },
    { id: "0004_migrations", sql: MIGRATION_0004 },
  ];
}

/**
 * Apply every migration that has not yet been recorded, each inside its own
 * transaction. Returns the ids applied by this call (empty when already up to
 * date). Idempotent: safe to run concurrently/repeatedly.
 */
export async function runMigrations(
  executor: SqlExecutor,
  migrations: Migration[] = defaultMigrations(),
): Promise<string[]> {
  await executor.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const { rows } = await executor.query<{ id: string }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.id));
  const ordered = [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const newlyApplied: string[] = [];
  for (const migration of ordered) {
    if (applied.has(migration.id)) continue;
    await executor.query("BEGIN");
    try {
      await executor.query(migration.sql);
      await executor.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [
        migration.id,
      ]);
      await executor.query("COMMIT");
      newlyApplied.push(migration.id);
    } catch (error) {
      await executor.query("ROLLBACK");
      throw error;
    }
  }
  return newlyApplied;
}
