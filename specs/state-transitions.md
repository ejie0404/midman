# Midman V1 state-transition specification

Version: 0.2.0-phase1-approved. Status: **Phase 1 approved; only RB-01 algorithm detail and RB-06 custody/payment binding remain as bounded Phase 2 experiments**. This document formalizes the supplied amendments plus approved policy register P-01..P-15; it does not select custody architecture or outage pseudocode. The canonical identifiers and approved decisions are in [contract-spec.json](contract-spec.json) and [policy-register.md](policy-register.md). Financial effects are defined in [financial-ledger.md](financial-ledger.md); signed commitments are defined in [signed-policy.md](signed-policy.md).

## 1. States and authoritative storage

| State | Meaning |
|---|---|
| `AWAITING_DELIVERY` | Funding completed atomically; no delivery declaration has been accepted |
| `DELIVERED` | Seller declared delivery; buyer can approve, and can dispute only if its one dispute right remains |
| `SELF_RESOLUTION` | First 24 hours of the one buyer dispute |
| `AWAITING_ESCALATION` | Subsequent 24-hour claimant escalation window |
| `EVIDENCE` | Claimant's real bond has been posted; respondent may contest under the signed policy |
| `PRIMARY_REVIEW` | Evidence cutoff passed; primary panel may queue a ruling |
| `FALLBACK_REVIEW` | Primary failed or its pending ruling was vetoed |
| `RULING_PENDING` | A quorum-authorized award is committed but not yet executed |
| `DEADLOCK` | Fallback decision deadline passed with no pending executable award |
| `SETTLED` | Financial entitlements allocated once; remaining claims are independent liabilities |

There is no separate funded-but-empty state. Refund eligibility is derived from a deadline; it does not require a keeper to set `REFUNDABLE`. Unclaimed payouts do not keep a transaction financially unsettled.

Minimum per-deal storage: immutable terms hash and policy IDs; participants and recipients; principal and quoted/prepaid fees; funding/delivery timestamps; `disputeUsed`; original dispute timestamp; escalation timestamp; evidence/primary/fallback timestamps; pending ruling hash, origin and execution timestamp; actual bond balances; terminal outcome identifier; allocated liabilities.

`ACTIVE` in the table means any funded nonterminal state. `OFFCHAIN` denotes an authorization lifecycle, not an empty on-chain financial deal. A revocation mapping may exist without creating a financial deal.

## 2. Clocks, effective phases and precedence

All amounts use integer USDC units. All on-chain deadlines use chain timestamps in seconds; the browser clock is display-only.

```text
originalDeliveryDeadline   = fundedAt + deliveryPeriodSeconds
originalInspectionDeadline = deliveredAt + inspectionPeriodSeconds
originalSelfResolutionEnd  = disputeOpenedAt + 86,400
originalEscalationEnd      = originalSelfResolutionEnd + 86,400
originalEvidenceEnd        = escalatedAt + signedRespondentEvidenceSeconds
escapeAt                   = disputeOpenedAt + 5,184,000
```

The first five deadlines may require the signed outage policy's adjustment. The last is a locked, fixed 60-day cutoff and is never adjusted. Lapse preserves the original inspection anchor; it does not start another inspection clock. Both dispute admission and timeout settlement use the same effective inspection deadline derived from that anchor.

The original plan recommended a 24-hour respondent evidence window. That value is now LOCKED (P-06/P-13): `respondentEvidenceSeconds = 86,400`. Primary review is 7 days, fallback review 7 days, execution delays tiered 24h/48h/72h by principal tier (P-05/P-06).

`effectivePrimaryEnd = effectiveEvidenceEnd + 604,800`, `effectiveFallbackEnd = effectivePrimaryEnd + 604,800`, subject to the outage policy. Primary and fallback durations and tiered ruling delays are approved launch values (P-05/P-06). On primary timeout, fallback begins at the effective primary deadline, **not when a keeper eventually notices**. On an earlier primary veto, fallback begins at the veto event. Subsequent fallback vetoes do not reset its recorded start or extend its deadline.

A function validates the logically current phase from timestamps even if nobody has called a housekeeping transition. Normalization may atomically advance overdue phases before applying the requested action. It must not extend a clock or perform an unexpected terminal payout. Explicit T10/T15/T16/T22 calls provide permissionless materialization of those same derived phases.

At any ordinary deadline, the timely action uses `< deadline`; the opposing timeout action uses `>= deadline`. A funding authorization likewise requires `now < fundingDeadline`.

An executed terminal settlement takes precedence over every subsequent action. When `now >= escapeAt`, no arbitration award executes and no new arbitration process begins. Catastrophic escape applies only to a **properly escalated**, unsettled dispute. An un-escalated free dispute does not become eligible for a 50/50 award merely because it was never materialized as lapsed.

RB-01 Phase 1 requirements are locked (P-09): adjustable clocks are delivery/inspection/negotiation/escalation/evidence/primary/fallback; escapeAt is never adjusted; outage-vs-escape conflict resolves via DEADLOCK→T23 with queue rejection when `executeAt >= escapeAt`. Only the exact feed-derivation pseudocode and gas/history measurements remain as a bounded Phase 2 experiment.

## 3. Transition table

Every row references an exact ledger rule. Where a ruling or signature is required, any third party may relay the valid authorization; the relayer gains no decision authority.

| ID | Action / allowed caller | From → to | Required conditions and changes | Ledger |
|---|---|---|---|---|
| T01 | `fund` / buyer or valid funding authorization | OFFCHAIN → AWAITING_DELIVERY | Funding unpaused; signatures match the same nonrevoked, unused terms; deadline unexpired; signed policies are registered and suitable for principal/category; collect exactly `P+B0`; consume authorizations; record `fundedAt` | L-FUND |
| T02 | `revokeUnfundedTerms` / either signed participant | OFFCHAIN → OFFCHAIN | Caller has authenticated revocation authority over the identified unfunded terms; record irreversible revocation; reject revocation of a funded deal | L-NONE |
| T03 | `markDelivered` / seller | AWAITING_DELIVERY → DELIVERED | `now < effectiveDeliveryDeadline`; one declaration only; validate category evidence commitment; record `deliveredAt` and original inspection deadline | L-NONE |
| T04 | `refundForNonDelivery` / anyone | AWAITING_DELIVERY → SETTLED | `now >= effectiveDeliveryDeadline`; no delivery declaration; award `S=0` | L-NORMAL |
| T05 | `approveSeller` / buyer | ACTIVE → SETTLED | Authenticated explicit release; award `S=P`; invalidate pending ruling/offers; apply signed non-ruling bond treatment | L-NORMAL |
| T06 | `refundBuyer` / seller | ACTIVE → SETTLED | Authenticated explicit full refund; award `S=0`; invalidate pending ruling/offers; apply signed non-ruling bond treatment | L-NORMAL |
| T07 | `mutualSettlement` / anyone with matching buyer and seller authorizations | ACTIVE → SETTLED | Matching fresh signatures commit to `S`, bond disposition and current settlement nonce; validate all bounds/policies; invalidate pending ruling/offers | L-NORMAL |
| T08 | `finalizeAfterTimeout` / anyone | DELIVERED → SETTLED | `now >= effectiveInspectionDeadline`; no live dispute; award `S=P`; `disputeUsed` may be true after a lapse | L-NORMAL |
| T09 | `openDispute` / buyer | DELIVERED → SELF_RESOLUTION | `now < effectiveInspectionDeadline`; `disputeUsed=false`; set it permanently true and record `disputeOpenedAt/escapeAt`; no bond or file-upload prerequisite | L-NONE |
| T10 | `advanceNegotiation` / anyone | SELF_RESOLUTION → AWAITING_ESCALATION | Effective negotiation deadline reached; claimant has not escalated; derive remaining window without restarting any clock | L-NONE |
| T11 | `escalate` / buyer | SELF_RESOLUTION or AWAITING_ESCALATION → EVIDENCE | Effective negotiation deadline reached and `now < effectiveEscalationEnd` and `now < escapeAt`; claimant bond fully collateralized once; record `escalatedAt` and evidence deadline | L-BOND |
| T12 | `lapseDispute` / anyone | SELF_RESOLUTION or AWAITING_ESCALATION → DELIVERED | `now >= effectiveEscalationEnd`; claimant did not escalate; preserve original inspection deadline and `disputeUsed=true`; do not restore the dispute right | L-NONE |
| T13 | `postRespondentBond` / seller or authorized payer | EVIDENCE → EVIDENCE | `now < effectiveEvidenceEnd` and `now < escapeAt`; post exactly the signed respondent bond once; no default loss for nonparticipation | L-BOND |
| T14 | `submitEvidenceCommitment` / an authorized participant | EVIDENCE → EVIDENCE | Before effective evidence cutoff and escape cutoff; append signed manifest commitment; claimant collateral already present; respondent's new-submission requirements are RB-08 | L-NONE |
| T15 | `advanceToPrimary` / anyone | EVIDENCE → PRIMARY_REVIEW | Effective evidence cutoff reached and `now < escapeAt`; primary start derives from cutoff, not transaction inclusion time | L-NONE |
| T16 | `activateFallback` / anyone | PRIMARY_REVIEW → FALLBACK_REVIEW | Primary deadline reached; no pending award; `now < escapeAt`; fixed fallback start derives from primary deadline | L-NONE |
| T17 | `queuePrimaryRuling` / anyone with primary quorum | PRIMARY_REVIEW → RULING_PENDING | Before primary decision deadline; unique authorized approvals satisfy policy; validate principal/bond award; save ruling hash, primary origin, epoch and delay | L-NONE |
| T18 | `queueFallbackRuling` / anyone with fallback quorum | FALLBACK_REVIEW → RULING_PENDING | Before fallback decision deadline; independently authorized fallback quorum; validate award; save fallback origin and delay | L-NONE |
| T19 | `vetoPrimaryRuling` / independent veto authority under policy | RULING_PENDING → FALLBACK_REVIEW | Pending origin is primary; `now < executeAt` and `now < escapeAt`; cancel that ruling; begin fallback once; no payout authority | L-NONE |
| T20 | `vetoFallbackRuling` / independent veto authority under policy | RULING_PENDING → FALLBACK_REVIEW | Pending origin is fallback; before execution and escape; cancel that ruling; preserve existing fallback start/deadline; if overdue, derived next phase is DEADLOCK | L-NONE |
| T21 | `executeRuling` / anyone | RULING_PENDING → SETTLED | `now >= executeAt` and `now < escapeAt`; exact queued ruling still valid and not vetoed; governance/revocation treatment is RB-05 | L-NORMAL |
| T22 | `markDeadlock` / anyone | FALLBACK_REVIEW → DEADLOCK | Fallback decision deadline reached; no pending award; recording this state does not move `escapeAt` | L-NONE |
| T23 | `catastrophicEscape` / anyone | Escalated EVIDENCE / PRIMARY_REVIEW / FALLBACK_REVIEW / RULING_PENDING / DEADLOCK → SETTLED | `now >= escapeAt`; no prior settlement; bypass pending award and normal fee formula; independent of a housekeeping keeper or availability oracle | L-CATASTROPHIC |
| T24 | `claimFor` / anyone | Any → same deal state | Claim exists; fixed recipient; update liability before safe token call with reentrancy protection; a failed transfer reverts its claim update | L-CLAIM |
| T25 | `pauseNewFunding` / pauser | Any → same deal state | Set admission pause; no restriction on funded-deal rights, housekeeping or claims | L-NONE |
| T26 | `unpauseNewFunding` / timelocked governance | Any → same deal state | Required governance delay completed; clear admission pause without rewriting funded terms | L-NONE |

Queueing a ruling with `executeAt >= escapeAt` should be rejected as an implementation refinement: it can never execute under the locked cutoff. It must not suppress T23. Review deadlines govern **queueing**, not later permissionless execution of an already valid queued award. They do not automatically replace a pending award with fallback while its ruling delay is running.

T05/T06/T07 remain available after `escapeAt` until T23 executes (approved P-08). They must never provide a post-cutoff arbitration execution route. T17/T18/T21 are prohibited at/after `escapeAt`; T19/T20 are moot once no executable award can remain.

## 4. Pause, delivery and dispute UX

The pause check appears only on new funding/admission. Settled claims require neither a reviewer, an indexer, an uptime oracle, nor an operational backend. Token transfers still depend on USDC and chain availability.

Dispute UX: request the minimal authenticated freeze transaction; show pending submission; verify successful inclusion and deal state; display funds frozen; then upload evidence. Wallet signing, HTTP success, or a queued relay job is not inclusion. Reorg-aware indexing must correct a rolled-back transition.

Readiness consent must be expiring (2h, required for <=3h pricing tier) and validated before short-deal funding (P-11). Do not add an indefinite funded waiting-for-readiness phase. Funding confirmation: L2 inclusion usable, `safe`/batch inclusion recommended before irreversible off-chain shipment.

When a dispute lapses, the interface prominently explains that the one unilateral dispute right is exhausted. The buyer can still release; the seller can refund; mutual settlement may remain available under the policy. Remaining inspection time does not restore protection.

## 5. State invariants and release blockers

One atomic funding per terms authorization; one delivery declaration; at most one initial buyer dispute; one immutable original dispute timestamp; at most one real claimant and respondent bond with approved P-03/P-04 dispositions; no ruling execution at/after escape; no double settlement; no new claims created by claiming; all timeout progression permissionless; no new-funding pause applied to existing financial rights.

Phase 1 approved P-01..P-15 on 2026-10-03. Remaining bounded Phase 2 experiments: RB-01 exact outage derivation + measurements, RB-06 custody/payment/wallet matrix. No other fee, bond, quorum, delay, veto, duration, readiness, retention, or subsidy change may affect funded deals.
