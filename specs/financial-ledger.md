# Midman V1 principal, fee and bond ledger specification

Version: 0.2.0-phase1-approved. Status: **Phase 1 approved; Phase 2 bounded experiments only (outage algorithm, custody/payment binding)**. Read with [state-transitions.md](state-transitions.md), [signed-policy.md](signed-policy.md), the canonical [contract-spec.json](contract-spec.json), and the approved [policy-register.md](policy-register.md).

## 1. Amounts, fees and signed inputs

All monetary values are nonnegative integer USDC smallest units. V1's 5 USDC minimum is `5,000,000` units; the 0.50 USDC minimum quote is `500,000` units. Verify the pinned token's decimals/capabilities before deployment, RB-06. Use full-precision integer multiplication/division; never floating-point monetary arithmetic.

| Symbol | Meaning |
|---|---|
| `P` | Principal; immutable after funding |
| `F` | Original quoted platform fee; immutable after funding |
| `b` | Buyer fee allocation in basis points; exactly 0, 5,000 or 10,000 |
| `B0` | Originally prepaid buyer fee contribution |
| `D` | Amount collected for this escrow, excluding independent bonds |
| `S` | Principal awarded to the seller, before seller fee deduction |
| `E` | Platform fee actually earned for a normal settlement |
| `Qb`, `Qs` | Actual collateralized buyer and seller bonds |
| `Cb`, `Cs` | Bond costs retained under the signed bond policy |

For every funded normal deal:

```text
P >= 5,000,000
500,000 <= F <= P
b in {0, 5,000, 10,000}
B0 = floor(F * b / 10,000)
originalSellerFeeShare = F - B0
D = P + B0
```

The fee schedule remains based on signed delivery plus inspection duration:

| Duration, in seconds | Rate in basis points |
|---|---:|
| `duration <= 10,800` | 25 |
| `10,800 < duration < 86,400` | 50 |
| `86,400 <= duration <= 259,200` | 70 |
| `259,200 < duration <= 604,800` | 100 |
| `duration > 604,800` | 200 |

`F = max(500,000, ceil(P * rateBps / 10,000))` per approved P-01. The accepted amendment explicitly fixes rounding of the **actual** fee and buyer share to floor. Quotation rounding is now locked to CEIL.

The 0.50 USDC minimum applies to the quote. Partial settlements may collect less. Gas/sponsorship charges, if any, must be separately disclosed and authorized; none may be silently deducted from these principal, fee or bond identities.

## 2. Ledger rules

### L-NONE — no liability mutation

Delivery declarations, freezes, review progression, evidence commitments, ruling queues and vetoes alter state or commitments, but allocate no principal or platform fee. A queued ruling is not an earned fee or a user claim. Revoke an unfunded terms authorization without creating a funded liability.

### L-FUND — atomic creation and funding

Receive exactly `D=P+B0` from the buyer, create an active escrow liability of `D`, and consume the identified terms/payment authorizations in the same transaction. A failed signature, policy validation, transfer or initialization reverts everything. No partial funding, top-up, changed principal, or direct-transfer credit exists in V1.

### L-BOND — separate, real collateral

A party posts the exact requirement determined by its funded deal's signed bond policy. The claimant must post before arbitration starts; the respondent may remain unbonded. An unposted bond is zero, never a receivable from hypothetical future winnings.

With fresh tokens, contract assets and the party's bond liability increase by the same amount. With an existing vested, unencumbered claim balance, that balance decreases and the bond bucket increases by the same amount; assets and total liabilities do not increase. Authenticate the balance owner's authorization. Claims from this unresolved dispute, active principal, and potential refunds are ineligible collateral.

Record the collateral amount, party and fixed bond-refund recipient. No requirement may grow after funding through a mutable global configuration. The minimum is 5 USDC per actively contesting party; larger requirements must be selected and signed before funding, RB-02/RB-03.

### L-NORMAL — proportional principal/fee settlement

Require `0 <= S <= P`, and compute once:

```text
E                  = floor(F * S / P)
actualBuyerFee     = floor(E * b / 10,000)
actualSellerFee    = E - actualBuyerFee
buyerFeeRefund    = B0 - actualBuyerFee

buyerPrincipalAndFeeClaim  = P - S + buyerFeeRefund
sellerPrincipalAndFeeClaim = S - actualSellerFee
platformFeeClaim          = E
```

Calculate `E` with full-precision `mulDiv(F,S,P)`, not `(S/P)*F`. Calculate the seller fee by subtraction. An odd smallest-unit fee remainder belongs to the seller fee contribution under the accepted buyer-floor rule; do not independently round both halves.

These identities prove nonnegative normal entitlements: `F<=P` implies `E<=S`; `E<=F` implies `actualBuyerFee<=B0`. Therefore both user claims and the unused buyer fee refund are nonnegative, and:

```text
buyerPrincipalAndFeeClaim
+ sellerPrincipalAndFeeClaim
+ platformFeeClaim
== D
```

When real bonds exist, independently require `0<=Cb<=Qb` and `0<=Cs<=Qs`:

```text
buyerBondRefundClaim  = Qb - Cb
sellerBondRefundClaim = Qs - Cs
arbitrationCostClaim  = Cb + Cs

all new claim liabilities == D + Qb + Qs
```

Principal/fee and bond refunds may have different fixed recipients. Do not conflate seller authorization wallet, principal payout wallet, and bond refund wallet. A per-party total is an accounting summary, not permission to redirect those component claims.

For an executed full buyer ruling, `Cb=0`, `Cs=Qs`; for an executed full seller ruling, `Cb=Qb`, `Cs=0`. A nonparticipant's bond is zero, so it yields no retained cost. Partial rulings use the approved proportional cost policy (P-03): `Cb = floor(Qb * S / P)`, `Cs = floor(Qs * (P - S) / P)`. Arbitrators choose only `S`; costs are derived and validated `0<=Cb<=Qb`, `0<=Cs<=Qs`.

Voluntary refunds, releases, and mutual settlements during review use the approved bond rule (P-04): unilateral T05/T06 refund both posted bonds in full (`Cb=Cs=0`); only bilateral T07 may select explicit bounded `Cb,Cs` with both signatures. A unilateral action may not make the decision for the other party's bond.

### L-CATASTROPHIC — explicit exceptional settlement

At an eligible 60-day escape, bypass L-NORMAL:

```text
buyerPrincipalShare + sellerPrincipalShare = P
buyerPrincipalShare = ceil(P/2) = (P+1)/2; sellerPrincipalShare = floor(P/2)   // approved P-02, deterministic

buyerPrincipalAndFeeClaim  = buyerPrincipalShare + B0
sellerPrincipalAndFeeClaim = sellerPrincipalShare
platformFeeClaim          = 0
buyerBondRefundClaim      = Qb
sellerBondRefundClaim     = Qs
arbitrationCostClaim      = 0

all new claim liabilities == D + Qb + Qs
```

The odd-unit recipient is locked to the buyer (P-02). This must be an immutable deterministic rule, not caller-selected. Pending rulings are invalidated and no normal or arbitration fee is accrued on this path. Refund all actually posted bonds; do not manufacture balances for nonparticipants.

### L-CLAIM — fixed-recipient transfer

Reduce only the requested claim liability and transfer exactly that amount to its predetermined recipient. Use checks-effects-interactions and reentrancy protection. Safe token transfer failure reverts the reduction, leaving the entitlement intact. A claim for one beneficiary must not attempt all other transfers as a prerequisite.

Token-wide pauses or escrow-address restrictions can still prevent withdrawal while preserving the liabilities. State settlement does not guarantee that tokens can physically move.

## 3. Outcome table

| Outcome | State rows | Rule / seller award | Fee | Bond result |
|---|---|---|---|---|
| No funding / signed-draft revocation | T02 | L-NONE | None | None |
| Atomic funding | T01 | L-FUND | Held as refundable contribution, not yet earned | None |
| Seller misses delivery declaration deadline | T04 | L-NORMAL, `S=0` | Zero; return all `B0` | None |
| Buyer approves, including early release | T05 | L-NORMAL, `S=P` | Full quote | Unilateral: refund both bonds in full (P-04) |
| Seller voluntarily refunds | T06 | L-NORMAL, `S=0` | Zero; return all `B0` | Unilateral: refund both bonds in full (P-04) |
| Mutually signed pre-delivery cancellation | T07 | L-NORMAL, `S=0` | Zero; return all `B0` | Explicit bounded Cb,Cs with both signatures (P-04) |
| Mutual full seller settlement | T07 | L-NORMAL, `S=P` | Full quote | Explicit bounded Cb,Cs with both signatures (P-04) |
| Mutual partial settlement | T07 | L-NORMAL, signed `S` | Proportional | Explicit bounded Cb,Cs with both signatures (P-04) |
| Inspection expires without live dispute | T08 | L-NORMAL, `S=P` | Full quote | None unless a policy permits a relevant prior bond, which V1 lapse does not |
| Claimant never escalates | T12, later T08 or voluntary exit | T12 is L-NONE; preserve inspection anchor; ordinary terminal rule when selected | Not earned at lapse itself | No claimant or respondent arbitration bond was posted |
| Full buyer arbitration win | T21 | L-NORMAL, `S=0` | Zero | Return claimant bond; retain posted losing respondent bond |
| Full seller arbitration win | T21 | L-NORMAL, `S=P` | Full quote | Retain buyer bond; return posted seller bond |
| Partial arbitration award | T21 | L-NORMAL, authorized `0<S<P` | Proportional | Proportional P-03: Cb=floor(Qb*S/P), Cs=floor(Qs*(P-S)/P) |
| Primary/fallback activation or veto | T15–T20, T22 | L-NONE | None accrued | Existing real collateral remains reserved |
| Catastrophic escape | T23 | L-CATASTROPHIC | Zero; return all `B0` | Return every posted bond |
| Claim | T24 | L-CLAIM | No new fee | No new allocation |

## 4. Worked examples

Buyer-paid fee, 100 USDC principal, 0.50 USDC quote, 70 USDC seller award: buyer receives 30.15, seller 70.00, platform 0.35; total is the 100.50 originally funded, before any independent bonds.

Seller-paid fee, 5 USDC principal, 0.50 USDC quote, 0.10 USDC seller award: buyer receives 4.90, seller 0.09, platform 0.01; total is 5.00.

Split fee with 100 USDC principal and a 0.500001 USDC quote: buyer prepays 0.250000; seller's original contribution is 0.250001. On a 50 USDC seller award, actual fee is 0.250000, each actual contribution is 0.125000, buyer receives 50.125000, seller 49.875000, and platform 0.250000. Total is 100.250000.

Full buyer win with buyer-only 5 USDC bond: return principal plus all prepaid buyer fee and return the 5 USDC bond; no arbitration cost claim exists. Midman subsidizes that review. Capacity/budget and collusion controls must operate on new funding, RB-09, rather than retroactively charging this winner.

## 5. Global solvency and rescue bounds

Maintain disjoint liability buckets:

```text
liabilities = activeEscrowDeposits
            + activeCollateralizedBonds
            + unclaimedUserEntitlements
            + unclaimedEarnedPlatformFees
            + unclaimedArbitrationCosts

tokenBalance >= liabilities
rescuableExcess = tokenBalance - liabilities
```

An active deposit includes the prepaid buyer fee. Before settlement it is not also an earned platform fee. At settlement move the full active deposit and bonds into terminal claim buckets; do not leave them in both places. If a claim aggregate includes platform claims, do not also add those fees separately in the solvency equation.

An unsolicited token transfer creates excess assets, not a credited deal. A rescue can withdraw only verified excess and cannot alter any liability. Existing claim collateralization merely moves a liability into bonds. A token-wide failure may preserve numerical solvency while preventing transfer availability.

For cloned vaults, these identities must hold per custody address as well as across the protocol. If bonds or fees are centralized, model those custody buckets explicitly; moving funds to a shared hub can reintroduce the shared freeze risk the vault design intended to reduce.

## 6. Verification boundary

[validate-spec.mjs](validate-spec.mjs) checks the accepted proportional fee identities, bond conservation, both candidate catastrophic dust choices, examples, fee-tier boundaries, specified ordinary timer boundaries, and document/manifest references. It exercises a model, not a deployed contract. Passing it does not verify an unspecified outage algorithm, reviewer governance, signature implementation, or real token integration. Those remain release blockers.
