# Midman V1 plan audit

Reviewed: 3 October 2026. Scope: all 86 sections of the supplied product, architecture, and security plan. This is a design review; there is no contract implementation or deployed system in scope.

The plan is a sound product direction, but it is not yet an implementation-complete financial specification. Keep the single chain and asset, signed terms, atomic funding, fixed recipients, pull claims, permissionless exits, and versioned contracts. The important work is to close the financial and timing gaps before Solidity development.

The recommendations below are proposals. In particular, changing bond collateral, fee collection in very small partial awards, or the catastrophic settlement policy needs an explicit amendment to the consolidated requirements.

## 1. Blocking financial issue: a possible payout is not bond collateral

Relevant sections: 8, 34–38, 43, 83.

Consider a 100 USDC principal with a 0.50 USDC buyer-paid fee. The contract holds 100.50 USDC. The buyer reserves a 5 USDC bond from a possible refund, then loses completely. The existing rules promise the seller 100 USDC, the platform its 0.50 USDC normal fee, and retention of the buyer's 5 USDC bond. That requires 105.50 USDC, although only 100.50 USDC was deposited. The losing buyer's hypothetical refund has become zero.

The seller has the same problem when losing completely. Two parties also cannot reserve two independent bonds against the same principal and treat both as additional funded assets.

**Recommended amendment:** bonds must be backed by separately deposited USDC or an already vested, unencumbered claimable balance belonging to the party. Reserving an existing balance transfers the liability into a bond bucket; it does not create another liability. Keep the initial dispute freeze free of an arbitration bond.

If avoiding additional deposits is essential, choose a different economic rule: arbitration costs come from an actual award, an upfront collateral deposit, or a platform subsidy. A deduction from an award cannot also guarantee collecting a bond from a party awarded zero.

The respondent may remain optional, but a non-participant has posted no forfeitable bond. Define who funds review when the claimant wins and receives its bond back while the respondent never posted one. Fees alone do not resolve that branch.

Acceptance criterion: every outcome conserves actual deposits, including both bonds, with no negative entitlement or double reservation.

## 2. Blocking financial issue: partial awards can be smaller than the seller's fee share

Relevant sections: 6–8, 32, 38, 43, 49, 68.

For a 5 USDC deal with the seller paying the 0.50 USDC fee, a ruling awarding the seller 0.10 USDC produces a negative 0.40 USDC seller payout under a literal deduction of the original fee. Clamping that payout to zero while still refunding 4.90 USDC and collecting 0.50 USDC requires 5.40 USDC from a 5 USDC deposit.

Define the fee result for every path: voluntary refund, pre-delivery cancellation, full seller release, full buyer ruling, partial ruling, mutual settlement, dispute lapse, and catastrophic escape. Separate `quotedPlatformFee` from `earnedPlatformFee`.

**Recommended amendment:** keep the fee quote based on the original principal, but introduce a deterministic collection cap when the seller award cannot cover its agreed contribution. Disclose that cap in the signed policy. Arbitrators choose the principal award; they do not negotiate fees.

A concrete candidate rule, before bond allocations, is:

```text
P = principal
F = quoted fee
A = seller gross principal award, between 0 and P
B = buyer's originally funded fee contribution
D = P + B

If A == 0:
    buyerClaim = D
    sellerClaim = 0
    earnedFee = 0

If A > 0:
    buyer-pays:  earnedFee = F
    seller-pays: earnedFee = min(F, A)
    split:       earnedFee = min(F, 2 * A)

    buyer-pays:  buyerFeeCharged = earnedFee; sellerFeeCharged = 0
    seller-pays: buyerFeeCharged = 0; sellerFeeCharged = earnedFee
    split:       sellerFeeCharged = floor(earnedFee / 2)
                 buyerFeeCharged = earnedFee - sellerFeeCharged

    sellerClaim = A - sellerFeeCharged
    buyerClaim = P - A + B - buyerFeeCharged
```

This preserves the quoted rates and normal outcomes, and keeps a 50/50 fee split within one smallest token unit. It changes the requirement to collect the entire original fee in every partial outcome. Alternatively, separately collateralize the seller's fee or impose a disclosed minimum nonzero seller award; those introduce other tradeoffs.

Use integer token units and a fixed rounding rule. For an odd split fee, assign the extra smallest unit consistently. Use full-precision multiplication/division and avoid JavaScript floating-point amounts.

## 3. Freeze funds before requesting evidence uploads

Relevant sections: 26–30, 54–56, 76.

The proposed UX uploads evidence before freezing funds. A slow upload, scanner, API outage, session problem, or relayer delay can consume the remaining inspection window.

**Recommended amendment:** the first dispute action submits the smallest authenticated on-chain freeze transaction. A reason code or optional commitment can accompany it. Evidence upload follows during the fixed evidence period and must not gate the freeze. Show a transaction as pending until successful inclusion; a click or wallet signature has not yet frozen funds.

Incorporate duplicate submissions, wallet rejection, replacement transactions, reorgs, and retries into the UX. Describe the freeze as having no arbitration bond; a direct fallback transaction still needs network gas.

## 4. Signed drafts need revocation and complete commitments

Relevant sections: 9–13, 22, 32, 49–50, 71.

Deleting a draft in PostgreSQL does not invalidate an existing EIP-712 signature. A buyer or relayer holding both signatures may still fund a seller-cancelled deal before expiry. Changing a payout address requires new signatures and invalidation of the old executable authorization.

**Recommended amendment:** provide contract-enforced cancellation/invalidation after executable signatures have been issued, plus short funding expirations. Drafting can remain off-chain; revoking an issued authorization may require a transaction. "Free cancellation" should specify that no platform fee applies, rather than implying no possible gas cost.

Commit the complete agreement: full description and conditions hash, exact fee amounts and allocation, buyer refund recipient, delivery recipient details, category-policy version, arbitration-policy hash, bond rules, quorum tiers, ruling delays, fallback rules, and outage rules. Freeze economic requirements for funded deals. Recoverable signer membership can follow an explicitly governed recovery policy without lowering the funded deal's quorum or rewriting its economics.

All later signed actions need their own action type, deal identifier, nonce, expiry, and exact authorized payload. A mutual settlement signature must commit to the actual payout amounts and applicable bond handling. Consume authorizations atomically, and reject obsolete settlement offers after the relevant state or nonce changes. [EIP-712 explicitly leaves replay and front-running protection to the application.](https://eips.ethereum.org/EIPS/eip-712)

Avoid a circular identifier definition: if `dealId` is inside the terms being hashed, it cannot also be defined from that same complete hash. Use an independently generated random identifier inside the signed terms, or derive the identifier from a struct that excludes the identifier.

Before final signatures, let the creator confirm the intended counterparty or bind the invitation to an intended wallet. A leaked invitation should not let the first unrelated accepter permanently occupy the buyer slot.

## 5. Dispute liveness needs hard clocks and a one-dispute rule

Relevant sections: 14–17, 29–44, 83.

"Original contractual outcome resumes" is ambiguous. Does the old inspection deadline apply, is the remaining time restored, or can the buyer open another free dispute? Restoring a disputable state without a limit can permit repeated freezes. A seven-day review target is also not a contract deadline, and "evidence complete" cannot depend indefinitely on an operator.

**Recommended amendment:** use absolute deadlines measured from recorded events, with permissionless progression:

| Event | Required rule |
|---|---|
| Funding | Record funding time and derive delivery deadline |
| Delivery declaration | Record delivery time and derive inspection deadline |
| Initial dispute | Record immutable dispute-open time; permit one unilateral initial dispute per deal |
| Negotiation | Ends 24 hours after dispute opening |
| Claimant escalation | Must occur before 48 hours after dispute opening |
| Escalation lapse | Anyone can settle to the specified contractual seller outcome; prohibit another initial freeze |
| Respondent evidence | Fixed cutoff, such as 24 hours after escalation |
| Primary review | Fixed decision deadline derived from the evidence cutoff |
| Fallback review | Fixed deadline and permissionless activation |
| Pending ruling | Fixed execution time, ruling identifier, and constrained veto path |
| Catastrophic escape | Absolute eligibility tied to the original dispute-open time |

For the proposed lapse rule, a dispute opened early would result in seller settlement at the escalation deadline even if the original inspection period had time remaining. That consequence needs explicit disclosure; alternatively, define a one-use freeze with a different resumed inspection policy. The plan must choose one.

A seller must not restart the inspection clock with another delivery declaration. Define strict boundary comparisons for every deadline. A veto, reviewer replacement, evidence addition, or late ruling must not reset the original 60-day escape clock. Define which action wins at the escape boundary and the latest time a ruling can be queued while still completing its delay.

Also define bond handling when a buyer releases or a seller refunds during review. Such actions may benefit the counterparty's principal while affecting already posted bonds and arbitration costs.

## 6. Outage protection must preserve the ability to dispute

Relevant sections: 16–19, 30, 36, 43, 66–67.

Blocking timeout settlement during recovery is insufficient if `openDispute()` still rejects the original expired deadline. Buyer and seller actions must use the same adjusted deadline policy. Protect delivery declarations and escalation/evidence windows as well as buyer inspection when their rights depend on chain availability.

Chainlink documents a Base sequencer uptime feed and a post-recovery grace pattern. Its current-status example is not a complete escrow deadline-extension algorithm. A latest feed round does not by itself supply a complete ledger of every outage intersecting each deal. [Chainlink documentation.](https://docs.chain.link/data-feeds/l2-sequencer-feeds)

**Recommended amendment:** specify the oracle/feed dependency, relevant outage interval, adjusted deadline calculation, historical coverage needed, delayed updates, multiple outages, unavailable or invalid feed responses, and recovery behavior. Preserve already allocated claims without requiring a healthy uptime feed. Resolve the tension between deadline extensions and the 60-day catastrophic clock explicitly.

Do not add a general administrator ability to extend every deal indefinitely. Test the actual Base recovery assumptions, including status-update ordering.

## 7. The 50/50 escape is an economic tradeoff

Relevant sections: 39–44, 81.

If a seller delivered nothing, a 50/50 escape may reward that seller during failed arbitration. If the buyer already received everything, the same escape may reward the buyer. An adversary benefits from arbitration failure whenever the default split improves its expected award. Separate keys alone do not establish operational independence.

**Recommended amendment:** if keeping the locked 50/50 rule, make it a prominent signed acceptance term, define platform-fee handling, and require separate operational recovery capacity. A reasonable proposed fee treatment is to waive the normal fee and return funded buyer fee contributions because arbitration failed; this is currently unspecified.

The 60-day path is an exit after prolonged failure, not proof that its outcome is fair. There is no automatic universally correct fallback for unverifiable off-chain delivery. Changing this default is a product/economic decision, not a routine implementation correction.

## 8. High-value protection must be operative in V1

Relevant sections: 4, 34, 39–40, 59–62, 70–71, 80.

Unlimited transaction values conflict with deferring stronger bond and authorization policies to a future direction. Thresholds, quorums, delay lengths, risk admission rules, and staffing coverage must be specified before unrestricted funding.

**Recommended amendment:** preserve no user-facing amount ceiling, but make the stated stronger controls mandatory in V1. Enforce financial authorization tiers in the contract. If manual review or account checks are mandatory admission requirements, bind them to a contract-validated funding approval; frontend checks alone can be bypassed by direct contract calls. Admission controls must not censor rights on an already funded deal.

Consider 2-of-3 approval for all human rulings as a simpler default, with longer delays for larger awards. Assess aggregate exposure and deal splitting: many individually small awards can create a large compromise loss. Distinct keys must represent independently secured approval paths. Governance that can immediately replace the quorum is effectively arbitration authority and needs comparable protection.

Email/passkey/TOTP checks protect application access. They do not automatically constrain actions signed by a compromised blockchain wallet. Account recovery must not silently replace the wallets of funded deals.

## 9. Gasless funding needs an atomic authorization design

Relevant sections: 12–13, 51–57.

Circle currently lists native Base USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Pin the address in the contract and deployment manifest. [Circle's official address list.](https://developers.circle.com/stablecoins/usdc-contract-addresses)

**Recommended amendment:** if the deployed token supports the chosen EIP-3009 route, receive authorized funds inside the atomic deal-funding call, validating payer, recipient, amount, validity interval, and a payment nonce bound to the intended deal. Do not let one payment authorization fund a different signed deal merely because its amount matches. Check exact deployed capabilities in fork tests.

EIP-3009's `receiveWithAuthorization` restricts consumption to the payee, specifically to address front-running concerns. A freely consumable token transfer authorization can otherwise be used outside the application's intended funding wrapper. [EIP-3009 specification.](https://eips.ethereum.org/EIPS/eip-3009)

EIP-1271 support for escrow signatures does not establish support for every token authorization method. Publish and test a wallet capability matrix, including an approve/transferFrom fallback where required. Contract signature validity can be state-dependent, so validate at execution. [EIP-1271 specification.](https://eips.ethereum.org/EIPS/eip-1271)

A tiny ETH reserve is a useful mitigation, not assured emergency capacity: gas varies and users can spend it. Add independently operated submission routes, fee estimation and alerts, capped sponsorship budgets, and emergency transaction data. Critical actions should be relayable by third parties without giving them discretion over recipients or awards.

## 10. Hashes establish commitments, not truth or availability

Relevant sections: 22–27, 37, 41, 65.

A delivery event proves that a seller declared delivery. It does not prove delivery of a game item. Screenshots, recordings, and signed statements can remain false. The evidence hierarchy needs category-specific burden-of-proof and decision standards.

Anchoring evidence only once a dispute begins leaves a gap before the first anchor. A compromised operator can substitute unanchored records, omit files, or delete originals. Hashes cannot reconstruct a missing file.

**Recommended amendment:** generate user-verifiable content hashes and signed evidence receipts at submission. Commit delivery evidence when the delivery declaration is submitted, and use append-only dispute manifests with author, deal, sequence, and prior commitment. Give users original-file exports and inclusion proofs. Define access permissions, encrypted backups, independent recovery access, retention, and unavailable-evidence rules.

Preserve original bytes and hashes before generating scanned/redacted derivatives. Avoid placing credentials or secret codes in public commitments or previews. Define safe external delivery procedures and category acceptance criteria before admitting that category.

## 11. Rebuild financial projections; separately back up private records

Relevant sections: 26–27, 56, 65–66, 73–74.

The chain can reconstruct financial state, but not email accounts, off-chain terms text, chat, evidence originals, invitations, or encryption keys. A hash on-chain is not a backup of those records.

**Recommended amendment:** distinguish reconstructable chain projections from backed-up private metadata. Specify recovery point/time targets, restore exercises, object versioning, encryption-key recovery, durable audit logs, and access to signed agreement copies.

Supply a downloadable deal recovery package with signed terms, chain/contract identifiers, ABI/version, relevant transaction hashes, and emergency call data. Maintain an emergency interface that can operate independently of the primary API and indexer.

For the indexer, record contract address, block hash/number, transaction hash, and log index; replay from a verified deployment block; roll back orphaned events; and reconcile liabilities independently of the database. Define the exact funding confirmation level that permits irreversible delivery. Base distinguishes preconfirmation, L2 inclusion, batch inclusion, and finality; avoid an undefined "confirmed" status. [Base finality documentation.](https://docs.base.org/specifications/transactions/transaction-finality)

## 12. Pull claims isolate recipient failure, not token-wide failure

Relevant sections: 2, 51–53, 58, 68–69.

The pull model is appropriate: a recipient failure must leave its liability intact and not prevent other entitlements being allocated. However, Circle's token code includes pause and blacklist checks on transfers. Blacklisting the escrow contract or pausing the token can affect all outgoing claims. Immutability of Midman's contract does not remove external token control. [Circle's token implementation.](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/FiatTokenV1.sol)

**Recommended amendment:** state that allocation can remain enforceable while token transfer is unavailable. Include token-wide freeze, token upgrades, and issuer intervention in the dependency model and incident runbooks. Keep V1's fixed-recipient rule; do not add an administrator redirection escape as a quick workaround.

Track disjoint liabilities: active escrow deposits including refundable buyer fee contributions, actually collateralized bonds, user claims, and earned platform/arbitration claims. Do not count a platform fee twice because it is represented in two aggregates. The rescue bound is the token balance minus all outstanding accounted liabilities. Failed claims preserve their liabilities, and settling moves liabilities between buckets without creating value.

The proposed emergency pause blocks new funding. An immutable contract with that pause cannot necessarily stop exploitation of a defective existing exit function. Document that incident-response limitation and test the permitted actions individually.

## 13. Private invitations and public-chain privacy are different

Relevant sections: 10–11, 26–27, 60, 63–64.

Long random URLs prevent easy enumeration. They are bearer secrets and can leak through link previews, analytics, application logs, browser history, or referrers. They do not hide wallet addresses, amounts, and financial events already published on-chain.

**Recommended amendment:** set an explicit token entropy requirement, hash stored invitation tokens, redact them from logs and monitoring, suppress sensitive previews, use no-referrer/no-store/noindex policies, and authenticate access to evidence. After acceptance, restrict sensitive records to the bound participants and authorized reviewers. Rotating an invitation must not mutate the signed agreement.

Use authenticated wallet sign-in with domain, chain, challenge nonce, and expiry. Keep login signatures distinct from financial authorizations. Treat anti-Sybil signals as evidence with measured false positives. Transaction count and volume need wash-trade resistance before being marketed as trust indicators.

## 14. Short-window readiness must have a defined lifetime

Relevant sections: 16–19, 54–56, 82.

With the locked category minimums, the <=3-hour tier primarily fits instant codes; 12-hour inspection categories cannot qualify. A readiness click hours earlier does not ensure the buyer is awake when delivery is declared.

**Recommended amendment:** require fresh, expiring readiness consent before short-deal funding, define any scheduled start and maximum delivery interval, and state the availability obligation. Do not introduce an unbounded funded waiting-for-readiness state. Do not require a new buyer acknowledgment of every delivery declaration if that lets a buyer who received goods prevent the seller declaring delivery indefinitely.

Enforce category minimums through contract-validated policy, rather than UI defaults alone. Add reasonable delivery/inspection duration bounds for V1; unlimited value does not require unlimited duration.

Rename "maximum escrow exposure" to "agreed delivery plus inspection duration used for pricing." Disputes, outages, and unclaimed entitlements can keep value in the contract longer. Display the actual fee and effective percentage: 0.50 USDC on a 5 USDC principal is 10%, even when the underlying schedule rate is 0.25%.

## 15. Arbitration capacity and security must be designed earlier

Relevant sections: 5, 34–38, 41–42, 59–74, 80.

The platform may earn zero normal fee when a buyer wins, refund the claimant bond, and receive no respondent bond. Human review then has no case-level revenue. A 0.50 USDC fee also has to help cover infrastructure, sponsorship, storage, support, and abuse. This is a budget gap to measure; it is not proof the current prices cannot work.

**Recommended amendment:** model trade volume, dispute frequency, minutes per case, unavailable respondent bonds, primary/fallback staffing, sponsorship abuse, security costs, and margin. Keep the locked fee schedule unless the resulting budget justifies a separately reviewed change. Identify an explicit subsidy budget where required.

Move wallet authentication, action authorization, evidence validation, key management, recovery, and monitoring into the first working vertical slice. They are dependencies of the escrow flow, not a phase-ten add-on. Resolve gasless funding and outage semantics before finalizing the contract interface.

The Next.js/NestJS/Fastify stack is reasonable. Start with a modular backend and separately permissioned workers; service proliferation adds little safety by itself. Keep evidence anchoring and relaying as transaction-submission paths, and the indexer as a read/projection path.

## 16. Turn the launch sequence into objective release gates

Relevant sections: 14–15, 68–73, 80.

Simplify overlapping financial states. Atomic funding can begin in `AWAITING_DELIVERY`; deadline eligibility can be derived rather than requiring a keeper to create `REFUNDABLE`. Keep terminal settlement separate from independent claim balances. A recipient that never claims should not prevent a deal becoming financially settled.

Before an unrestricted mainnet launch, require:

- Complete state-transition and principal/fee/bond outcome tables, including missed deadlines, vetoes, and cancellation during review.
- Tested conservation of all token liabilities, not just distributed principal.
- Boundary and sequence tests across all fee allocations, minimum principal, tiny awards, odd smallest-unit amounts, real bond reservations, signature revocation, repeated disputes, stale settlement offers, and competing terminal actions.
- Fork integration against the pinned USDC deployment, with simulated recipient/token-wide failures and the supported wallet methods.
- Outage/recovery tests where both dispute admission and timeout settlement use the same rule, plus tests of unavailable dependencies.
- Primary and fallback staffing coverage, independently secured keys, recovery drills, and tested alert delivery.
- Database/object/key restore drills and an independently usable emergency interface.
- External contract review with material findings resolved and the deployed bytecode matched to the reviewed release.
- A staged invitation rollout before unrestricted onboarding, while preserving the decision to avoid a permanent user-facing value ceiling.

The next design artifact should combine the proposed state-transition table with the financial outcome table and the signed-policy schema. A state table alone will not fix insolvency or unspecified fees.
