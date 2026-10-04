-- 0001: core tables. Invitations store sha256(token), never the token.
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
