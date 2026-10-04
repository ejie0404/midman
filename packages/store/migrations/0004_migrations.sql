-- 0004: migration bookkeeping for the store-owned runner. Ids match the
-- ordered migration set and are recorded exactly once.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
