# Midman V1 final implementation plan

Prepared 3 October 2026. This is the execution roadmap for the consolidated V1 decisions and subsequent amendments. The existing financial specifications remain drafts until the policy and architecture gates below are completed.

## Agreed V1 scope

Build private-link escrow on Base using native USDC. Either party may draft the deal; both parties accept the same cryptographic terms; the buyer funds atomically; the seller delivers; the buyer releases or disputes; permissionless rules allocate entitlements; anyone may sponsor a fixed-recipient claim.

| Requirement | Agreed behavior |
|---|---|
| Purchase asset / network | Native USDC / Base |
| Principal minimum | 5 USDC |
| User-facing principal maximum | None; enforce appropriate funding admission and arbitration security |
| Minimum quoted platform fee | 0.50 USDC |
| Duration pricing | Delivery plus inspection: <=3h 0.25%; >3h and <24h 0.50%; 24h–3d 0.70%; >3d–7d 1.00%; >7d 2.00% |
| Fee payer | Buyer by default; seller or 50/50 also supported |
| Actual normal settlement fee | `floor(quotedFee * sellerPrincipalAward / principal)` |
| Actual buyer fee share | Floor of actual fee times the signed buyer basis-point share; seller contribution is the remainder |
| Initial dispute | One unilateral buyer freeze per deal, without an arbitration bond; evidence follows chain inclusion |
| Negotiation / escalation | 24h self-resolution, then 24h claimant escalation window, subject to the final outage rules |
| Escalation collateral | Separate actual USDC or vested, unencumbered existing claims; minimum 5 USDC per actively contesting party |
| Missed escalation | Return to the original inspection schedule with the unilateral dispute right permanently exhausted |
| Arbitration | At least 2-of-3 ruling authorization; stronger principal tiers selected before launch |
| Catastrophic escape | Fixed 60 days from the first dispute; properly escalated unsettled deals; 50/50 principal, zero fees, prepaid buyer fee and actual bonds refunded |
| Administration | Separate funding pause, arbitration, veto/recovery, relaying, governance and earned-fee roles |
| Contracts | Immutable/versioned funded-deal guarantees; hub versus fixed per-deal vaults decided by a prototype benchmark |
| Payouts | Fixed signed recipients; pull claims; independent recipient transfer failures |
| Game accounts | Supported under approved category policy; minimum 24h inspection, recommended 72h; no post-settlement warranty |

Other category inspection minimums remain: instant codes 1h; game items, game currency, general digital goods and services 12h. The short fee tier therefore mainly fits instantly verifiable codes. Inspection durations and seller declarations do not prove the underlying goods were delivered.

The implementation baseline is the previously proposed stack: Next.js frontend, NestJS/Fastify API, PostgreSQL, Redis/BullMQ workers, Solidity/Foundry, viem, reviewed OpenZeppelin primitives, encrypted S3-compatible storage, and containerized infrastructure. Pin supported dependency versions when establishing the repository. Hosting provider and hub/vault choice are not silently selected by this roadmap.

## Phase 1 — Close product, economic and operational policies

**Purpose:** settle remaining financial/operational decisions without reopening the product concept.

Complete a policy decision register covering quote rounding and catastrophic split dust; partial-ruling bond costs; voluntary release/refund/settlement bond handling; respondent evidence/submission rules; principal-based quorum ranges; primary/fallback decision windows; execution delays; veto/recovery authority; non-arbitration exits after escape eligibility; duration bounds; expiring readiness; confirmation policy; category evidence and retention; subsidy budget and funding admission capacity.

Specify contract-critical outage requirements here: which time-sensitive rights must be protected, which clocks may adjust, and how that interacts with the fixed escape cutoff. The actual algorithm is validated in Phase 2.

Define supported category procedures and concrete completion criteria. Document seller responsibility for delivery declarations, buyer inspection/escalation consequences, no credential storage, and post-settlement account-report handling. Define independent primary/fallback reviewer coverage and who owns each recovery responsibility.

Update the three linked artifacts together: [state transitions](specs/state-transitions.md), [ledger](specs/financial-ledger.md), and [signed policies](specs/signed-policy.md). Use the [manifest](specs/contract-spec.json) as the common identifier/parameter register.

**Deliverables:** policy register, complete outcome decisions, category rules, operational responsibility matrix, updated specification drafts.

**Completion gate:** every business/economic choice has a recorded rule or an explicitly bounded Phase 2 technical experiment. No hidden later fee, bond, or quorum changes may affect funded deals.

## Phase 2 — Prove architecture and freeze the contract design

**Purpose:** settle the technical decisions that determine custody, signatures and deadlines before the production contract build.

Build narrowly scoped prototypes for the hub and fixed minimal-vault approaches. Measure deployment, funding, dispute, settlement and claim costs; token authorization; indexing; real collateral management; account isolation; and shared-code/role risks. Choose one architecture and record why. These prototypes are disposable design evidence, not production implementations.

Verify deployed native USDC capabilities with fork experiments, including compatible wallet/token authorization paths, exact funding amounts, authorization consumption and transfer failures. Design atomic payment binding so a token authorization cannot fund another accepted agreement. Select agreement verification/custody domain rules and finalize all ordered EIP-712 action types.

Prototype and threat-model the Base outage algorithm: timely dispute versus timeout release, delivery and escalation rights, multiple outages, delayed status updates, unavailable dependencies and recovery grace. Protect assigned claims from dependency checks. Preserve the fixed escape cutoff and explicitly resolve long-outage conflicts.

Threat-model participant collusion, stolen wallets, compromised reviewers/governance, admission-key abuse, front-running, signature replay, accidental transfers, evidence omission, RPC outages and aggregate transaction splitting. Define reviewer key rotation and pending-ruling validity after revocation. Review admission authorization boundaries and ensure they cannot settle existing deals.

**Deliverables:** architecture decision, prototype results, outage design with adversarial scenarios, finalized typed-action schema, threat model, contract specification baseline.

**Completion gate:** all contract-critical behavior and custody/signing choices are resolved. Concrete deployment addresses are instantiated and verified at release; their binding rules must already be fixed. External design review is recommended before proceeding with the full financial implementation.

## Phase 3 — Establish the repository and security foundations

Create a maintainable workspace for frontend, API, workers, contracts, shared financial types and deployment configuration. Configure pinned dependencies, reproducible builds, CI, test environments and structured configuration. Keep financial amount/timestamp serialization exact.

Implement wallet-domain authentication, secure sessions, participant authorization, invitation-secret handling and private-data access controls. Add sensitive-action authentication for operational users, hardware-backed reviewer signing procedures, isolated role credentials, secret management, audit logging and telemetry redaction.

Set up PostgreSQL migrations, encrypted storage, initial workers, RPC adapters, health checks and backup/key-recovery foundations. Establish a first relayer interface and direct-call client interface using the Phase 2 action format. Avoid coupling critical contract rights to an application login or a single relay service.

**Deliverables:** buildable workspace, CI, shared types, development environments and security baseline.

**Completion gate:** services start reproducibly; secrets and private invitations do not enter routine logs; participant and operational permissions are exercised; role separation is reflected in the architecture.

## Phase 4 — Implement the escrow contracts

Implement exact-token atomic funding; dual term signatures; unfunded authorization revocation; fixed participants/recipients/policies; one-time delivery declarations; delivery refunds; buyer releases; seller refunds; mutually signed outcomes; timeout settlement; and separate claim allocation.

Implement the free one-use dispute, permanent `disputeUsed` flag, absolute deadlines, actual collateral posting/reservation, claimant escalation/lapse, respondent participation, evidence commitments, primary/fallback progression, quorum-authorized rulings, ruling delays, constrained vetoes, fixed escape and permissionless terminal execution.

Integrate proportional fees and every approved bond outcome. Reject impossible or late awards. Preserve pending-ruling, lapse and escape precedence. An un-escalated dispute must not become entitled to the catastrophic split through inactivity.

Add funding-only pause and timelocked unpause, immutable policy records, approved signer governance, internal liabilities, fixed-recipient claims, and excess-only rescue bounds. If using clones, deploy/initialize/fund atomically and bind the expected custody address. Keep gasless payment and action authorization compatible with direct transactions.

**Deliverables:** complete financial contract implementation, ABI/events, policy deployment tooling and contract operational controls.

**Completion gate:** every specification transition and outcome has a matching implementation path; no broad administrator withdrawal or funded-deal rewrite capability exists.

## Phase 5 — Verify financial and authorization invariants

Use Foundry unit, fuzz, invariant and sequence tests with a financial reference model. Exercise all three fee allocations, minimum principal, odd units, tiny awards, separate bond deposits and vested-balance reservations, zero respondent bonds, voluntary outcomes, and catastrophic refunds.

Test replay/domain separation, expired/revoked signatures, stale offers, contract-wallet validity, token authorization substitution, duplicate funding, initialization attacks, double settlement, reentrancy, reviewer compromise scenarios, signer recovery, veto boundaries and aggregate authorization weaknesses.

Test every `<`/`>=` boundary, keeper inactivity, outage/recovery behavior, admission pause, failed withdrawals, token-wide failures and accidental-transfer rescue. Run fork integration against the pinned token and verified protocol dependencies. Use local time travel to exercise the 60-day path without changing the production rule.

**Deliverables:** automated contract suite, invariant/reference comparisons, fork results and requirement-to-test coverage map.

**Completion gate:** required checks pass; failures are resolved; unsupported wallet/dependency behavior is explicit. The existing 567,700 arithmetic/model cases are useful specification evidence, not a replacement for these contract checks.

## Phase 6 — Build the API, workers and chain projection

Implement authenticated deal drafting, intended-counterparty confirmation, invitations, canonical term generation, signature collection, funding admission, revocation tracking and participant-facing financial reads. Do not create funded chain state for ordinary drafts.

Build the indexer from the verified deployment block with block-hash tracking, log identity, idempotent processing, replay and reorg rollback. Make contract state authoritative for financial status. Define inclusion/safe/finality display rules and the exact confirmation policy permitting irreversible delivery.

Add workers for reminders, relay submission, transaction reconciliation and permissionless progression. Keeper or indexer downtime must not extend deadlines or prevent independent contract access. Include minimal gas sponsorship as part of the working flow; recovery verification is expanded in Phase 10.

Separate reconstructable chain projections from off-chain terms, chat, evidence and account records. Implement durable storage, exports and backup procedures for the latter.

**Deliverables:** working API, financial projection, durable workers, baseline relaying and recovery exports.

**Completion gate:** replay reproduces financial state; reorgs correct the projection; database financial labels cannot override chain state; worker retries do not duplicate authorized actions.

## Phase 7 — Deliver the complete normal user journey

Implement create, share, review, wallet authentication, counterparty acceptance, dual signing, funding, delivery, inspection, early release, refund and claim flows. Show exact buyer funding, seller payout, fee allocation and effective fees for small deals.

Add network/token verification, readable agreement summaries, signed-agreement downloads, expiring short-deal readiness, payout confirmations and deadline warnings. Show pending transactions separately from included state and handle replacements/reorgs.

Implement the dispute button in the first complete journey: submit the freeze transaction before collecting evidence; confirm inclusion; display the deadline and exhaustion warning. Include sponsored actions and directly accessible fallback transaction data. Verify supported wallet methods against the Phase 2 capability matrix.

**Deliverables:** usable end-to-end escrow application on a test deployment.

**Completion gate:** both roles can complete normal deals and exercise timely protection with and without the primary relayer. An API/scanner failure cannot gate the initial dispute transaction.

## Phase 8 — Complete evidence, messages and category workflows

Implement encrypted evidence storage, original-byte hashing, signed receipts, append-only manifests, on-chain commitments, exports and reviewer access. Preserve originals separately from scanned or redacted derivatives.

Add type/size validation, malware scanning, safe previews, upload abuse controls, no-credential warnings and authenticated deal messages. Apply category-specific delivery/completion forms and standards. Define evidence cutoff and respondent participation according to the selected policy.

Implement retention, deletion authorization, redundant encrypted backups and recovery of encryption metadata/keys. A hash is a commitment and verification tool, not proof of truthful delivery or a substitute for a recoverable file.

**Deliverables:** complete evidence/message subsystem and approved category procedures.

**Completion gate:** participants can independently verify/download their records; originals match commitments; unauthorized access is rejected; restore tests recover both files and necessary keys.

## Phase 9 — Build dispute and arbitration operations

Implement negotiation, bounded settlement proposals, escalation/collateral UX, evidence cutoff and progress displays. Explain the one-use dispute, missed escalation, separate bond requirements and the signed catastrophic outcome.

Build the reviewer console with least-privilege evidence access, written category standards, conflict handling, structured principal/bond awards, distinct approval signatures, queue delays and immutable audit records. Enforce quorums in the contract, not only in the console.

Implement independent fallback/veto operations and pending-ruling notifications. Rehearse nonparticipant cases, partial rulings, failed panels, compromised keys, delayed execution and exhausted review capacity. Track actual review costs and subsidies.

**Deliverables:** fully usable primary/fallback dispute service and reviewer runbooks.

**Completion gate:** assigned staff can complete every dispute outcome within the selected clocks; no reviewer alone bypasses required approval; missing respondent bonds never create fictional revenue or a default loss.

## Phase 10 — Verify reliability, monitoring and recovery

Harden relay and RPC redundancy, gas estimation, sponsorship budgets and abuse controls. Provide independent transaction submission and an emergency interface/recovery package that can operate without the primary API/indexer. An ETH reserve can help but cannot guarantee future emergency gas capacity.

Monitor liabilities versus custody balances, large settlements, ruling queues, reviewer/governance activity, pause events, relay failures, evidence/storage failures, fallback activation and escape eligibility. Deliver actionable alerts to the responsible operators.

Run database/object/key restores and rehearsals for relay/RPC outages, chain outage/recovery, reviewer-key loss, phishing, storage compromise and token restrictions. Document the limits of a funding-only pause and immutable existing contracts during an exit-function vulnerability.

Apply capacity controls and aggregate-risk reviews to new admission. Existing funded rights retain their signed rules; no retroactive bond increase or unavailable-review surprise is allowed. Load-test API, indexer, evidence and review capacity against the expected launch volume.

**Deliverables:** operational dashboards, alert paths, independent recovery interface, measured capacity and completed incident drills.

**Completion gate:** users retain independent recovery access; staff can execute runbooks; restored data/keys are usable; new funding can be stopped when risk or capacity requires it.

## Phase 11 — Run adversarial end-to-end acceptance

Exercise the complete application and reviewer service on test deployments: happy paths, non-delivery, false delivery, early release, full/partial disputes, lapsed escalation, optional respondent participation, mutual settlements, veto/fallback, expired/revoked terms, direct claims and failed recipients.

Exercise replayed/stale signatures, forwarded invitations, unavailable APIs/scanners/relayers, keeper inactivity, reorg projections, reviewer loss, admission bypass attempts and collusion that manufactures subsidized cases. Combine browser, API, chain and storage evidence for the same transaction.

Use local simulation/fork tests for long-duration and exceptional chain/token behavior that cannot be safely or promptly forced on a public testnet. Keep any shortened test-policy deployment clearly distinct from the immutable production 60-day rule.

**Deliverables:** acceptance scenarios, actual run results, resolved defects and updated operational capacity assumptions.

**Completion gate:** the entire normal and dispute flow works through all layers; failures recover according to the specification; no material acceptance failure remains unexplained.

## Phase 12 — Complete external review and prepare the release

Obtain independent contract security review of the exact financial implementation, governance, policy registration, signature/payment binding, chosen custody architecture and protocol dependencies. Include application security review of wallet authorization, reviewer access and evidence privacy.

Resolve critical/high findings and other release-blocking issues; record remaining assessed risks; rerun the relevant checks after fixes. Freeze the audited release, dependency versions and complete policy records. Prepare verified source/bytecode, deployment scripts, role assignments, emergency controls and release monitoring.

Prepare and open an appropriate vulnerability-reporting/bug-bounty program with defined scope, response ownership and funding. Initialize production configuration in a reproducible deployment manifest; verify actual chain, native token, custody/domain addresses, signer registries and policy hashes before any user signs/funds.

**Deliverables:** reviewed release, remediation evidence, deployment manifest, key/role setup, bounty/reporting program and completed launch checklist.

**Completion gate:** deployed code/configuration matches the reviewed release; material findings are closed; independent reviewer and recovery coverage is available; no earlier policy blocker remains open.

## Phase 13 — Launch gradually and establish steady operations

Start with controlled onboarding and monitored real transactions through the complete reviewed service. Admit larger exposures only with their already implemented signed authorization requirements and operational risk review. Preserve the no user-facing amount-ceiling decision; rollout pace is governed through admission and capacity rather than a silently introduced principal cap.

Monitor actual gas/sponsorship spend, delivery completion, dispute/subsidy rates, reviewer turnaround, retained bond costs, evidence/storage usage, claim failures and solvency reconciliation. Pause new funding when incident or capacity thresholds require it, while preserving funded-deal exits.

Expand onboarding only when the measured service stays within its reviewed capacity/security limits. Publish user-facing fee, deadline, dispute and catastrophic-fallback disclosures before funding. Keep support inside authenticated channels and maintain post-sale reporting.

**Deliverables:** live V1 with sustainable primary/fallback operations and measured launch results.

**Completion gate:** real transactions and disputes are served reliably; financial reconciliation and incident controls operate continuously; expansion follows recorded criteria rather than calendar pressure.

## Dependencies and ownership

Phases 1–2 determine the contract design. Phase 3 can establish infrastructure alongside focused Phase 2 experiments. Phases 4–5 establish the financial engine. Backend, frontend, evidence and reviewer work can progress concurrently once the relevant validated ABI/events and policy interfaces stabilize, but all Phases 6–10 must be integrated before Phase 11 acceptance. External review and release gates must complete before unrestricted mainnet admission.

Contract/security engineering owns financial invariants, signing, dependencies and contract review. Backend/platform engineering owns projection, relaying, storage and restoration. Frontend/product owns agreement clarity and exercise of user rights. Arbitration operations owns reviewer independence, case standards, coverage and subsidy capacity. Release leadership owns the final policy register and readiness gates. These are responsibilities; one person may hold several development roles, but production security approvals must preserve the selected independence requirements.

Do not invent calendar estimates without team size, staffing and review availability. Track deliverables and gates first; estimate each phase against assigned owners and scope once those inputs are known.

## Current status and next work

Three linked specification drafts, a canonical manifest and [model/reference validation](specs/validation-report.json) already exist. The reported 567,700 model/boundary cases passed. Production implementation, deployed token integration, full cryptographic/contract verification, custody benchmarking and operational acceptance have not been completed.

The next work is Phase 1 policy closure, followed by Phase 2 technical proofs. The previous nine blockers are allocated as follows:

| Blocker | Resolution phase / release evidence |
|---|---|
| RB-01 outage algorithm | Phase 2 design/prototype; Phase 5 verification |
| RB-02 arbitration tiers/windows | Phase 1 policy; Phase 2 authority design; Phase 9 staffed rehearsal |
| RB-03 bond dispositions | Phase 1 economics; Phase 5 outcome verification |
| RB-04 rounding/dust | Phase 1 rules; Phase 5 boundary verification |
| RB-05 recovery/precedence | Phases 1–2 rules; Phases 5/9/10 verification and drills |
| RB-06 custody/token/domain | Phase 2 architecture/fork proof; Phase 12 exact deployment configuration |
| RB-07 confirmation/readiness/duration | Phases 1–2 policy; Phase 7 user-flow verification |
| RB-08 evidence rights/retention/recovery | Phase 1 policy; Phase 8 implementation and restore proof |
| RB-09 subsidy/admission capacity | Phase 1 budget; Phases 6/9/10 implementation and rehearsal |

Keep public listings, storefronts, discovery/search, additional chains/tokens, mobile applications, AI-only arbitration, loyalty/subscriptions, long-term warranties, complex appeals and social feeds outside this V1 implementation.
