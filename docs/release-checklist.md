# Release checklist — go / no-go gate

Status: **not yet releasable**. This checklist is the Phase 12 gate. It is
honest about what is proven on this checkout and what is still pending. No
independent audit has been performed and no mainnet deployment exists.

Evidence snapshot (reproduced on this checkout):

| Check | Command | Result |
|---|---|---|
| Spec/model | `node specs/validate-spec.mjs` | PASS, 567,700 cases, `releaseBlockers: 9` |
| Node suites | `pnpm -r test` | 486 pass / 0 fail |
| Script suites | `pnpm test:scripts` | 44 pass / 0 fail |
| Contract suites | `forge test` | 186 pass / 0 fail / 4 fork-skip |
| Dependency audit | `pnpm audit` | 0 critical, 0 high, 1 moderate (accepted; `docs/dependency-pins.md`) |
| Fork (pinned block 52126164) | `BASE_RPC_URL=... forge test` | 4 pass |

The counts above reflect the post-remediation tree (audit response Phases 1–7).

## 0. Independent-audit remediation status (audit response Phases 1–7)

The external design/security audit's findings were addressed structurally; each
has code + tests. This does NOT replace the independent third-party review,
which remains **OPEN** (§2).

| # | Finding | Resolution | Status |
|---|---|---|---|
| 1 | Claim-backed collateral lacked owner authorization | `ReserveAuth` + `ReserveExistingClaim` signed by the claim owner; `reserveClaim` requires it (`HubDispute.sol`). Exploit regression `testReserveClaimRequiresOwnerAuth` | FIXED |
| 2 | Zero payout addresses could erase entitlements | Fund rejects zero recipients; `addClaim` reverts on nonzero-to-zero. `testFundRejectsZeroRecipients` + conservation tests | FIXED |
| 3 | Outage deadlines unreliable | Ring-buffer ledger, newest-first reads, `liveTrailing` from feed, primary-window coverage, `O+grace` clipping. `testNewestOutageEntriesCount`, `testPrimaryReviewWindowExtends`, `testOutageLedgerRingsPastCapacity`, `testUnreportedRecentOutageCounts` | FIXED |
| 4 | Production persistence missing | `PgStore` + tracked migrations + `createStore` rejects memory in production; registry kv for evidence/review/approvals/proposals. `packages/store` + `registry.ts` | FIXED |
| 5 | API authorization missing | Wallet challenge/session, party permissions, invitation-token enforcement, operator guards, relay redaction (`apps/api/src/auth/*`). 31 cases | FIXED |
| 6 | Funding journey could not complete | Full 32-field `DealTerms` signing, payment intent, admission, readiness, encoded `fund()` calldata; web direct + relay paths (`apps/api/src/funding.ts`, `apps/web/lib/funding.ts`) | FIXED |
| 7 | ABI/signature/hashing/API divergence | Generated ABIs, canonical EIP-712 module, shared `@midman/api-client` schemas; EvidenceManifest encoding + veto field corrected with on-chain parity tests | FIXED |
| 8 | Tx success reported incorrectly | `sendAndConfirm` checks receipt status; `confirmEvent` requires the expected event; DisputeButton gates on the exact tx | FIXED |
| 9 | Evidence integrity/access defects | Atomic convergent DEK creation, durable production KEK + rotation/keyring, content-bound upload signature, least-privilege reviewer access, quarantine gating. 18 cases | FIXED |
| 10 | Relay/indexer reliability | Calldata↔action validation, atomic lease + crash recovery, bounded retries, nonce serialization, receipt tracking; indexer same-height reorg + re-inclusion + chain-derived deal discovery | FIXED |
| 11 | Policy/deployment safeguards | Panel uniqueness/independence + tier sizing; separate `DeployDev`/`DeployProd` (no mock fallback, explicit roles/panels/policies); RPC `verify-deployment.mjs` | FIXED |
| 12 | Monitoring/replay protection | Truthful solvency (`ok:null` = unknown), retryable alert delivery, non-placeholder metrics; uniform offer-epoch invalidation (`transition`) | FIXED |
| 13 | Dependency advisories | Next 15 / React 19, Fastify 5, aws-sdk, ws/postcss overrides → 0 critical/high | FIXED |

## 1. RB-01..RB-09 release-blocker gate

Status values: **RESOLVED** (evidence exists and applies to the reviewed
candidate), **OPEN** (evidence or deployment step still missing).

| RB | Blocker | Required evidence | Evidence on this checkout | Status |
|---|---|---|---|---|
| RB-01 | Outage algorithm | Phase 2 design/prototype + Phase 5 verification | `specs/phase2-outage.md`; `packages/contracts/ABI.md` §4 (global feed + outage ledger as built); `test/Adversarial.t.sol` (outage extension + ongoing-outage fail-closed timeout), `test/Fork.t.sol` (real outage recording) | RESOLVED |
| RB-02 | Arbitration tiers/windows | Phase 1 policy + Phase 2 authority design + Phase 9 staffed rehearsal | `specs/policy-register.md` P-05/P-06; tier table `MidmanHub.sol:251-310`, constants `DealTypes.sol:204-218`; `test/e2e/Arbitration.t.sol` 13/13; `docs/phase9-rehearsal.md` | RESOLVED |
| RB-03 | Bond dispositions | Phase 1 economics + Phase 5 outcome verification | P-03/P-04; `Finance.bondCosts` `Finance.sol:47-54`; `test/FinanceFuzz.t.sol`; `test/e2e/Journey.t.sol` B; `test/MidmanHub.t.sol` partial/full/vested | RESOLVED |
| RB-04 | Rounding/dust | Phase 1 rules + Phase 5 boundary verification | P-01/P-02; `Finance.ceilQuote`/`catastrophicSplit` `Finance.sol:26-64`; `test/FinanceFuzz.t.sol`; `test/Boundaries.t.sol` | RESOLVED |
| RB-05 | Recovery/precedence | Phases 1–2 rules + Phases 5/9/10 verification and drills | P-07/P-08; `test/Adversarial.t.sol` rotation/veto; `docs/phase9-rehearsal.md` R3/R4; `docs/phase10-recovery.md` drills; `docs/incident-runbooks.md` | RESOLVED |
| RB-06 | Custody/token/domain | Phase 2 architecture/fork proof + Phase 12 exact deployment config | Hub chosen by default rule (`ABI.md` §5); fork proof `test/Fork.t.sol` (real USDC + real feed, pinned block 52126164) — **but benchmark not run and no mainnet addresses/domain instantiated** | **OPEN** |
| RB-07 | Confirmation/readiness/duration | Phases 1–2 policy + Phase 7 user-flow verification | P-10/P-11; readiness checks `MidmanHub.sol:211-238`; duration bounds `hub` + `DealTypes.sol:210-212`; `docs/phase7-acceptance.md`; `docs/indexer-recovery.md` §2 confirmation labels | RESOLVED |
| RB-08 | Evidence rights/retention/recovery | Phase 1 policy + Phase 8 implementation + restore proof | P-12/P-13; `docs/security-baseline.md` §2; `docs/phase10-recovery.md` restore drill; `apps/api/test/evidence.test.mjs` | RESOLVED |
| RB-09 | Subsidy/admission capacity | Phase 1 budget + Phases 6/9/10 implementation and rehearsal | P-14; `apps/worker/src/capacity/`; `apps/worker/test/capacity.test.mjs`; `docs/phase10-recovery.md` §7; `apps/api/test/acceptance.test.mjs` (k) | RESOLVED |

**RB-06 remains OPEN:** the custody decision is the documented hub default
(benchmark not run) and the real mainnet addresses, domain separator fixture and
policy records are not yet instantiated. This is the primary release blocker.

## 2. Additional go/no-go gates

| Gate | Required evidence | Current state | Status |
|---|---|---|---|
| Release-blocking findings resolved (critical/high) | Independent review report + remediation | **No independent review has been performed** (Phase 12 deliverable) | **OPEN** |
| Other findings triaged | Medium/low disposition record | Deferred until review | **OPEN** |
| Bytecode/config match verified | Frozen commit + dependency lock + reproducible build + `node scripts/verify-manifest.mjs deploy/manifest.<net>.json --strict` | Build is reproducible locally; verifier exists (`scripts/verify-manifest.mjs`); no deployed bytecode and no filled manifest yet | **OPEN** |
| Roles + emergency controls assigned | Live governance timelock, pauser, admission, treasury, panels; handover recorded | Addresses not instantiated (see `deploy/DEPLOYMENT.md`) | **OPEN** |
| Monitoring/alert destinations live | `ALERT_WEBHOOK_URL` and staffed alert paths | Env-driven and code-present (`docs/phase10-recovery.md`, `docs/incident-runbooks.md`); not deployed | **OPEN** |
| Drills passed | Restore + outage + capacity drills | Code-level drills pass (`apps/worker/src/drills/`, `apps/worker/test/capacity.test.mjs`); live restore/on-call rehearsal pending | **PARTIAL** |
| Bounty live | Program funded, channels monitored | Draft only (`docs/bug-bounty.md`); funding line unset | **OPEN** |
| Disclosures published | Fee/deadline/dispute/escape disclosures before funding | Not yet published | **OPEN** |
| Policy register approved & frozen | P-01..P-15 approved; content hashes recorded | Approved 2026-10-03 (`specs/policy-register.md`); 8 policy records registered by `Deploy.s.sol` | RESOLVED (content hashes to be finalized in manifest) |
| Public/spec model parity | `node specs/validate-spec.mjs` PASS | PASS, 567,700 cases | RESOLVED |

## 3. Reproduce the evidence

```text
node specs/validate-spec.mjs
pnpm -r test
forge build --sizes
forge test
$env:BASE_RPC_URL="https://mainnet.base.org"; forge test     # fork suite, pinned block 52126164
```

## 4. Go decision

Release is **NO-GO** until: RB-06 mainnet configuration is instantiated and
verified; the independent review is completed and all Critical/High findings are
resolved (medium/low triaged); bytecode/config are frozen and matched; roles and
emergency controls are assigned to real timelock/multisig/panel addresses;
monitoring/alerting is live; drills are re-run against the deployed environment;
the bounty program is funded and live; and user-facing disclosures are published.
See `docs/phase12-release.md` for the freeze procedure and completion gate.
