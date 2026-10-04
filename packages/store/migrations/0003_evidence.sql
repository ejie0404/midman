-- 0003: hosted-pg landing zone for the encrypted evidence subsystem and the
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
