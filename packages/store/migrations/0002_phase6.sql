-- 0002: Phase 6 tables. Private records live here; chain projections are
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
