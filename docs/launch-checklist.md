# Midman V1 — Launch checklist (Phased go-live)

Status: 2026-10-04. Operator checklist for the gradual launch. Each stage lists
**entry criteria**, **actions**, and the **rollback to funding-pause**. Expansion
between stages follows the recorded criteria in `docs/rollout-criteria.md`, not a
calendar.

## Stage 0 — Pre-launch (no funding)

**Entry criteria**
- All Phase 12 release checklist items green: reviewed release frozen, material
  findings closed, deployment manifest verified, roles assigned, independent
  reviewer + recovery coverage seated, bounty/reporting live.
- Offline drills pass: `node scripts/run-drills.mjs` reports `DRILLS: PASS`
  (restore + outage).
- Alerts deliver end to end: `ALERT_WEBHOOK_URL` configured and a test alert is
  received by the responsible operator; monitoring thresholds loaded from env.
- Readiness aggregate reviewed: `node scripts/readiness.mjs` — every required
  item PASS (or an explicitly accepted, recorded exception via `--warn-only`).

**Actions**
1. Freeze addresses/policy hashes in the manifest; verify `BASE_CHAIN_ID=8453`,
   `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `HUB_ADDRESS`, and
   all role addresses match the reviewed release.
2. Confirm the contract's `pauseNewFunding` is set (funding closed) until Stage 1
   begins.
3. Publish `docs/disclosures.md` before any funding.
4. Start the worker; confirm `workerHealth` reports `degraded=false` with RPC +
   hub configured, capacity green, and no alerts firing.

**Rollback** — remain in Stage 0; funding stays paused.

## Stage 1 — Controlled onboarding

**Entry criteria**
- Stage 0 complete and signed off by release leadership.
- Admission policy registered for the P-14 initial caps: 5 per reviewer pod,
  20 protocol-wide, ≤ 10,000 USDC per pair / 24h, all six categories.

**Actions**
1. Invite-only onboarding with deliberately low principal/volume; every deal
   passes contract-validated `FundingAdmission`.
2. **Daily reconciliation**: compare custody vs `totalLiabilities`, claim
   failures, and relay backlog; record the delta.
3. Track dispute rate, reviewer p95 turnaround, subsidy spend, sponsorship, and
   reconciliation breaks from day 1 per `docs/rollout-criteria.md`.
4. Keep primary and fallback reviewer pods independently staffed and keyed.

**Rollback** — pause new funding immediately (`pauseNewFunding`) if solvency
shortfall, capacity red, or reviewer capacity is exhausted; funded rights stay
intact.

## Stage 2 — Monitored growth

**Entry criteria**
- A full 30-day Stage 1 window meeting **all** expansion criteria: dispute rate
  < 5%, reviewer p95 < 5 days, sponsorship within budget, zero reconciliation
  breaks.
- Release leadership records the decision and registers a **new admission
  policy** with the raised limits.

**Actions**
1. Raise concurrency/exposure caps only via a new registered admission policy
   (never by editing funded deals).
2. Continue daily reconciliation and monthly subsidy/capacity review; re-run
   `node scripts/readiness.mjs` before each change.
3. Keep the pause path warm and rehearse it (`node scripts/run-drills.mjs`).

**Rollback** — pause new funding; keep the prior admission policy available for
resume. Existing funded rights unchanged.

## Stage 3 — Steady state

**Entry criteria**
- Two consecutive monitored windows inside the expansion criteria.
- Stable reviewer coverage, sponsorship within the $2,500/month interim pool
  (or the then-current approved pool), and no unresolved reconciliation breaks.

**Actions**
1. Operate within the current registered admission policy; review monthly.
2. Maintain post-sale reporting, authenticated support, and the independent
   recovery interface (`emergency.html` + recovery packages).
3. Expand further only through the recorded criteria and a new admission policy.

**Rollback** — the funding-pause action remains available at every stage and
never touches funded-deal rights.
