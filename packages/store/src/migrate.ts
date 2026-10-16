// Ordered, idempotent migration runner for the store-owned schema.
//
// SQL is embedded as string constants (rather than read from disk) so the
// bundled runner has no filesystem/path dependency: it behaves identically
// after tsc compiles to dist and when invoked from any working directory.
// The files under packages/store/migrations/*.sql are the human-readable
// source of truth and must stay in sync with the constants below.
import type { SqlExecutor } from "./sql.js";
import type { Store } from "./store.js";

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

const MIGRATION_0005 = `-- 0005: durability hardening (Phase 3 round-2 audit).
--
-- Adds compare-and-set version columns, relay outbox leases, database-backed
-- sequences, deal discovery metadata, auth/challenge state, and a dedicated
-- signature table with a unique (deal_id, role) constraint. All statements are
-- additive/idempotent and backfill existing rows so deployed databases migrate,
-- not only fresh ones.

-- Optimistic-concurrency version on mutable shared records.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registry_kv ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

-- Relay outbox lease fields (owner / expiry / version) for worker claim+renew.
ALTER TABLE relay_outbox ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE relay_outbox ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE relay_outbox ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

-- Query indexes for status/expiry/lease lookups.
CREATE INDEX IF NOT EXISTS relay_outbox_status_lease_idx ON relay_outbox(queue, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS relay_outbox_status_idx ON relay_outbox(status, updated_at);
CREATE INDEX IF NOT EXISTS invitations_expiry_idx ON invitations(expires_at);
CREATE INDEX IF NOT EXISTS invitations_deal_idx ON invitations(deal_id);
CREATE INDEX IF NOT EXISTS evidence_manifest_deal_created_idx ON evidence_manifest(deal_id, created_at);
CREATE INDEX IF NOT EXISTS registry_kv_ns_deal_idx ON registry_kv(ns, deal_id);

-- Invitations now key on the local draft reference, so the original FK to the
-- chain deal table is dropped (invitations are pre-funding private records).
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_deal_id_fkey;
CREATE SEQUENCE IF NOT EXISTS invitation_id_seq;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS id BIGINT;
UPDATE invitations SET id = nextval('invitation_id_seq') WHERE id IS NULL;
ALTER TABLE invitations ALTER COLUMN id SET DEFAULT nextval('invitation_id_seq');
ALTER TABLE invitations ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invitations_id_idx ON invitations(id);

-- Deal discovery metadata: union of drafts, chain events and registry keys.
CREATE TABLE IF NOT EXISTS deals_meta (
  deal_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO deals_meta (deal_id, source)
SELECT DISTINCT deal_id, 'draft' FROM drafts
ON CONFLICT (deal_id) DO NOTHING;
INSERT INTO deals_meta (deal_id, source)
SELECT DISTINCT deal_id, 'chain' FROM chain_events WHERE deal_id IS NOT NULL AND orphaned = false
ON CONFLICT (deal_id) DO NOTHING;
INSERT INTO deals_meta (deal_id, source)
SELECT DISTINCT deal_id, 'registry' FROM registry_kv
ON CONFLICT (deal_id) DO NOTHING;

-- Signature slots with a uniqueness constraint on (deal_id, role). Backfilled
-- from the drafts.signatures JSONB so existing signatures are not lost.
CREATE TABLE IF NOT EXISTS draft_signatures (
  deal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  signer TEXT,
  signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, role)
);
INSERT INTO draft_signatures (deal_id, role, signature, updated_at)
SELECT d.deal_id, kv.key, kv.value, d.updated_at
FROM drafts d
CROSS JOIN LATERAL jsonb_each_text(d.signatures) AS kv(key, value)
WHERE jsonb_typeof(d.signatures) = 'object'
ON CONFLICT (deal_id, role) DO NOTHING;

-- Generic named counter table backing nextSeq() (invitation ids, message seq,
-- manifest seq). Values monotonic and collision-safe across processes.
CREATE TABLE IF NOT EXISTS seq (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auth state (challenges, nonces, revocations) with optional expiry.
CREATE TABLE IF NOT EXISTS auth_kv (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS auth_kv_expiry_idx ON auth_kv(expires_at);
`;

const MIGRATION_0006 = `-- 0006: wallet-scoped draft discovery (GET /me/deals).
-- Expression indexes so "drafts where this wallet is creator, buyer or
-- seller" stays an index scan as the table grows.
CREATE INDEX IF NOT EXISTS drafts_creator_lower_idx ON drafts (lower(creator_wallet));
CREATE INDEX IF NOT EXISTS drafts_buyer_lower_idx ON drafts (lower(terms->>'buyer'));
CREATE INDEX IF NOT EXISTS drafts_seller_lower_idx ON drafts (lower(terms->>'seller'));
`;

/** The ordered migration set, embedded so no filesystem access is required. */
export function defaultMigrations(): Migration[] {
  return [
    { id: "0001_init", sql: MIGRATION_0001 },
    { id: "0002_phase6", sql: MIGRATION_0002 },
    { id: "0003_evidence", sql: MIGRATION_0003 },
    { id: "0004_migrations", sql: MIGRATION_0004 },
    { id: "0005_durability", sql: MIGRATION_0005 },
    { id: "0006_wallet_drafts", sql: MIGRATION_0006 },
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

/** A Store that exposes its backing executor can migrate itself. */
interface MigratableStore {
  readonly executor?: SqlExecutor;
}

/**
 * Run the shared migration runner against a store. Returns [] for in-memory
 * stores (nothing to migrate). Used by the API/worker boot path so the schema
 * is present before durable registries are configured.
 */
export async function migrateStore(
  store: Store,
  migrations: Migration[] = defaultMigrations(),
): Promise<string[]> {
  const executor = (store as MigratableStore).executor;
  if (!executor) return [];
  return runMigrations(executor, migrations);
}
