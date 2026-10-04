# Phase 6 — Indexer, backup, replay, and recovery operations

Status: baseline 2026-10-03. Implements the Phase 6 gate with pointers to code.

## 1. What lives where

- **Reconstructable chain projection** (deletable, replayable): `chain_events`
  + `indexer_tip` rows. Rebuilt at any time via `POST /indexer/replay` +
  `POST /indexer/tick`. Indexer logic: `apps/api/src/indexer.ts`.
- **Private records** (backed up, never reconstructed): drafts, signatures,
  admissions, invitations (hashes only), relay outbox, sponsor ledger, audit
  logs. Schema: `apps/api/migrations/001_init.sql`, `002_phase6.sql`.
- **Chain truth**: the hub itself. `/deals/:id/status` reads `getDeal` first
  and labels the source (`chain` vs `projection` vs `draft`). A DB label can
  never override a contract read (tested).

## 2. Indexer operation

- Configure `HUB_ADDRESS`, `BASE_RPC_URLS` (comma-separated, failover),
  `INDEXER_FROM_BLOCK` (verified deployment block at release).
- Advance with `POST /indexer/tick` (worker calls this on its timer too).
- Continuity: every batch checks parent-hash linkage; mismatch triggers a
  walk-back (default 64 blocks) to the last common anchor, marks rolled-back
  events `orphaned`, and rescans. `removed=true` logs are orphaned directly.
- Idempotency: `(tx_hash, log_index)` primary key; re-ticks add nothing.
- Deep reorgs beyond the walk limit trigger a full replay from deployment.
- Confirmation display (`@midman/chain`): pending / included / safe /
  finalized from `safe`/`finalized` tags. Irreversible off-chain shipment
  only at `safe` or later; funding is effective at L2 inclusion.

## 3. Relay, sponsorship, and direct fallback

- `POST /relay/submit` records jobs in a durable outbox keyed by
  `idempotencyKey` (duplicates return the existing job, never a second job).
- The worker (`apps/worker`) claims each key once, re-checks light chain
  preconditions, then either sponsor-submits (bounded by
  `SPONSOR_DAILY_CAP_TXS`, default 50) or returns **unsigned calldata** for
  direct wallet submission. Unknown-outcome jobs are never auto-resubmitted;
  an operator re-queues after checking the chain.
- Progression worker enqueues due permissionless calls with deterministic
  daily keys (`deal:action:day`) using original clocks + 1h margin; the
  contract enforces exact outage-adjusted deadlines. Keeper/indexer downtime
  changes nothing on-chain: every right stays directly exercisable.

## 4. Backup and recovery

- Back up private records (Postgres dumps + encrypted object-store
  versioning) with RPO <= 15 min, RTO <= 4 h (drills in Phase 10).
- `GET /deals/:dealId/recovery` emits the downloadable recovery package
  (terms, digests, signatures, policy IDs, tx hashes, indexer tip, and
  pre-encoded emergency calldata for all permissionless actions). It works
  without the indexer (chain reads best-effort, calldata always present).
- Restore drill: restore DB backup, run `/indexer/replay` + ticks, compare
  `totalLiabilities` and per-deal phases against chain reads.

## 5. Degraded modes (all explicit, all tested)

- No `DATABASE_URL`: memory store (dev/test only; cross-process workers need
  Postgres — flagged in `/health`).
- No RPC: chain reads 503 with projection fallback; relay returns unsigned
  calldata; worker loop reports degraded and only serves local data.
- No `HUB_ADDRESS`: indexer/relay/recovery routes 503 with reason.
