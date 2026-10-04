# Incident runbooks

Status: baseline 2026-10-04. Operational response for money-path incidents.
Companion code: `apps/worker/src/reliability/*` (resilient reads, buffered
gas, sponsorship budget, abuse controls), `packages/chain/src/recovery.ts`
(recovery packages), `apps/web/public/emergency.html` (API/indexer-independent
recovery page).

## 0. Ground rules (read before any runbook)

- **Contract state is authoritative.** Projections, dashboards, and this
  site's labels never override a chain read (`getDeal`, `getClaim`,
  `totalLiabilities`).
- **Pending is not included.** Verify inclusion (receipt + confirmation tag)
  before telling anyone an action landed. Unknown-outcome relay jobs are
  never auto-resubmitted (`apps/worker/src/relay.ts`).
- **Every right is directly exercisable.** `apps/web/public/emergency.html`
  is a single static file with no network calls. Paste a recovery package
  JSON (or chainId/hub/dealId), then submit the shown calldata from any
  wallet. It never signs or sends.
- **Relay is convenience only.** `openDispute` and all permissionless exits
  do not depend on the worker, API, or indexer.
- **Never log secrets.** Keys live in env/KMS; audit logs redact signatures,
  tokens, and private keys (`packages/store/src/audit.ts`).
- **Gas reserve caveat.** An ETH reserve helps the sponsor/operators pay
  emergency gas, but it cannot guarantee gas: it can be depleted, the sponsor
  key can be revoked or rate-limited, and a chain-wide outage stops all
  submission. Always keep at least one independently funded operator wallet
  and a path for affected users to self-submit.
- **Independent channels.** Keep an offline copy of recovery packages, a
  second RPC provider (or full node), and out-of-band comms (status page +
  email/social) that do not share the primary API.

Direct-submission recipe:

1. Open `emergency.html` from the canonical static host (it is also in the
   repo at `apps/web/public/emergency.html`).
2. Paste the deal's recovery package JSON, or type chainId/hub/dealId.
3. Pick the action row, copy its calldata.
4. In your wallet, send a **0-value** transaction to the **hub** address with
   that calldata. Confirm on the explorer.

---

## R1 — Relay / RPC outage

**Detection**
- Relay queue depth grows; `relay.*.failed` / `worker.degraded` audit events.
- `reliabilitySummaryFromEnv()` reports `rpc.urlsConfigured` low; RpcPool
  health checks fail and URLs sit in cooldown (`RPC_COOLDOWN_SECONDS=60`).
- `/health` reports degraded; sponsored submissions stop while reads still
  work from a fallback URL.

**Immediate actions**
- Confirm chain truth against a second provider before any re-queue.
- Update `BASE_RPC_URLS` order; `RpcPool` retries in preference order and
  cools each failed URL for the cooldown window, self-healing on recovery
  (`apps/worker/src/reliability/rpcPool.ts`).
- If the sponsor key/RPC is unavailable or the daily cap is hit, the relay
  returns **unsigned calldata** (`SPONSOR_DAILY_TX_CAP`, or the wei cap via
  `SponsorshipBudget`); tell clients to submit directly.
- Do not resubmit unknown-outcome jobs. Re-queue only after a receipt check.

**Independent recovery**
- `emergency.html` + wallet: submit the relevant permissionless calldata
  (`refundForNonDelivery`, `finalizeAfterTimeout`, `lapseDispute`,
  `advanceToPrimary`, `activateFallback`, `executeRuling`, `markDeadlock`,
  `catastrophicEscape`, `claimFor`).

**Comms**
- "The relay and some RPC endpoints are down. Contract state is authoritative
  and every right stays directly exercisable with your own wallet."

**Exit criteria**
- Two independent RPCs healthy, relay queue drained, no failed jobs in the
  last hour, reconcile delta `== 0`.

---

## R2 — Chain outage / recovery (sequencer halt, Base degradation)

**Detection**
- `getLatestBlockNumber` stalled; block timestamps frozen; RPC 5xx/timeouts.
- Reconciliation alerts on custody vs `totalLiabilities` drift.

**Immediate actions**
- Stop automatic sponsored submissions to avoid ambiguity around nonces and
  unknown outcomes; reads may still serve from cache/fallback.
- Snapshot deals with time-sensitive deadlines and compute **original**
  deadlines plus the 1h worker margin; the contract applies outage-adjusted
  deadlines itself (`apps/worker/src/progression.ts`).
- Do not infer failure from a missing receipt while the chain is halted.

**Independent recovery**
- `emergency.html` needs no RPC: recovery package calldata is pre-encoded.
  Once the chain resumes, submit directly and verify inclusion.

**Comms**
- State whether funds are safe (custody is on-chain and contracts are
  immutable), expected action window, and the direct-submission path.

**Exit criteria**
- Head advancing and finality resumed; delayed deadlines still satisfiable;
  reconcile delta `== 0`.

---

## R3 — Indexer lag / reorg

**Detection**
- Indexer tip behind head; parent-hash mismatch triggers walk-back
  (`apps/api/src/indexer.ts`); `removed=true` logs; `/health` indexer lag.
- Display projections disagree with chain reads.

**Immediate actions**
- Trust chain reads, not projections; trigger walk-back/replay/tick.
- Mark rolled-back events `orphaned`; rely on the `(tx_hash, log_index)`
  primary key for idempotency. For deep reorgs beyond the walk limit, run a
  full replay from the verified deployment block.
- Do not mutate signed terms or private records during replay.

**Independent recovery**
- Use the resilient reader (`createResilientReader`) for authoritative reads;
  use `emergency.html` for actions. Neither depends on the indexer.

**Comms**
- "Displays may lag during a reorg. Contract state is authoritative; no
  action is lost."

**Exit criteria**
- Tip within the confirmation depth, replay comparison matches chain reads,
  no orphaned events left unmapped.

---

## R4 — Reviewer key loss (timelocked rotation, pending-ruling survival)

**Detection**
- Queue attempts revert `BadTerms` for a stale auth epoch; quorum
  unreachable; reviewer reports lost key/device; rotation event observed.

**Immediate actions**
- Schedule an epoch rotation through the governance timelock; primary and
  fallback panels stay disjoint (`docs/phase9-rehearsal.md`, P-07).
- **Pending rulings survive rotation.** An award queued before rotation still
  executes after its delay (R3b). Do not re-queue an old-epoch ruling; it
  reverts. A fresh old-epoch queue is rejected.

**Independent recovery**
- Permissionless progression via `emergency.html`: `advanceToPrimary`,
  `activateFallback`, `executeRuling`; if review cannot complete,
  `markDeadlock` and the fixed 60-day `catastrophicEscape`.

**Comms**
- Disclose the rotation, confirm queued awards keep their execute time, and
  publish the new epoch.

**Exit criteria**
- New epoch panels seated, quorum reachable, pending rulings executed (or
  escaped), no stuck queues.

---

## R5 — Governance / pauser compromise

**Detection**
- Unexpected pause/unpause or role changes from pauser/governance addresses;
  new timelock operations; anomalous parameter changes.

**Immediate actions**
- Use the governance timelock delay to **cancel** malicious operations before
  execution; move remaining control to a fresh multisig via the timelock.
- Treat the pauser key as burned; rotate it. Re-authentication is required
  for sensitive operations (`apps/api/src/auth.ts`).
- Audit what pause can and cannot do (see R9).

**Independent recovery**
- `emergency.html` + direct calldata for all permissionless exits. A
  funding-only pause cannot block already-available exits on immutable
  contracts.

**Comms**
- Transparent incident disclosure: what was attempted, what executed, what
  users should do.

**Exit criteria**
- Malicious ops cancelled, roles rotated to clean keys, monitoring quiet,
  postmortem filed.

---

## R6 — Phishing

**Detection**
- Reports of look-alike domains, fake invite links, or signature requests
  that drain wallets; unexpected third-party scripts or previews.

**Immediate actions**
- Re-publish the canonical domain and the `emergency.html` path; remind users
  that the login signature is **not** a spending authorization (distinct
  EIP-712 primary types, `Midman sign-in only, no funds authorized`).
- Rotate invitation links (stored only as `sha256(token)`); revoke exposed
  tokens. Evidence reads stay reviewer-allowlisted.
- Keep invite links `no-referrer`/`no-store`/`noindex`.

**Independent recovery**
- Verify the hub address from the release manifest, then use
  `emergency.html` (no analytics, no external calls) and direct calldata.

**Comms**
- Domain advisory, takedown guidance, and a "how to verify the real hub
  address" note.

**Exit criteria**
- No new reports, takedowns landed, rotated links/tokens, no credential
  reuse.

---

## R7 — Storage / evidence compromise

**Detection**
- Anomalous S3/KMS access; integrity mismatch between stored evidence and
  on-chain commitments; receipt verification failures; unexpected downloads.

**Immediate actions**
- Rotate KMS keys and S3 credentials; tighten the reviewer allowlist.
- Verify stored files against on-chain `fileHashes` / evidence commitments;
  re-derive receipts. Never alter signed terms; private records are backed up,
  never reconstructed (`docs/indexer-recovery.md`).
- Preserve forensic copies; isolate the bucket.

**Independent recovery**
- On-chain evidence commitments remain authoritative. Use `emergency.html`
  calldata to progress review (`advanceToPrimary`, `activateFallback`,
  `executeRuling`) independent of the storage layer.

**Comms**
- Disclose scope, key rotation, and whether any evidence integrity is
  affected.

**Exit criteria**
- Keys rotated, access reviewed, all evidence commitments verified on-chain,
  no residual unauthorized access.

---

## R8 — Token-wide restriction / issuer pause (USDC freeze/blacklist)

**Detection**
- Transfers revert; issuer notice or freezes observed; reconciliation shows
  custody unable to move despite on-chain balance.

**Immediate actions**
- Identify affected addresses; treat token transfers as temporarily
  unavailable. Do **not** attempt to route around issuer controls.
- Document each deal's entitlements from chain state; keep claims visible so
  they can be paid when transfers resume.
- Keep gas in ETH (unaffected by the token), subject to the reserve caveat.

**Independent recovery**
- Entitlements persist on-chain; when the token resumes, `claimFor` and the
  refund/finalize paths settle. Use `emergency.html` for calldata throughout.

**Comms**
- State clearly that deal accounting is intact and settlement resumes with
  token transfers.

**Exit criteria**
- Token transfers resume, outstanding claims settled, reconcile delta
  `== 0`.

---

## R9 — Funding-only pause on immutable contracts (limits during an exit-function vulnerability)

**This runbook documents a hard LIMIT, not a mitigation.**

**Detection**
- Suspicious withdrawals via an exit function; invariant breach alarms
  (claims sum vs funded + bonds; `tokenBalance < totalLiabilities`); reconcile
  shortfall; anomalous `claimFor`/escape patterns.

**Immediate actions**
- Recognize what pause can do: on **immutable** contracts, a funding-only
  pause can stop **new funding** at most. It **cannot** stop an already
  exploitable exit path and cannot patch code.
- Do not represent "paused" as "contained." Coordinate incident response and
  preserve chain evidence; identify every path that can move value.

**Independent recovery**
- Surface the safe permissionless exits through `emergency.html` + direct
  calldata so honest parties can settle before an attacker does where
  possible; the fixed 60-day `catastrophicEscape` remains available while the
  contract is not fully drained.
- An ETH reserve helps operators respond, but cannot guarantee emergency gas
  (depletion, revoked sponsor key, or chain outage can block submission).

**Comms**
- Explicit and honest: what pause does and does not do, which exits remain
  open, and what users should do immediately. No false assurances.

**Exit criteria**
- Value movement contained or exhausted per incident plan, all counterparties
  informed, postmortem and any migration plan published.

---

## Appendix — limits and direct-submission parameters

| Control | Env var | Default |
|---|---|---|
| RPC cooldown | `RPC_COOLDOWN_SECONDS` | `60` |
| Gas buffer | (constant) | `2500` bps (+25%) |
| Gas fallback limit | `GAS_FALLBACK` | `400000` |
| Sponsor daily tx cap | `SPONSOR_DAILY_TX_CAP` | `50` |
| Sponsor daily wei cap | `SPONSOR_DAILY_WEI_CAP` | `20000000000000000` (0.02 ETH) |
| Budget persistence | `SPONSOR_BUDGET_FILE` | unset (in-memory) |
| Relay rate | `RELAY_RATE_PER_MIN` | `30` |
| Evidence upload rate | `EVIDENCE_RATE_PER_MIN` | `10` |
| Duplicate window | `DUPLICATE_WINDOW_SECONDS` | `300` |
| Relay payload max | `RELAY_MAX_BYTES` | `20000` |

`reliabilitySummaryFromEnv()` (in `apps/worker/src/reliability/index.ts`)
reports these without exposing secrets, for `/health` and docs.
