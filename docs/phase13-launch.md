# Phase 13 — Launch execution record

Status: 2026-10-04. This record ties the launch package together:
`docs/disclosures.md` (what users see before funding), `docs/rollout-criteria.md`
(recorded expansion/contraction gates), `docs/launch-checklist.md` (staged
go-live), and the Phase 10/12 monitoring + recovery systems. It is the Phase 13
deliverable and operates under the completion gate: **real transactions and
disputes are served reliably; financial reconciliation and incident controls
operate continuously; expansion follows recorded criteria rather than calendar
pressure.**

## 1. Tied artifacts

| Artifact | Purpose | Owner |
|---|---|---|
| `docs/disclosures.md` | Published before any funding; fee, deadline, dispute, catastrophic fallback, credential, and authority rules | Frontend/product |
| `docs/rollout-criteria.md` | Recorded EXPAND / HOLD / CONTRACT criteria + monthly review | Release leadership |
| `docs/launch-checklist.md` | Stage 0–3 entry criteria, actions, rollback | Release leadership + operations |
| `docs/incident-runbooks.md` | Money-path incident response (R1–R9) | Backend/platform + governance |
| `docs/phase10-recovery.md` | Backup/restore, drills, capacity/pause, independent access | Backend/platform |
| `apps/worker/src/monitoring/*` | Metrics, thresholds, alert delivery | Backend/platform |

## 2. Monitoring at launch

The worker emits the documented metrics on every pass (`MONITOR_METRICS` in
`apps/worker/src/monitoring/index.ts`) and evaluates them against env-driven
thresholds (`thresholdsFromEnv`). Operators must watch, at minimum:

- **Solvency:** `solvency.liabilitiesUnits`, `solvency.balanceUnits`,
  `solvency.ok` (critical alert on shortfall).
- **Rulings/disputes:** `rulings.pendingCount`, `rulings.overdueCount`,
  `rulings.queuedAgeMaxSeconds`, `disputes.inPrimary`, `disputes.inFallback`,
  `disputes.deadlock`, `escapes.eligibleCount`.
- **Operations:** `ops.relayQueued`, `ops.relayFailed`, `ops.relayUnsigned`,
  `ops.sponsors24h`, `ops.sponsorSpendWeiUnits`, `ops.indexerLagSeconds`.
- **Lifecycle/storage:** `lifecycle.fundingPaused`, `storage.evidenceCount`.

Thresholds (`LARGE_SETTLEMENT_UNITS`, `RULING_PENDING_MAX_SECONDS`,
`RELAY_FAILED_MAX`, `SPONSOR_DAILY_TX_CAP`, `SPONSOR_DAILY_WEI_CAP`,
`REVIEWER_INACTIVITY_SECONDS`) must be set explicitly in production; alerts
deliver to `ALERT_WEBHOOK_URL` and are deduped by `AlertDeduper`.

## 3. Capacity and pause policy

- **Admission.** Every launch deal passes the P-14 contract-validated
  `FundingAdmission`: all six categories, 5.00 USDC principal floor, 5 per
  reviewer pod, 20 protocol-wide, and ≤ 10,000 USDC aggregate exposure per
  buyer/seller pair per 24h. The admission signer denies funding but never
  settles or redirects.
- **Pause.** `pauseRecommendation` is true only when a hard capacity cap is
  exceeded (red). Pausing is **funding-only**: `PAUSE_NOTE` records that
  existing funded rights are preserved and immutable — no retroactive bond
  increase, no silent principal cap, no funded-deal rewrite. Pause also rejects
  stale admissions.
- **Escalation limit.** A funding pause cannot stop an already-deployable exit
  function; when combined with a suspected exit-function vulnerability it
  escalates to the incident runbooks (halt sponsored submission, publish the
  recovery package, direct participants to independent submission).

## 4. Support and post-sale reporting

- **Authenticated channels only.** Support is reachable only inside
  authenticated deal/session channels; operators verify wallet-bound identity
  before acting. No open email/DM money-path support.
- **Never handle credentials.** Support never asks for, receives, stores, or
  relays passwords, private keys, recovery phrases, or full secret codes. Known
  secret patterns are blocked/warned at upload and in chat (`P-12`).
- **Post-sale reporting.** Game-account and other post-settlement reports are
  support-channel reports under `P-12`: no warranty, no reopening after
  inspection. Published reporting covers dispute rate, subsidy spend, reviewer
  turnaround, sponsorship, claim failures, and reconciliation breaks per
  `docs/rollout-criteria.md`.
- **Independent access.** `GET /deals/:dealId/recovery` plus the static
  `emergency.html` let users exercise every permissionless right without the
  primary API/indexer.

## 5. Expansion discipline

Rollout pace is governed by admission and capacity, **not** by calendar
pressure:

1. A 30-day window must meet every recorded expansion criterion (dispute rate
   < 5%, reviewer p95 < 5 days, sponsorship within budget, zero reconciliation
   breaks).
2. Expansion is applied by registering a **new admission policy** referenced by
   new funding — never by editing funded deals or raising funded bonds.
3. Contraction (funding pause) triggers on solvency shortfall, capacity red, or
   exhausted reviewer capacity, and preserves all funded rights.
4. Release leadership owns the monthly review and records every decision,
   including the no-silent-principal-cap rule.

## 6. Operator commands

- Aggregate readiness (no live chain): `node scripts/readiness.mjs`
  (`--json`, `--warn-only`).
- Offline drills: `node scripts/run-drills.mjs` (`--json`).
- Build worker if dist is missing: `pnpm --filter @midman/worker build`.
