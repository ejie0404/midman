# Midman V1 signed-policy schema

Version: 0.2.0-phase1-approved. Status: **Phase 1 approved 2026-10-03; see policy-register.md**. This schema supplies the commitments required by [state-transitions.md](state-transitions.md) and [financial-ledger.md](financial-ledger.md). [contract-spec.json](contract-spec.json) contains the ordered `DealTerms` field types. No deployment addresses are production defaults (bounded Phase 2 experiment RB-06).

## 1. Domain and agreement identity

```text
EIP712Domain:
    name              "MidmanEscrow"
    version           "1"
    chainId           actual pinned Base network identifier
    verifyingContract actual address executing agreement verification
```

The deployment manifest must resolve network and contract addresses, RB-06. Testnet and mainnet must have distinct domains and token addresses. Funding rejects an unexpected token rather than trusting the symbol `USDC`. Circle lists native Base USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; deployment and fork verification remain required. [Circle address list.](https://developers.circle.com/stablecoins/usdc-contract-addresses)

Use EIP-712 encoding and hashing through reviewed libraries; do not substitute ordinary JSON serialization or NIST SHA3 for Ethereum Keccak. Signatures alone do not supply replay protection: consumed authorizations, revocations and valid-state checks are application requirements. [EIP-712 specification.](https://eips.ethereum.org/EIPS/eip-712)

Generate `dealId` independently as a cryptographically random `bytes32`, and include it in the signed agreement. Do not derive it from a terms hash that itself includes the identifier. The separate random salt and nonce are signed. Store both the EIP-712 terms struct hash and the corresponding signature-domain identity as needed; refer to the exact EIP-712 agreement digest consistently across revocation, funding and action checks.

Both parties sign the same `DealTerms` digest after the intended participants, recipients and policies are known. A readable wallet/application summary shows principal, total funding, payout, clocks, fee formula, bond requirements, arbitration authority and catastrophic outcome. A description or policy hash by itself is not an adequate human-readable acceptance screen.

## 2. Ordered DealTerms schema

This table matches the manifest field order. Type names and order are part of the signing format.

| Field | Type | Requirement |
|---|---|---|
| `dealId` | bytes32 | Independent random identifier; one funded deal per authorization |
| `termsVersion` | uint32 | Canonical agreement-document format version |
| `buyerAddress` | address | Buyer signing/authorization wallet |
| `sellerAddress` | address | Seller signing/authorization wallet |
| `sellerPayoutAddress` | address | Fixed principal/fee payout destination |
| `buyerRefundAddress` | address | Fixed buyer principal/fee refund destination; V1 default equals buyer wallet |
| `buyerBondRefundAddress` | address | Fixed refund destination for buyer collateral; V1 default equals buyer wallet |
| `sellerBondRefundAddress` | address | Fixed refund destination for seller collateral; V1 default equals seller authorization wallet |
| `token` | address | Exact native USDC deployment, not a generic ERC-20 selection |
| `principal` | uint256 | `P`, at least 5 USDC in verified smallest units |
| `quotedPlatformFee` | uint256 | Exact original quote `F`; validate against registered fee policy |
| `buyerFeeBps` | uint16 | Only 0, 5,000 or 10,000; buyer default is 10,000 |
| `agreementHash` | bytes32 | Commitment to full canonical description, recipient details, conditions and acknowledgments |
| `feePolicyId` | bytes32 | Immutable quote schedule and proportional collection/rounding policy |
| `deliveryPeriodSeconds` | uint32 | Positive agreed duration, within selected category policy bounds |
| `inspectionPeriodSeconds` | uint32 | Agreed duration satisfying selected category minimum/bounds |
| `categoryPolicyId` | bytes32 | Immutable category definition and admission/evidence minimums |
| `readinessPolicyId` | bytes32 | Immutable readiness requirement, including a registered no-readiness policy when inapplicable |
| `readinessConsentHash` | bytes32 | Commitment to required readiness attestations; zero only when the policy explicitly allows it |
| `evidencePolicyId` | bytes32 | Immutable evidence windows, submission requirements and decision standards |
| `bondPolicyId` | bytes32 | Actual amounts/source rules, refund recipients and every outcome's cost treatment |
| `arbitrationPolicyId` | bytes32 | Immutable quorum, eligibility, primary/fallback authorities, delays, veto and recovery rules |
| `outagePolicyId` | bytes32 | Immutable effective-deadline algorithm and dependency-failure behavior |
| `catastrophicPolicyId` | bytes32 | Fixed 60-day rule, fee waiver, real bond refunds and principal dust allocation |
| `platformFeeRecipient` | address | Fixed recipient of earned normal platform fees |
| `arbitrationCostRecipient` | address | Fixed recipient of costs retained from actual bonds |
| `fundingDeadline` | uint64 | Funding requires strictly earlier chain timestamp |
| `nonce` | bytes32 | Signed agreement authorization nonce |
| `salt` | bytes32 | Cryptographically random agreement salt |
| `factory` | address | Zero for hub design; pinned factory for clone design |
| `implementation` | address | Zero for hub design; fixed immutable clone implementation otherwise |
| `custodyAddress` | address | Actual hub or expected deterministic vault; validate architecture-specific binding |

Alternate buyer/bond refund destinations are not required by the locked product. Before using nondefault recipients, confirm the intended V1 wallet policy and capture them explicitly before funding. Never accept a destination from the `claimFor` caller.

The hash-committed agreement must contain platform/game, full goods/service description, delivery recipient identifiers, completion criteria, evidence requirements, important conditions, no credential-storage rule, exhausted-dispute-right warning, and acknowledgment of the catastrophic fallback. Define canonical UTF-8 bytes and versioning; preserve/export the exact accepted bytes. Never put passwords, keys, recovery phrases or secret delivery codes in that agreement.

## 3. Immutable policy records

Each policy ID resolves to a complete registered record whose content hash is checked. Records are append-only and cannot be edited under an existing ID. A human label such as `ArbitrationPolicyV1` is not enough: its complete rule set must be committed and enforced where it affects money or authority.

| Policy | Committed content / enforcement |
|---|---|
| Fee | Principal minimum 5 USDC, five quote tiers, 0.50 minimum, QUOTATION CEIL (P-01), proportional actual fee floor formula, buyer-floor/seller-remainder split, allocations {0,5000,10000} |
| Category | Category ID, 1h–30d delivery / min–14d inspection bounds (P-10), minimum inspection per category (P-12), required nonsecret delivery metadata and supported transfer method |
| Readiness | 2h expiring consent required for <=3h tier, no-readiness policy otherwise, no indefinite funded waiting phase (P-11) |
| Evidence | 24h locked cutoff (P-06/P-13), submission permissions (respondent optional, no default loss), append-only commitments, standards, 2y/5y retention, backup/key recovery |
| Bond | Principal-tiered actual requirements min 5 USDC, eligible sources (fresh or vested unencumbered), proportional partial costs Cb=floor(Qb*S/P) Cs=floor(Qs*(P-S)/P), unilateral full-refund + bilateral bounded choice (P-03/P-04) |
| Arbitration | Continuous tiers 5–1k/1k–10k/10k+ USDC, 2-of-3 / 3-of-5 / 3-of-5 quorums disjoint primary/fallback, 7d/7d reviews, 24/48/72h delays, cancel-only veto, 72h rotation delay, epoch rule (P-05..P-08) |
| Outage | Phase 1 requirements locked (P-09): protected rights, adjustable clocks, 30min grace, fixed escape, fail-closed timeouts / fail-open admission; exact pseudocode bounded Phase 2 |
| Catastrophic | 5,184,000s from first dispute, proper escalation prerequisite, post-cutoff ruling prohibition, zero fees, refund of `B0` and real bonds, odd unit to buyer (P-02) |

At funding, the contract validates the signed policy's suitability for the principal and category. Signing a weaker policy must not bypass the required tier. Higher aggregate risk may require a stronger signed policy through admission; it cannot weaken an existing deal.

Rules and quorums are immutable per funded deal. A reviewer registry may support key recovery only under a signed governance model; mutable signer membership is not permission to reduce quorum, instantly install an administrator-controlled panel, or rewrite economics. RB-05 must define pending-ruling treatment after signer revocation/replacement and security governance delays. The contract may not depend solely on a private backend for knowledge of who is authorized.

## 4. Later typed authorizations

Each action uses a distinct EIP-712 primary type. For participant actions include `dealId`, exact agreement digest, authorized actor, action nonce and `expiresAt`. Bind to the same chain and actual action-verifying contract. A login signature is never financial authorization.

| Type | Additional committed payload |
|---|---|
| `MarkDelivered` | Delivery manifest hash and required nonsecret structured delivery commitment |
| `OpenDispute` | Reason code and optional initial commitment; no upload prerequisite |
| `EscalateDispute` | Expected phase/first-dispute identity, collateral amount/source authorization, bond policy |
| `ApproveSeller` | Explicit full release, expected terminal-policy version and applicable bond treatment |
| `RefundBuyer` | Explicit full refund and applicable bond treatment |
| `MutualSettlement` | Seller principal award, buyer/seller bond costs or required disposition identifier, expected phase, shared settlement nonce |
| `ReserveExistingClaim` | Owner, exact vested balance/amount, destination deal and party bond bucket |
| `EvidenceManifest` | Deal, uploader, sequence, previous manifest commitment, original file hashes and metadata commitment |
| `Ruling` | Agreement digest, arbitration policy ID, primary/fallback origin, unique ruling nonce, seller principal award, bond costs, evidence record commitment, authorization epoch, queue expiry |
| `VetoRuling` | Exact pending ruling digest, authorization nonce and expiry; no replacement award or recipient |
| `FundingAdmission` | Exact agreement digest, selected minimum policy, admission nonce/expiry and expected funding state; only needed if risk/capacity gates are mandatory |

These are action-schema requirements, not finalized action ABI/type-order definitions. The production ABI must specify each complete ordered primary type before cryptographic integration tests. The unresolved bond and governance choices affect those payloads, RB-03/RB-05.

The exact queued ruling determines `executeAt` from the policy and queue timestamp. Reject a queue whose earliest execution is at or after `escapeAt`. All approvals commit to the same award; deduplicate approvers and count distinct authorized signers. A primary approval cannot substitute for a fallback approval without policy authorization.

For offers and actions, use consumed/revoked nonce state and explicit phase checks. A new settlement nonce or terminal settlement invalidates stale settlement offers. Decide whether a phase transition invalidates an outstanding offer even when its nonce is unchanged, and enforce the signed expected-phase field consistently. Permissionless settlement/claim callers do not acquire signature authority.

## 5. Funding authorization, revocation and custody binding

Either participant can irrevocably invalidate an executable unfunded agreement digest on-chain. Validate the participant against the exact supplied agreement and actual caller/signature. Funding checks revocation, expiry, prior use, deal identity, both signatures and applicable policy records. A cancellation requested through the UI is pending until chain inclusion; ordering between funding and revocation is resolved by the first valid included transaction, not request time.

For gasless funding, separately validate token authorization payer, recipient, amount, nonce and validity interval. Bind the payment authorization to the intended agreement; a token signature for the same amount cannot be substituted into another accepted deal. If supported by the deployed token, receive the funds inside the atomic application funding wrapper using the appropriate authorization method. [EIP-3009 specification.](https://eips.ethereum.org/EIPS/eip-3009)

Use a token-authorized nonce derivation from the agreement digest and a signed payment salt, or a separately signed funding intent that commits to both the agreement and token authorization nonce. This payment-binding choice belongs to RB-06 and must have concrete test vectors. Verify the token method and signature domain on a deployment fork rather than assuming capability from its name.

An escrow's EIP-1271 verification does not by itself establish support for every token authorization route. Validate smart-wallet signatures at execution, since validity can depend on wallet state; define and test a compatible approval/transfer fallback. [EIP-1271 specification.](https://eips.ethereum.org/EIPS/eip-1271)

Hub model: the domain verifier and custody address are the actual pinned hub; architecture-only fields are zero. Clone model: pin factory and immutable implementation, derive and validate the expected vault from the signed agreement identity, and initialize/fund atomically. Whether agreement signatures are verified by the factory or the predicted vault is RB-06; commit a single exact choice. A fixed clone must not delegate to an upgradeable implementation or consult a mutable beacon that rewrites existing guarantees.

## 6. Admission, privacy and completion gate

Risk, account, aggregate exposure and reviewer-capacity checks operate before funding. If required, their approval is an expiring contract-validated admission authorization. Its signer can deny new admission but cannot approve settlement or redirect funds. Pausing new funding prevents stale admission approvals from funding while paused. The admission policy and subsidy budget are RB-09.

Private invitation tokens are access secrets, distinct from `dealId` and financial authorizations. Keep them out of chain commitments, ordinary logs, telemetry and third-party scripts; authenticate private evidence access. Browser fragments reduce ordinary HTTP leakage but do not protect against script or client-side disclosure.

| Blocker | Decision (Phase 1 approved 2026-10-03; full text in policy-register.md) |
|---|---|
| RB-01 | Requirements locked P-09; exact outage algorithm + measurements bounded Phase 2 |
| RB-02 | APPROVED P-05/P-06 tiers/windows/delays/quorums |
| RB-03 | APPROVED P-03/P-04 partial + voluntary bond rules |
| RB-04 | APPROVED P-01/P-02 CEIL quote + buyer dust |
| RB-05 | APPROVED P-07/P-08 veto/recovery/post-escape precedence |
| RB-06 | Bounded Phase 2: hub/clone, domain/custody, payment binding, USDC fork proof |
| RB-07 | APPROVED P-10/P-11 bounds/readiness/confirmation |
| RB-08 | APPROVED P-12/P-13 evidence/retention/recovery |
| RB-09 | APPROVED P-14 interim subsidy/admission/capacity |

Before production: complete bounded Phase 2 experiments, select and register complete policies with concrete deployment addresses, choose custody architecture, finalize all ordered action schemas, provide independent EIP-712/hash test vectors and wallet capability tests, test nonce/revocation races, then review the exact implementation and deployment. Arithmetic/reference validation is a prerequisite, not that completion gate.
