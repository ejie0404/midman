# Midman V1 Phase 1 — Policy Decision Register (APPROVED)

Version: 0.2.0-phase1-approved. Status: **APPROVED 2026-10-03 — implement in Phase 4; only RB-01 algorithm detail + RB-06 custody/payment remain as bounded Phase 2 experiments**.
Date: 2026-10-03.

This register is the Phase 1 deliverable per `implementation-plan.md`. It proposes one explicit rule for every financial outcome and operational requirement, preserving the locked foundation:

- Base / native USDC, 5 USDC minimum principal, no user-facing ceiling, 0.50 USDC minimum quoted fee, proportional fees on partial settlements (`floor(F*S/P)`, buyer-floor/seller-remainder), separately collateralized bonds, one free initial buyer freeze, immutable funded-deal terms, 24h negotiation + subsequent 24h escalation, fixed 60-day catastrophic cutoff.

Nothing here edits `state-transitions.md`, `financial-ledger.md`, `signed-policy.md`, or `contract-spec.json` until approved. After approval, all three linked artifacts + manifest must be updated together.

Notation: `P` principal, `F` quoted fee, `S` seller principal award, `B0` prepaid buyer fee, `Qb/Qs` posted bonds, `Cb/Cs` retained bond costs. All amounts integer USDC smallest units (6 decimals: 5 USDC = 5,000,000).

---

## P-01 (RB-04a) Quotation rounding — PROPOSED: CEIL

Rule: `F = max(500_000, ceil(P * rateBps / 10_000))`.

- `rateBps` from locked fee tiers (25 / 50 / 70 / 100 / 200 by delivery+inspection duration).
- `ceil(a/b) = (a + b - 1) / b` integer.
- Rationale: actual fee already uses floor; quote ceil guarantees the disclosed schedule rate is met and the 0.50 minimum is never undercut by a fractional unit. Maximum divergence from floor-quote is 1 unit per deal.
- Effect on existing model: `validate-spec.mjs` currently allows any `F` in `[500_000, P]`; ceil-quote remains inside that range. No model change needed; add a quote-rounding unit test in Phase 5.
- Alternative rejected: floor-quote saves the buyer at most 1 unit but can quote below the schedule rate (e.g. P=5,000,001 at 25bps → 12,500.0025 → floor 12,500 vs ceil 12,501; both then clamped to 500,000 minimum, so difference only matters above ~200 USDC principals).

Gate: approve CEIL or explicitly select FLOOR. No other option permitted.

## P-02 (RB-04b) Catastrophic split dust — PROPOSED: odd unit to buyer

Rule (L-CATASTROPHIC refinement):

```text
buyerPrincipalShare  = (P + 1) / 2   // integer div, ceil(P/2)
sellerPrincipalShare = P / 2         // floor(P/2)
```

- Deterministic, caller-independent, satisfies `abs(diff) <= 1`.
- Rationale: buyer funded `P + B0`; giving the 1-unit remainder to the buyer partially offsets the buyer having locked the fee contribution (which is fully refunded on this path anyway). Either recipient is defensible; determinism is the requirement.
- Example: P=5,000,001 → buyer 2,500,001 + B0 refund, seller 2,500,000, fee 0, bonds fully refunded.
- Alternative: odd unit to seller — record here if selected instead.

Gate: approve buyer-remainder. Manifest `catastrophicPrincipalRounding` becomes `BUYER_CEIL_SELLER_FLOOR`.

## P-03 (RB-03a) Partial-ruling bond costs — PROPOSED: proportional loser-share, bounded

For executed ruling T21 with `0 < S < P`, with posted `Qb, Qs`:

```text
Cb = floor(Qb * S / P)
Cs = floor(Qs * (P - S) / P)
buyerBondRefund  = Qb - Cb
sellerBondRefund = Qs - Cs
arbitrationCostClaim = Cb + Cs
```

- Full wins remain as already specified: S=0 → Cb=0, Cs=Qs (if posted); S=P → Cb=Qb, Cs=0. The formula above generalizes both endpoints exactly (floor preserves endpoints).
- Nonparticipant bond is 0 → yields 0 cost. No fictional revenue. Missing respondent bond never creates a default loss; claimant still gets `Cb=0` only if S=0, else pays proportional cost per formula.
- Arbitrators choose only `S`; `Cb/Cs` are derived, not negotiated. Ruling validation rejects `Cb > Qb` or `Cs > Qs`.
- Worked: P=100, Qb=Qs=5, S=70 → Cb=floor(5*70/100)=3.5→3.5 USDC in units (3,500,000), Cs=floor(5*30/100)=1.5 USDC. Total cost 5.0 USDC to `arbitrationCostRecipient`.
- Alternative rejected: full loser-takes-all on any partial (cliff at 50%) — creates a 1-unit principal discontinuity in bond costs. Alternative rejected: zero costs on partials — leaves review unfunded and invites low-merit escalation.

Gate: approve proportional formula or select a fixed schedule (e.g. loser forfeits 100% of own bond pro-rata table). Any selection must satisfy `0<=Cb<=Qb`, `0<=Cs<=Qs`.

## P-04 (RB-03b) Voluntary release / refund / settlement bond handling — PROPOSED

| Path | Bond rule |
|---|---|
| T05 `approveSeller` (buyer releases) before any escalation | No bonds exist. N/A. |
| T05 after escalation (during EVIDENCE/PRIMARY/FALLBACK/RULING_PENDING) | Refund both posted bonds in full: Cb=Cs=0. Unilateral release may not forfeit the counterparty bond. |
| T06 `refundBuyer` (seller refunds), any time | Same: Cb=Cs=0, full bond refunds. |
| T07 `mutualSettlement` | Signed `MutualSettlement` must commit to explicit `Cb, Cs` with `0<=Cb<=Qb`, `0<=Cs<=Qs`. If no bonds posted, both zero. Unilateral T05/T06 cannot smuggle a bond cost; only bilateral T07 can allocate nonzero costs, bounded by posted amounts. Stale settlement nonce invalidated by any bond posting or phase change. |

- Rationale: unilateral generosity must not punish the other side's collateral; only mutual agreement or a ruling can impose costs. Prevents buyer-release griefing the seller bond and vice versa.
- Pending ruling invalidation: T05/T06/T07 invalidate any queued ruling (already in spec); bond refunds above apply atomically in the same settlement.

Gate: approve full-refund-on-unilateral + bounded-mutual-choice.

## P-05 (RB-02a) Principal-based arbitration tiers — PROPOSED

No user-facing ceiling is introduced. Tiers select quorum/delay strength, enforced at funding via `arbitrationPolicyId` suitability:

| Tier | Principal range | Primary quorum | Fallback quorum | Ruling execution delay |
|---|---|---|---|---|
| T1 standard | 5 – 1,000 USDC | 2-of-3 | 2-of-3 (disjoint reviewer set from primary) | 24h |
| T2 large | >1,000 – 10,000 USDC | 3-of-5 | 3-of-5 (disjoint) | 48h |
| T3 whale | >10,000 USDC | 3-of-5 | 3-of-5 (disjoint) + veto authority must co-sign no-objection before execution* | 72h |

*No-objection = absence of veto within delay; veto never approves an award, it only cancels. T3 does not give veto payout authority.

- Minimum 2-of-3 everywhere (locked). Keys represent independently secured approval paths; primary and fallback signer sets must be disjoint at registration.
- Aggregate splitting (many small deals to evade T2/T3) is handled by admission monitoring (P-14), not by retroactive quorum upgrades. Funded-deal quorum never changes.
- Alternative considered: uniform 2-of-3 for all values — rejected as insufficient for the unlimited-ceiling decision per audit §8.

Gate: approve ranges/quorums or supply alternates. Ranges must be continuous, non-overlapping, cover `[5 USDC, ∞)`.

## P-06 (RB-02b) Review durations and decision windows — PROPOSED

Measured from derived (effective) timestamps, not keeper transaction time:

- Respondent evidence: 24h after `escalatedAt` (confirm the plan's proposed value as locked). Respondent may post bond + submit commitments any time before `effectiveEvidenceEnd`; nonparticipation = no bond, no default loss, review proceeds on claimant evidence + delivery record.
- Primary review: 7 days after `effectiveEvidenceEnd`.
- Fallback review: 7 days after effective primary deadline (or after primary veto event, preserving original fallback deadline if veto arrives late — per spec §2).
- Ruling queue expiry: ruling must be queued before its review deadline AND satisfy `executeAt < escapeAt`; otherwise reject queue (must not suppress T23).
- Total worst case: 24h negotiation + 24h escalation + 24h evidence + 7d primary + up to 3d delay + 7d fallback + up to 3d delay ≈ 24.5 days < 60-day escape. Leaves ~35 days slack for outages/delays. Compliant by construction.

Gate: approve 24h / 7d / 7d + tiered delays, or supply alternates that still sum to < 60 days including maximum delay.

## P-07 (RB-05a) Veto and signer-recovery authority — PROPOSED

- Veto scope: cancel-only. Veto authority (independent from ruling quorums, 2-of-3 multisig recommended) may cancel a queued ruling for policy violation, fraud, key compromise, or out-of-bounds award. Veto carries no replacement award and no recipient redirection. T19 → fallback start; T20 preserves fallback start/deadline (or DEADLOCK if overdue).
- Veto window: `now < executeAt` and `now < escapeAt`. No veto after execution or after escape cutoff.
- Signer recovery: reviewer registry supports key rotation only via timelocked governance (proposed 72h delay, see P-08) with public revocation record. Rotation never reduces quorum, never installs a single-admin panel, never rewrites funded-deal economics.
- Pending-ruling treatment after revocation: a ruling whose approval set includes a signer revoked before queueing is invalid at queue time. A ruling already validly queued before revocation remains executable unless vetoed within its delay — revocation alone does not cancel it (prevents griefing a valid award by rotating keys during delay). New queues after revocation must use the post-rotation epoch; `Ruling` includes `authorizationEpoch` and queue validation checks epoch currency.
- Governance that can instantly replace quorum = arbitration authority and requires the same quorum + delay as a ruling. No emergency bypass.

Gate: approve cancel-only veto + epoch rule + 72h rotation delay, or supply stricter alternates.

## P-08 (RB-05b) Post-escape voluntary exits and precedence — PROPOSED

Locked: `escapeAt = disputeOpenedAt + 5,184,000`, never adjusted. `executeRuling` / `queueRuling` prohibited at/after `escapeAt`.

- T23 (catastrophicEscape) eligible only for properly escalated, unsettled disputes (EVIDENCE / PRIMARY / FALLBACK / RULING_PENDING / DEADLOCK). Un-escalated lapsed disputes never become escape-eligible through inactivity.
- After `escapeAt` but before T23 executes: T05/T06/T07 (release/refund/mutual settlement) REMAIN available; T17/T18/T21 (queue/execute rulings) are prohibited; T19/T20 vetoes are moot (no executable award remains, pending award bypassed by T23).
- Rationale: preserves exits without creating a post-cutoff arbitration route. Matches the original plan's "mutual settlement until escape execution" precedent.
- Precedence table addition: SETTLED (any path) > everything; `escapeAt` reached blocks rulings; T23 bypasses pending award; voluntary T05–T07 before T23 preempt T23.

Gate: approve continued voluntary exits post-cutoff. Alternative (freeze all exits after cutoff until T23) rejected as trapping cooperative parties.

## P-09 (RB-01) Outage protection requirements (Phase 1 rules; algorithm in Phase 2) — PROPOSED

Contract-critical requirements the Phase 2 algorithm must satisfy:

1. Protected rights (same adjusted deadline for both sides): `openDispute`, `markDelivered`, `escalate`, `postRespondentBond`, `submitEvidenceCommitment`, `finalizeAfterTimeout`, `refundForNonDelivery`. Both admission (`openDispute`) and timeout (`finalizeAfterTimeout`) MUST use the same `effectiveInspectionDeadline`.
2. Adjustable clocks: `effectiveDeliveryDeadline`, `effectiveInspectionDeadline`, `effectiveSelfResolutionEnd`, `effectiveEscalationEnd`, `effectiveEvidenceEnd`, `effectivePrimaryEnd`, `effectiveFallbackEnd`. Adjustment = sum of verified outage intervals intersecting `[anchor, originalDeadline + grace]` per deal. Source: Chainlink Base sequencer uptime feed (primary) + L1-batch staleness check (secondary, Phase 2 to define). Post-recovery grace 30 min before deadlines resume.
3. Non-adjustable: `escapeAt` (fixed 60 days from `disputeOpenedAt`). Long-outage conflict rule: if accumulated outage would push `effectiveEscalationEnd` to within 7 days of `escapeAt`, escalation remains permitted but any queued ruling must still satisfy `executeAt < escapeAt`; if it cannot, the deal proceeds to DEADLOCK → T23. No silent escape extension, no indefinite rights suspension.
4. Dependency failures: stale/invalid feed, delayed status updates, multiple outages, unavailable oracle → fail-closed for timeouts (timeout settlement blocked while outage status is unknown/stale), fail-open for dispute admission (buyer may still `openDispute` by original deadline even if feed is down; adjustment applied retroactively once feed recovers). Already-allocated claims never require a healthy feed.
5. No admin deadline extension: only the deterministic feed-derived adjustment may move a deadline; no role may extend individual deals.

Phase 2 must prototype this against Base fork scenarios (timely dispute vs timeout race, delivery/escalation during outage, multiple outages, delayed feed updates, recovery grace) and return measured gas + historical-coverage limits (how far back the contract can verify outage intervals without unbounded storage).

Gate: approve protected/adjustable/fixed sets + conflict rule. Phase 2 fills the exact derivation pseudocode + feed addresses.

## P-10 (RB-07a) Duration bounds — PROPOSED

- `deliveryPeriodSeconds`: 1h – 30 days.
- `inspectionPeriodSeconds`: category minimum (see P-12) – 14 days.
- Combined pricing duration = delivery + inspection (existing tiers). Disputes/outages/claims may keep value locked longer; "exposure" label renamed to "agreed delivery plus inspection duration used for pricing" in UX (per audit §14).
- Unlimited value does NOT imply unlimited duration. Funding validates bounds via `categoryPolicyId`; UI defaults alone are insufficient.

Gate: approve 1h–30d / min–14d or supply alternates.

## P-11 (RB-07b) Expiring readiness + confirmation policy — PROPOSED

- Readiness required iff pricing tier is ≤3h (i.e. `delivery+inspection ≤ 10,800s`, effectively instant-code deals). `readinessPolicyId` for other categories = registered no-readiness policy; `readinessConsentHash = 0` allowed only then.
- Short-deal readiness: buyer attestation (availability for inspection within 3h of delivery) signed ≤2h before funding; funding rejects expired consent. No funded waiting-for-readiness state. Maximum delivery interval for short deals: 24h.
- Confirmation display: track `l2-included / safe / finalized` (Base: preconfirmation → L2 inclusion → batch inclusion → L1 finality). Funding considered usable after L2 inclusion; irreversible off-chain shipment (seller ships game item/account transfer) recommended only after `safe` (or batch inclusion). Exact block thresholds defined in Phase 6 indexer spec; UX copy fixed here.

Gate: approve 2h readiness expiry + safe-before-ship guidance.

## P-12 (RB-07c/RB-08a) Category minimums, completion criteria, evidence standards — PROPOSED (confirm existing minimums as locked)

| Category | Min inspection | Completion criteria (seller `MarkDelivered` commitment) | Evidence minimum |
|---|---|---|---|
| INSTANT_CODE | 1h | Code/key delivered via designated non-chat channel; delivery manifest hash commits to redemption method + obscured identifier (last 4 only, never full secret in commitment/preview) | Delivery commitment at declaration; buyer screenshot/recording on dispute |
| GAME_ITEM | 12h | Item transfer to designated recipient ID; trade-ID / screenshot hash | Transfer record + ownership screenshot |
| GAME_CURRENCY | 12h | Amount + recipient ID + transaction/record ID | Same as item |
| DIGITAL_GOOD | 12h | File/delivery + version hash | Original-byte hash at declaration |
| SERVICE | 12h | Milestone description + completion attestation | Work product hash / completion record |
| GAME_ACCOUNT | 24h (recommended 72h) | Account identifier (non-secret), transfer of credentials via approved out-of-band method (never platform chat/evidence), post-settlement account-report handling per category policy | Transfer record; no post-settlement warranty; post-sale account recovery by seller treated as new dispute only if within inspection, otherwise support report |

Cross-category rules (locked):

- Seller `markDelivered` commits a delivery evidence hash at declaration time (closes the pre-dispute anchor gap). Hash ≠ proof of truth; category burden-of-proof standards live in the evidence policy and reviewer runbooks (Phase 9).
- No credential storage: passwords, keys, recovery phrases, full secret codes MUST NOT enter platform chat, support tickets, evidence previews, or on-chain commitments. Upload validation warns + blocks known secret patterns; originals preserved separately from scanned/redacted derivatives.
- Respondent submission: seller MAY contest (post bond + submit before evidence cutoff); silence = no default loss, review proceeds. Claimant MUST have bond posted (escalation) and MAY submit; empty claimant evidence does not halt the clock.
- Retention: encrypted originals 2 years post-settlement, manifests/proofs 5 years; deletion only by dual authorization (ops + arbitration lead); restore drill in Phase 8 must recover files + keys.
- Post-settlement game-account reports: support channel only, no warranty, no reopening; documented in agreement summary.

Gate: approve table + cross-category rules, or amend per-category minimums (any reduction must be justified; increases allowed via category policy without contract change).

## P-13 (RB-08b) Evidence cutoff, access, recovery — PROPOSED

- Cutoff: `effectiveEvidenceEnd = escalatedAt + 24h` (lock the proposed value). Late submissions rejected by contract manifest rule; reviewers cannot consider off-manifest files.
- Append-only manifest: `(deal, uploader, seq, prevCommitment, fileHashes[], metadataCommitment)` signed per submission (EIP-712 `EvidenceManifest`). User-verifiable content hash + signed receipt at upload.
- Access: bound participants + assigned reviewers (least privilege) + explicitly authorized support with audit. Invitation token ≠ authorization.
- Backup: encrypted S3-compatible, versioned, separate KMS keys per environment; key-recovery shares held by ops + arbitration leads independently. Restore test must recover both ciphertext and keys (Phase 8 gate).

## P-14 (RB-09) Subsidy budget, admission capacity, confirmation — PROPOSED (interim launch values; tracked in Phase 13)

- Subsidy reality: full buyer win with buyer-only bond = zero fee + bond refund → review cost is subsidized. Same for lapsed/abandoned review overhead, sponsorship gas, storage.
- Interim budget: $2,500/month total subsidy pool (reviewer minutes + sponsorship + storage), reviewed monthly. Metrics tracked from day 1: dispute rate, minutes/case, unavailable respondent bonds, sponsorship/dispute, claim failures, reconciliation breaks.
- Admission: `FundingAdmission` signature required for ALL deals at launch (expiring, 24h, contract-validated). Admission signer (risk role) can deny new funding but cannot settle/redirect. Admission checks: (a) principal within active reviewer-capacity window (initial: max 5 concurrent escalated cases per reviewer pod, max 20 concurrent protocol-wide; new funding paused beyond that); (b) aggregate exposure per buyer/seller pair per 24h ≤ $10,000 until history exists; (c) category allowlist (all six V1 categories admitted). Pause (`pauseNewFunding`) blocks stale admissions while paused.
- No retroactive bond increases, no silent principal caps. Rollout pace governed by admission + pause, preserving the no-ceiling decision.
- Capacity expansion criteria (Phase 13): dispute rate <5%, reviewer p95 turnaround <5 days, sponsorship within budget, zero reconciliation breaks over 30 days → raise concurrency/exposure limits via new admission policy registration (never by editing funded deals).

Gate: approve interim $2,500 pool + admission-required-at-launch + initial concurrency/exposure caps, or supply alternates with explicit numbers. An unbounded-subsidy launch is not approved.

## P-15 Operational responsibility matrix — PROPOSED

| Responsibility | Owner | Notes |
|---|---|---|
| Policy register + readiness gates | Release leadership | Sole approver of P-01..P-14 changes |
| Financial invariants, signing, token integration | Contract/security engineering | Owns Phases 2/4/5 + fork tests |
| Projection, relaying, storage, restores | Backend/platform engineering | Owns indexer, workers, backups; RPO ≤15min for private metadata, RTO ≤4h (Phase 6/10 to verify) |
| Agreement clarity, exercise of rights | Frontend/product | Readable summaries, fee/effective-% display, exhaustion warnings |
| Reviewer independence, standards, coverage, subsidy tracking | Arbitration operations | Staffs primary + fallback pods disjointly; owns runbooks |
| Pause/unpause, admission signer custody | Governance (timelocked) | Funding-only pause; 72h rotation/recovery delay; no funded-deal rewrite |

Primary/fallback reviewer coverage must be independently staffed and keyed from day 1 (separate wallets, devices, on-call rotations). Single-person coverage of both panels is prohibited.

## P-16 Phase 2 experiment bounds (what stays open AFTER Phase 1 approval)

- RB-06 custody (hub vs clones), domain/custody addresses, EIP-3009 vs approve/transferFrom binding, wallet matrix — bounded prototype, decision recorded in architecture decision record before Phase 4.
- RB-01 algorithm pseudocode + gas/history measurements — must satisfy P-09 requirements above.
- RB-06 fork verification of `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` capabilities, authorization consumption, transfer-failure modes.
- Nothing else may remain open. Fee, bond, quorum, delay, veto, duration, readiness, retention, subsidy numbers above become immutable per funded deal once registered.

---

## Approval block

- [x] Approve P-01 through P-15 as written (approved 2026-10-03).
- [x] Confirm P-16 is the complete list of permitted Phase 2 experiments.
- [x] Authorize updating `state-transitions.md`, `financial-ledger.md`, `signed-policy.md`, `contract-spec.json` to match in one consistent edit + re-run `validate-spec.mjs`.
- [x] Phase 1 gate met: every financial outcome and operational requirement has an explicit rule except bounded P-16 experiments. No hidden later fee, bond, or quorum changes may affect funded deals.

Approver: user approval via review session  Date: 2026-10-03
