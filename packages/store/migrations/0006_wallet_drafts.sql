-- 0006: wallet-scoped draft discovery (GET /me/deals).
-- Expression indexes so "drafts where this wallet is creator, buyer or
-- seller" stays an index scan as the table grows.
CREATE INDEX IF NOT EXISTS drafts_creator_lower_idx ON drafts (lower(creator_wallet));
CREATE INDEX IF NOT EXISTS drafts_buyer_lower_idx ON drafts (lower(terms->>'buyer'));
CREATE INDEX IF NOT EXISTS drafts_seller_lower_idx ON drafts (lower(terms->>'seller'));
