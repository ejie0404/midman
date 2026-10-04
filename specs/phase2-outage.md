# Phase 2 — Base outage algorithm (DESIGN, P-09 implementation)

Status: IMPLEMENTED (round-2 audit fix). The pseudocode in section 2 is the
contract baseline: an outage-deadline **least fixpoint** over an append-only,
absolute-age-pruned ledger with explicit availability semantics.

## 1. Sources

- Primary: Chainlink Base sequencer uptime feed (`answer == 0` healthy, `1`
  down; `startedAt`/`updatedAt` per round).
- Grace: from the deal's pinned `OutagePolicy.gracePeriodSeconds` (canonical
  1800s), added once per intersecting outage.
- History: an append-only `Outage[]` ledger in `MidmanPolicies`, populated by
  permissionless `reportOutage(feedRoundProof)`. Entries are pruned **only by
  absolute age** (see 2.2); there is no capacity eviction.
- Live trailing: the most recent down interval implied by the feed itself,
  derived at action time from `latestRoundData`/`getRoundData` (closes the
  report-delay window). Counted once, deduped against the ledger by exact
  `(start,end)`.

## 2. Derivation

### 2.1 Least fixpoint (same rule for every adjustable clock)

For an anchored clock with anchor `A` and original deadline `D0 = A + duration`:

```solidity
downtime(A,E) = SUM over retained outages i of
                 max(0, min(E, end_i) - max(A, start_i))
grace(A,E)    = GRACE * (number of retained outages i with overlap(A,E,i) > 0)
E is the least fixpoint of  E = D0 + downtime(A,E) + grace(A,E)
```

Iteration: start `E = D0`; up to `MAX_PASSES` (64) times, compute
`downtime`/`grace` over retained outages intersecting `[A, E]` and set
`newE = D0 + dt + gr`. The implementation accelerates the classic monotone
iteration: whenever an intersecting interval is only partially covered by `E`,
`RHS - E` is non-decreasing there, so no fixpoint can lie before that interval's
end; `E` jumps to the nearest such end. Once every intersecting interval is
fully covered the equation is exact and one step closes it. This converges in at
most one pass per interval end and:

- inherently extends for outages that fall **inside** an already-extended window;
- preserves the remaining usable time when an outage **crosses** `D0`.

`escapeAt` NEVER passes through this function (fixed 60-day cutoff, section 3).

Applied to: delivery, inspection, negotiation (24h), escalation (24h), evidence
(24h), primary (7d, anchored on the **adjusted** evidence end), fallback (7d).
Both `openDispute` (`now < effInspection`) and `finalizeAfterTimeout`
(`now >= effInspection`) call the identical `inspectionEff` calculation.

### 2.2 Retention and availability

`MidmanPolicies` keeps an append-only ledger with:

- `prunedBefore` — monotone max `end` of any pruned interval. Pruning drops only
  intervals whose `end < block.timestamp - MAX_HISTORY_AGE`; `prunedBefore` is
  advanced to the max dropped `end`.
- `outageSeen[keccak256(abi.encode(start,end))]` — permanent dedupe. Duplicates
  are rejected FOREVER, even after the interval is pruned.
- `reportOutage` **rejects** any interval that ended before
  `block.timestamp - MAX_HISTORY_AGE`, so a late historical report can never age
  out an interval a live clock still needs.
- `MAX_RETAINED = 256` retained interval bound; once exceeded the ledger sets
  `outageSaturated = true`.

`effectiveDeadline` returns **BOTH** the deadline and `available`. `available`
is `false` when (i) the clock's anchor precedes `prunedBefore`, (ii) the ledger
is saturated, (iii) the fixpoint does not converge within `MAX_PASSES`, or
(iv) a required feed read for the live trailing interval is malformed. Missing
or uncertain history therefore surfaces as **UNKNOWN, never as a shorter
deadline**.

Constants: `GRACE` = policy grace (canonical 1800s), `MAX_HISTORY_AGE` =
180 days (comfortably longer than the 60-day escape horizon),
`MAX_RETAINED` = 256, `MAX_PASSES` = 64.

### 2.3 Feed validation (strict)

A shared `readFeed()` validates: staticcall success, `ret.length == 160`,
`roundId > 0`, `answeredInRound == roundId`, `startedAt != 0 &&
startedAt <= block.timestamp`, `updatedAt != 0 && updatedAt <= block.timestamp`.
Historical `getRoundData` reads for down→up transitions are validated for round
identity and monotone `startedAt`. Any malformed/failed/stale read ⇒ feed state
UNKNOWN.

- UNKNOWN on a timeout/settlement path ⇒ `OutageUnknown` (never settle early).
- UNKNOWN on admission ⇒ admission proceeds against the **ORIGINAL** deadline
  (fail-open, never shortened below original).
- A down (non-UNKNOWN) feed yields the ongoing `[startedAt, now]` trailing
  interval, which extends clocks rather than blocking admission.

Allocated claims (`claimFor`, settled payouts) never consult the feed.

### 2.4 Authoritative deadline view

`MidmanHub.effectiveDeadlines(dealId)` (forwarded to `HubDispute`) returns:

```solidity
function effectiveDeadlines(bytes32 dealId)
    external view
    returns (uint64 delivery, uint64 inspection, uint64 negotiation,
             uint64 escalation, uint64 evidence, uint64 primary,
             uint64 fallbackEnd, bool available);
```

Each value is the `anchor + fixpoint` result; `available` is `false` if any
required history/feed is missing. `escapeAt` stays fixed at
`disputeOpenedAt + 5,184,000` and is deliberately NOT part of this view.

## 3. Fixed-escape conflict (locked P-09)

- `escapeAt = disputeOpenedAt + 5,184,000` — no adjustment, no oracle input.
- Escalation permitted while `now < effectiveEscalationEnd` even if that
  approaches `escapeAt`.
- Ruling queue rejected if `queueTime + executionDelay >= escapeAt` (must not
  suppress T23).
- If no executable ruling can fit before `escapeAt` → derived DEADLOCK → T23
  50/50 (buyer-ceil). Documented tradeoff, signed acceptance term.

## 4. Adversarial scenarios the implementation demonstrates

1. Timeout race: `openDispute` in the outage window vs `finalizeAfterTimeout` —
   dispute wins if `disputeTx < effDeadline`; timeout reverts during
   outage-unknown.
2. Delivery during outage: `markDelivered` uses the same fixpoint; no seller
   penalty for sequencer downtime.
3. Escalation at edge: escalate at `effEscalationEnd - 1` succeeds; at
   `>= effEscalationEnd` `lapseDispute` succeeds; both use the same feed state.
4. Multiple/cascading outages: disjoint and chained outages inside and across
   the extension all count, each adding its overlap plus one grace.
5. Delayed report: a report delayed up to `MAX_HISTORY_AGE` still counts; older
   reports are rejected (`OutageTooOld`).
6. Feed unavailable/invalid: `reportOutage` with a bad round reverts; timeouts
   revert `OutageUnknown`; claims unaffected.
7. Long outage vs escape: a multi-day outage starting day 3 → escalation
   allowed, rulings cannot fit → DEADLOCK → T23 executes at exactly day 60. No
   extension of `escapeAt`.
8. Keeper inactivity: no keeper calls for 10 days post-evidence-cutoff → any
   `advanceToPrimary`/`activateFallback` derives the correct phase from
   timestamps, no clock reset.
9. Retention: absolute-age pruning marks a pre-`prunedBefore` anchor
   unavailable; duplicates stay rejected after pruning; a saturated ledger
   reports unavailable instead of a shorter deadline.

Measurements: adjustment gas for `effectiveDeadlines` at 0/1/4/16 intervals is
recorded by `test/OutageDeadline.t.sol` (0 ≈ 169k, 1 ≈ 190k, 4 ≈ 252k,
16 ≈ 501k; the view computes all seven clocks). Hot state-changing paths
compute one or two clocks, not seven.
