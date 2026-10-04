# Phase 10 — Reliability, monitoring and recovery record

Status: 2026-10-04. Recovery implementation lives in
`apps/worker/src/capacity/` and `apps/worker/src/drills/`; the drills are
injected and framework-agnostic so they run without a live chain or object
store. This record is the operational companion to the Phase 10 completion
gate: **users retain independent recovery access; staff can execute runbooks;
restored data/keys are usable; new funding can be stopped when risk or
capacity requires it.**

## 1. Targets

| Target | Value | Where enforced / measured |
|---|---|---|
| RPO (private metadata) | <= 15 min | Postgres WAL/continuous archiving + encrypted object versioning (`docs/indexer-recovery.md` section 4) |
| RTO | <= 4 h | restore runbook below; rehearsal in `apps/worker/src/drills/restore.ts` |
| Chain truth | authoritative | `packages/chain/src/reader.ts` `ChainReader`; DB projections are display only |
| Independent access | always | `packages/chain/src/recovery.ts` `buildRecoveryPackage` + `emergencyCalldata`; static `emergency.html` |

## 2. What is backed up

- **Private records (backed up, never reconstructed):** drafts, signatures,
  admissions, invitations (hashes only), relay outbox, sponsor ledger, audit
  logs. Schema: `apps/api/migrations/001_init.sql`, `002_phase6.sql`.
- **Encrypted evidence objects:** AES-256-GCM ciphertext in the versioned,
  S3-compatible object store, envelope-wrapped per-deal DEK in
  `<dealId>.dek.json` (`apps/api/src/evidence/store.ts`,
  `EncryptedBlobStore.exportBackup` / `importBackup`).
- **Manifests / proofs:** append-only, 5-year retention
  (`apps/api/src/evidence/registry.ts`). No backup of a manifest ever deletes
  a manifest entry; purge is a tombstone plus ciphertext deletion.
- **Chain projection (deletable, replayable):** `chain_events` + `indexer_tip`;
  rebuilt from the deployment block via `POST /indexer/replay` + ticks.

## 3. Key custody (restore must recover keys, not just ciphertext)

- Separate KMS keys per environment; DEKs are envelope-wrapped by a KEK.
- KEK-recovery shares are held **independently** by the ops lead and the
  arbitration lead (P-13 backup requirement, `specs/policy-register.md`).
  Neither alone can unwrap; both are required to reconstitute the KEK.
- `importBackup` fails closed on the wrong KEK (AES-GCM auth tag mismatch),
  so an incorrect key share cannot silently corrupt a restore.
- `EVIDENCE_KEK_HEX` is required (64 hex chars) outside dev; the ephemeral
  in-memory KEK warns loudly and is never for production.

## 4. Backup / restore procedure

1. **Database.** Restore the newest Postgres dump (or PITR to the last
   committed WAL segment). Apply outstanding migrations; start the API.
2. **Projection.** `POST /indexer/replay` from the verified deployment block,
   then `POST /indexer/tick` until `indexer_tip` matches a safe/finalized block.
   Compare per-deal phases and `totalLiabilities()` against direct chain reads;
   do not trust the projection alone.
3. **Evidence objects.** Restore ciphertext from versioned object backups
   (never overwrite the newest version). Then restore each wrapped DEK from the
   separately held key backup via `EncryptedBlobStore.importBackup`.
4. **Verify.** Re-download and re-hash a sampled set of blobs; every recovered
   plaintext must be byte-identical to its original hash.

## 5. Restore drill (code path + expected output)

`apps/worker/src/drills/restore.ts`:

- `restoreDrillWithLocalStore()` — runs the full drill against a self-contained
  AES-256-GCM store (`AesGcmBlobStore`) so it proves the logic without importing
  `apps/api` or a KEK env. It exercises the same method names the real
  `EncryptedBlobStore` exposes (`put`, `get`, `exists`, `delete`,
  `exportBackup`, `importBackup`, `dropCachedKey`, plus `exportRaw`/`importRaw`
  for the object snapshot).
- `restoreDrill({ blobStore, registry, exportBackup, importBackup, dealId,
  fileHash, bytes })` — the injected form; the real evidence store and manifest
  registry satisfy the structural interfaces read-only.

Steps performed (each is a `DrillStep` with `ok` + `detail`):

1. `store-encrypted-blob` — write/confirm the encrypted blob.
2. `export-wrapped-dek` — export the wrapped per-deal DEK + `kekId`.
3. `export-encrypted-blob` — snapshot ciphertext (versioned object backup).
4. `delete-ciphertext` — delete the blob; the wrapped DEK is retained.
5. `drop-cached-key` — clear the in-memory DEK (process-restart simulation).
6. `reimport-wrapped-dek` — re-import the DEK (fails closed on wrong KEK).
7. `restore-encrypted-blob` — re-import the ciphertext snapshot.
8. `re-download-and-rehash` — decrypt, re-hash, assert byte-identical.
9. `registry-manifest-hash-match` — (when a registry is supplied) the restored
   file hash still appears in the append-only manifest.

Expected output: `{ ok: true, steps: [...9 ok...], detail: "restore drill passed
for <dealId>" }`. A tampered blob yields `ok: false` with
`re-download-and-rehash.ok === false` — the drill fails closed.

## 6. Outage / token drills (code path)

`apps/worker/src/drills/outage.ts` — `outageDrill({ reader, feed })`,
injected, no live chain; `simulatedOutageDeps()` provides a deterministic
simulation.

| Step | Expected |
|---|---|
| `sequencer-timeout-fails-closed` | sequencer feed down -> timeout-gated actions fail closed |
| `sequencer-dispute-admission-open` | dispute admission stays open; rights remain exercisable offline |
| `rpc-primary-down` | primary RPC read fails |
| `rpc-pool-failover` | pooled read succeeds via failover |
| `token-claim-failed` | token-wide restriction -> claim fails |
| `token-liability-preserved` | liability after == liability before (> 0); no phantom settlement |

Chain outage / recovery and reviewer-key loss rehearsals follow the same
injected pattern; `packages/chain/src/recovery.ts` encodes calldata for the
permissionless paths (`refundForNonDelivery`, `finalizeAfterTimeout`,
`lapseDispute`, `advanceToPrimary`, `activateFallback`, `executeRuling`,
`markDeadlock`, `catastrophicEscape`, and `claimFor` kinds 0–5).

## 7. Capacity and pause policy (P-14)

`apps/worker/src/capacity/admission.ts` and `capacity/capacity.ts`:

- **Admission.** `AdmissionControls.admit(ctx)` rejects when the category is
  not allowlisted, principal is below 5 USDC (`MIN_PRINCIPAL_UNITS`), the
  per-pod concurrency cap (default 5) or protocol-wide cap (default 20) is
  reached, or the pair's 24h exposure plus the new principal would exceed the
  $10,000 cap (`10_000_000_000n`). Limits are env-driven
  (`MAX_CONCURRENT_ESCALATED_PER_POD`, `MAX_CONCURRENT_ESCALATED_PROTOCOL`,
  `AGGREGATE_PAIR_CAP_UNITS_PER_24H`, `CATEGORY_ALLOWLIST`; defaults are all
  six V1 categories). `aggregateExposure(deals, buyer, seller, sinceUnix)` sums
  principal for the unordered pair filtered by `fundedAt`.
- **Meter.** `CapacityMeter.measure()` reports
  `{ activeEscalated, openRelayJobs, evidenceCount, reviewerPending,
  apiWindowQps? }`; `assess(load, limits)` grades green / amber (>= 80%) /
  red (hard cap exceeded) with actionable notes.
- **Pause.** `pauseRecommendation(assessment)` returns true only when red.
  Pause is **funding-only**: `PAUSE_NOTE` records that existing funded rights
  are preserved and immutable — no retroactive bond increase, no silent
  principal cap, no funded-deal rewrite. `pauseNewFunding` also blocks stale
  admissions while paused (P-14).
- **Escalation to full stop.** Red capacity plus a suspected exit-function
  vulnerability escalates from funding pause to the incident runbook: halt
  sponsored submission, publish the recovery package, and direct participants to
  independent submission. Note the documented limitation: a funding-only pause
  cannot stop exploitation of an already-deployed defective exit function;
  funded deals keep their signed rules. Expansion of limits happens only via a
  new admission policy registration (Phase 13), never by editing funded deals.

## 8. Independent access: emergency.html + direct calldata

- `GET /deals/:dealId/recovery` (`packages/chain/src/recovery.ts`
  `buildRecoveryPackage`) emits signed terms, chain/contract IDs, policy IDs,
  relevant tx hashes, the indexer tip, and pre-encoded `emergencyCalldata` for
  every permissionless action — even when the API/indexer are down.
- `emergency.html` is the static, dependency-free interface: paste the recovery
  package, pick an action, and submit the embedded calldata directly from a
  wallet. It needs no backend, relayer, or indexer, so users are never locked
  out by an API or keeper outage.
- Every right is separately exercisable on-chain. Keeper/indexer downtime
  changes nothing: `apps/worker` convenience signals are non-authoritative, and
  the contract enforces exact deadlines and inclusion.

## 9. Verification

- Build/typecheck: `pnpm --filter @midman/worker build` and
  `pnpm --filter @midman/worker typecheck`.
- Drills/tests: `node --test test/capacity.test.mjs` from `apps/worker`
  (admission caps, 80%/100% capacity states, pause recommendation, restore
  ok + tamper-detected, outage steps, exact bigint exposure math).
- The lead wires `runAllDrills(ctx)` into `apps/worker/src/index.ts`.
