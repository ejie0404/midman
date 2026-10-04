-- 003: Future pg tables for the encrypted evidence subsystem.
--
-- NOTE: Phase 6/8 runtime uses the in-memory manifest registry
-- (apps/api/src/evidence/registry.ts) plus the encrypted blob store
-- (local dir or S3-compatible). These tables are the hosted-pg landing
-- zone for evidence_files / evidence_manifest / purge_approvals and are
-- NOT yet read by the API until the pg store wiring lands.
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
