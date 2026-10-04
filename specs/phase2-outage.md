# Phase 2 — Base outage algorithm (DESIGN for prototype, P-09 implementation)

Status: DESIGN 2026-10-03. Implements approved P-09 requirements. Pseudocode below is the contract baseline to prototype on fork; gas/history numbers TBD.

## 1. Sources

- Primary: Chainlink Base sequencer uptime feed (`answer == 0` healthy, `1` down; `startedAt`/`updatedAt` per round).
- Secondary: L1 batch staleness (latest batch inclusion timestamp vs `now`; threshold TBD in prototype, proposed 1h).
- Grace: 30 min after recovery before deadlines resume.
- History: contract stores compact outage ledger `outages[] = { start, end }` appended by permissionless `reportOutage(feedRoundProof)` or derived at action time from feed history (prototype measures which fits gas; bounded lookback, proposed max 8 intervals per adjustment).

## 2. Derivation (same rule for admission AND timeout)

```solidity
function effectiveDeadline(uint64 anchor, uint64 originalDeadline) internal view returns (uint64) {
    uint64 outageOverlap = 0;
    for (uint64 i = 0; i < outages.length && i < 8; i++) {
        uint64 s = outages[i].start; uint64 e = outages[i].end == 0 ? block.timestamp : outages[i].end;
        if (e <= anchor || s >= originalDeadline + GRACE) continue;
        uint64 lo = s > anchor ? s : anchor;
        uint64 hi = e < originalDeadline ? e : originalDeadline;
        // grace: outage extends by min(overlap + 30min recovery, actual downtime + grace)
        if (hi > lo) outageOverlap += (hi - lo) + GRACE_PERIOD;
    }
    return originalDeadline + outageOverlap; // escapeAt NEVER uses this function
}
```

- Applies to: delivery, inspection, negotiation (24h), escalation (24h), evidence (24h), primary (7d), fallback (7d). Both `openDispute` (`now < effInspection`) and `finalizeAfterTimeout` (`now >= effInspection`) call it with identical `(deliveredAt, originalInspectionDeadline)`.
- Feed-stale/unknown → `effectiveDeadline` treated as NOT REACHED for timeout paths (fail-closed: `finalizeAfterTimeout` reverts `OutageUnknown`), but dispute admission uses original deadline optimistically (fail-open) with retroactive adjustment once feed recovers.
- Allocated claims (`claimFor`, settled payouts) never consult the feed.

## 3. Fixed-escape conflict (locked P-09)

- `escapeAt = disputeOpenedAt + 5,184,000` — no adjustment, no oracle input.
- Escalation permitted while `now < effectiveEscalationEnd` even if that approaches `escapeAt`.
- Ruling queue rejected if `queueTime + executionDelay >= escapeAt` (must not suppress T23).
- If no executable ruling can fit before `escapeAt` → derived DEADLOCK → T23 50/50 (buyer-ceil). Documented tradeoff, signed acceptance term.

## 4. Adversarial scenarios the prototype MUST demonstrate (fork + time-travel)

1. Timeout race: buyer `openDispute` in same outage window where seller attempts `finalizeAfterTimeout` — dispute wins if `disputeTx < effDeadline`; timeout reverts during outage-unknown.
2. Delivery during outage: `markDelivered` blocked/adjusted consistently; no seller penalty for sequencer downtime.
3. Escalation at edge: escalate at `effEscalationEnd - 1` succeeds; at `>= effEscalationEnd` `lapseDispute` succeeds; both use same feed state.
4. Multiple outages: two disjoint 6h outages inside inspection → deadline extends by 12h + grace each; ledger bounded at 8 intervals.
5. Delayed feed update: feed reports recovery 2h late → timeouts stay blocked until update; admission stays open; no inconsistent split between the two paths.
6. Feed unavailable/invalid: `reportOutage` with bad round reverts; timeouts blocked; claims unaffected.
7. Long outage vs escape: 55-day outage starting day 3 → escalation allowed, rulings cannot fit → DEADLOCK → T23 executes at day 60. Assert no extension of `escapeAt`.
8. Keeper inactivity: no keeper calls for 10 days post-evidence-cutoff → anyone's `advanceToPrimary`/`activateFallback` derives correct phase from timestamps, no clock reset.

Measurements to record: adjustment gas at 0/1/4/8 intervals, feed-history lookback depth needed, worst-case `fund`/`openDispute` gas with outage check. TBD pending forge.
