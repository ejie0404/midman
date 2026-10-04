-- 0005: durability hardening (Phase 3 round-2 audit).
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
