# Midman V1 — Rollout expansion and contraction criteria

Status: 2026-10-04. Recorded Phase 13 policy. Expansion is governed by these
written criteria and monthly review, **not by calendar pressure**. Funded deals
keep their signed rules and are never rewritten by a rollout change.

## 1. Admission at launch (all deals)

- **Every deal requires contract-validated admission.** A `FundingAdmission`
  signature (risk role, expiring within 24h) must be verified by the hub before
  funding; an admission signer can deny new funding but cannot settle, award, or
  redirect. _(P-14; `apps/worker/src/capacity/admission.ts`)_
- **All six V1 categories are admitted at launch:** INSTANT_CODE, GAME_ITEM,
  GAME_CURRENCY, DIGITAL_GOOD, SERVICE, GAME_ACCOUNT. A category outside this
  list is rejected. _(P-12, P-14)_
- **Initial capacity caps** enforced at admission: **5 concurrent escalated
  cases per reviewer pod, 20 protocol-wide, and ≤ 10,000 USDC aggregate
  exposure per buyer/seller pair per 24h** (principal floor 5.00 USDC). Limits
  are env-driven and default to the P-14 values. _(P-14; `admission.ts` defaults)_
- **Pause blocks stale admissions.** `pauseNewFunding` stops new funding while
  paused and rejects admissions issued before the pause. _(P-14)_

## 2. What is measured (from day 1)

| Metric | Definition | Source |
|---|---|---|
| Dispute rate | escalated disputes ÷ funded deals over the review window | `disputes.*` monitoring + case log |
| Subsidy spend / month | reviewer minutes + sponsorship + storage against the pool | `ops.sponsorSpendWeiUnits`, arbitration cost ledger |
| Reviewer p95 turnaround | 95th-percentile time from evidence cutoff to queued ruling | `rulings.queuedAgeMaxSeconds`, reviewer console |
| Sponsorship spend | sponsored gas per dispute and per month | sponsor ledger, `ops.sponsors24h` |
| Claim failures | failed claims / failed recipient transfers | reconcile + claim events |
| Reconciliation breaks | `custody < totalLiabilities` or unmatched ledger deltas | `solvency.*`, `reconcile()` |

Interim subsidy pool starts at **$2,500/month total** and is reviewed monthly.
_(P-14)_

## 3. Expansion criteria

EXPAND (raise concurrency/exposure limits) **only** when, over a full **30-day**
window, all of the following hold:

| Criterion | Threshold |
|---|---|
| Dispute rate | **< 5%** |
| Reviewer p95 turnaround | **< 5 days** |
| Sponsorship | **within budget** (no unreviewed overspend) |
| Reconciliation breaks | **zero** over the 30 days |

Every expansion is recorded and applied by **registering a NEW admission policy**
(new limits + policy hash), which is then referenced by new funding only. It is
**never** applied by editing funded deals, raising a funded bond, or changing
funded quorum/economics. _(P-14, P-07, P-15)_

## 4. Contraction criteria

Pause new funding (`pauseNewFunding`) when any of:

- **Solvency shortfall** — `custody < totalLiabilities` or any reconciliation
  break.
- **Capacity red** — a hard cap exceeded (`pauseRecommendation` true), e.g.
  per-pod/protocol escalated concurrency or reviewer pending.
- **Reviewer capacity exhausted** — the primary/fallback pods cannot staff the
  active case load within the selected clocks.

Contraction is **funding-only**: existing funded rights are preserved and
immutable. A funding pause cannot stop an already-available exit function and
does not retroactively change any bond, quorum, or deadline. _(P-14, P-15;
`PAUSE_NOTE`, docs/incident-runbooks.md R9)_

## 5. Ownership and the no-silent-cap rule

- **Monthly review is owned by release leadership**, with arbitration operations
  reporting reviewer p95, subsidy spend, and capacity, and backend/platform
  reporting reconciliation and claim failures. _(P-15)_
- **No silent principal cap.** Midman does not introduce a hidden user-facing
  maximum; growth is throttled through admission and capacity. Even during
  contraction, the recorded reason and the affected limits are published, and
  funded deals remain unchanged. _(P-14, P-15; implementation-plan.md Phase 13)_

## 6. Change log discipline

Every expansion or contraction records: date, window, metric values, decision
(EXPAND / HOLD / CONTRACT), the new admission policy id/hash where applicable,
and the approving owner. A contraction with no recorded expansion criteria met
is not reversed by time alone.
