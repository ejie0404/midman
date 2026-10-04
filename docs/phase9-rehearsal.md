# Phase 9 — Arbitration operations rehearsal record

Status: 2026-10-03. `packages/contracts/test/e2e/Arbitration.t.sol` — **13/13 pass**
(local EVM, full suite 151 passed / 4 fork-skipped at that phase; current is 203 / 4). Reviewer-service and console
tests are covered in `apps/api/test/review.test.mjs` and
`apps/web/test/review.test.mjs`.

## What is rehearsed (staff can complete every supported outcome)

| Rehearsal | Proves |
|---|---|
| R1 Full primary, both bonds + both-side evidence | Quorum queue (2-of-3), chained evidence manifest, partial S=70% with exact fee/bond costs, execute after delay, conservation |
| R2 Veto → independent fallback | Primary-vetoed award cancels; fallback queued with **independent fallback sigs**; primary sigs rejected for fallback origin and vice versa |
| R3a Rotation invalidates old epoch | 72h panel rotation after evidence; old-epoch queue reverts `BadTerms`; new-epoch queue succeeds |
| R3b Queued ruling survives rotation | Award queued before rotation still executes after delay (P-07); a fresh old-epoch queue reverts |
| R4 Veto bounds | 1-of-3 veto reverts `NoQuorum`; veto after `executeAt` reverts `BadPhase`; veto of executed ruling reverts; late fallback veto lands in `DEADLOCK`; escape still available |
| R5 Ruling-nonce globality | Identical `rulingNonce` on a second deal reverts `BadNonce`; fresh nonce succeeds |
| R6 Missing respondent (subsidy) | Buyer full win `S=0`, zero respondent bond → zero arb revenue, claimant bond refunded, fee zero |
| R7 Missing escalation | Dispute opened, never escalated → lapse → inspection timeout settles seller; second `openDispute` reverts `DisputeExhausted` |
| R8 Late respondent bond | Bond after evidence cutoff reverts; review proceeds on claimant evidence alone (primary ruling succeeds) |
| R9 Deadlock → escape | Fallback expiry with no ruling → `markDeadlock` → fixed-cutoff `catastrophicEscape` |
| X1 Queue at escape−1s | Queue 1s before the 60-day cutoff is rejected (`BadPhase`); fixed escape settles |
| X2 Voluntary release after escapeAt | T05 release after the cutoff but before escape execution still settles (P-08) |
| X3 Execute at escapeAt | `executeRuling` at the cutoff reverts; `catastrophicEscape` then settles |

Every rehearsal asserts `claimsSum == funded + postedBonds` and checks
`tokenBalance >= totalLiabilities()` (hub solvent) before draining.

## Defects found and fixed during the rehearsal

1. **via-IR stale `block.timestamp` (test-harness bug).** With the via-IR
   optimizer, repeated `block.timestamp + k` deadline derivations across
   `vm.warp` boundaries were common-subexpression-eliminated, reusing a
   pre-warp value (the compiler assumes TIMESTAMP is block-stable, which the
   cheatcode violates). This produced wrong veto-auth expiries. Fixed by
   reading deadlines through `vm.getBlockTimestamp()` via a `_now()` helper in
   the e2e suite. **This is a test-only issue; production contracts never
   assume TIMESTAMP stability across calls because each transaction is one
   timestamp.** Other e2e suites should adopt the same `_now()` helper.
2. **`vm.expectRevert` consumed by helper view calls (test bug).** Ruling/
   veto preparation helpers performed an external `getDeal`/`actionDigest`
   view call after `vm.expectRevert`, consuming the expectation. Fixed by
   splitting preparation (`_prepQueue`) from the single state-changing call
   (`_sendQueue`).
3. **X1 premise corrected.** Queuing "just before escape" cannot reach the
   `executeAt >= escapeAt` guard under the fixed schedule (primary/fallback
   finish ~24 days before the 60-day cutoff); the rehearsal now asserts the
   reachable truth: late queues revert and the fixed escape settles. The
   `executeAt >= escapeAt` guard remains as defense-in-depth and is unit-tested.

## Reviewer service (apps/api)

- Quorum math excludes recused signers; quorum is enforced in the contract,
  not just the console.
- Award derivation uses `@midman/shared` `partialBondCosts` exactly
  (`floor(Qb·S/P)`, `floor(Qs·(P−S)/P)`); arbitrators choose only `S`.
- Approvals verify real EIP-712 signatures against non-recused panel members
  (outsider and duplicate rejected); veto carries no award/recipient fields.
- Settlement proposals are bounded (`0≤S≤P`, costs ≤ posted bonds) and rely on
  the on-chain settlement nonce to kill stale offers.

## Reviewer independence

Primary and fallback panels are disjoint by construction (enforced at panel
registration); vetoes are cancel-only. No reviewer — alone or through the
console — can bypass on-chain quorum.
