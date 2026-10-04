# Phase 4 — Contract implementation record (MidmanHub system)

Status: implemented 2026-10-03. `forge build` clean (solc 0.8.26, via-IR,
optimizer 200). `forge test`: **203/203 pass, 4 fork-skip (207 total)**. Sizes: Hub 19,595 / Lib 18,211
bytes (EIP-170 limit 24,576). Dependencies: OpenZeppelin 5.0.2 (EIP712, ECDSA,
IERC1271, ReentrancyGuard, SafeERC20, Math.mulDiv), forge-std (tests only).

## 1. Deployment units (all immutable, no proxies)

| Unit | Source | Role |
|---|---|---|
| `MidmanPolicies` | `src/MidmanPolicies.sol` | Append-only policy registry, reviewer/veto panels + 72h rotation epochs, timelocked roles, outage ledger |
| `HubDispute` | `src/HubDispute.sol` | Dispute machine + settlement cores, deployed as **library**, executed via DELEGATECALL in hub context |
| `MidmanHub` | `src/MidmanHub.sol` | All state + funds, funding, exits, claims, pause/rescue, single EIP-712 domain `MidmanEscrow/1` |
| `Finance` | `src/Finance.sol` | Exact ledger math (internal library, inlined) |
| `DealTypes` | `src/DealTypes.sol` | Shared structs, `MidmanDK` constants, errors, events |

Custody is never split: the library holds no funds and only runs inside hub
storage context. Events are always attributed to the hub. The linked library
address is part of the release deployment manifest (alongside hub, policies,
USDC, feed, panels, policy hashes).

## 2. Transition → implementation map (Phase 4 gate)

| Spec | Hub function | Ledger | Test |
|---|---|---|---|
| T01 fund | `fund` (dual sigs, revocation/expiry/policy/admission checks, exact D via EIP-3009 or bound allowance) | L-FUND | fund paths, wrong-quote/revoked/double/payment-binding |
| T02 revoke | `revokeUnfundedTerms` (participant direct or sig; funded deals immune) | L-NONE | revoked |
| T03 deliver | `markDelivered` (seller, one-shot, `< effDeadline`, manifest commitment) | L-NONE | all flows |
| T04 non-delivery | `refundForNonDelivery` (feed-gated timeout, S=0) | L-NORMAL | non-delivery |
| T05 release | `approveSeller` (buyer, any active phase incl. post-escape, bonds refunded) | L-NORMAL | release, non-buyer revert |
| T06 refund | `refundBuyer` (seller, bonds refunded) | L-NORMAL | refund, vested-claim source |
| T07 mutual | `mutualSettlement` (both sigs, phase+counter check, bounded Cb/Cs) | L-NORMAL | mutual (split-fee math) |
| T08 timeout | `finalizeAfterTimeout` (DELIVERED, feed-gated, S=P) | L-NORMAL | timeout, lapse→timeout |
| T09 dispute | `openDispute` (buyer, fail-open, permanent `disputeUsed`, records escapeAt) | L-NONE | lapse, rulings, escape |
| T10 advance | `advanceNegotiation` (idempotent) | L-NONE | via normalize paths |
| T11 escalate | `escalate` (window + escape checks, exact bond, fresh or vested-claim reserve) | L-BOND | rulings, escape, vested claim |
| T12 lapse | `lapseDispute` (back to DELIVERED anchor, right exhausted) | L-NONE | lapse |
| T13 resp bond | `postRespondentBond` (once, optional, seller/direct-or-sig) | L-BOND | full seller ruling |
| T14 evidence | `submitEvidenceCommitment` (append-only manifest chain) | L-NONE | — (Phase 5: cutoff/ordering cases) |
| T15 primary | `advanceToPrimary` (idempotent) | L-NONE | rulings |
| T16 fallback | `activateFallback` (fixed start = deadline, idempotent) | L-NONE | veto flow |
| T17/T18 queue | `queuePrimaryRuling`/`queueFallbackRuling` (quorum, epoch, exact formula costs, `executeAt < escapeAt`) | L-NONE | full/partial/wrong-costs |
| T19/T20 veto | `vetoPrimaryRuling`/`vetoFallbackRuling` (2-of-N cancel-only, phase rules) | L-NONE | veto flow |
| T21 execute | `executeRuling` (delay elapsed, pre-escape, epoch survives rotation) | L-NORMAL | rulings |
| T22 deadlock | `markDeadlock` (idempotent) | L-NONE | — (Phase 5: fallback-expiry case) |
| T23 escape | `catastrophicEscape` (escalated phases only, no oracle/keeper dependency) | L-CATASTROPHIC | escape, odd-principal |
| T24 claim | `claimFor` (fixed recipient, effects-first, failure reverts) | L-CLAIM | all flows, liabilities → 0 |
| T25 pause | `pauseNewFunding` (pauser; clears stale unpause) | L-NONE | pause |
| T26 unpause | `proposeUnpause`/`executeUnpause` (24h governance timelock) | L-NONE | pause |

No broad administrator withdrawal exists: `rescueExcess` transfers at most
`balance - totalLiabilities()` to the timelocked treasury (tested: reverts
with zero excess; donations never credit a deal). No funded-deal rewrite path
exists: deals have no setters; policies are append-only; rotations are
epoch-gated with pending rulings surviving unless vetoed.

## 3. EIP-712 surface (final, ordered)

Domain: `MidmanEscrow/1/chainId/hub`. Verifier is the hub for every action
(the library has no domain of its own). `actionDigest(bytes32)` exposes exact
digests for relayers/SDKs. `DealTerms` order is unchanged (32 fields, manifest
order). Action schemas follow `specs/phase2-threat-model.md` with three
funding-time additions that do **not** alter `DealTerms`:

- `EscalateDispute` gains `bytes32 claimId` (binds the vested-claim reserve).
- `FundWithAllowance` (approve path binding) and `BondIntent` (third-party
  respondent-bond submission) and `ReadinessConsent` (2h freshness proof).

## 4. Outage behavior as built

Global sequencer feed + global append-only outage ledger (`reportOutage`
verifies down-round/up-round pairs). Effective deadlines add overlap +
per-policy grace; `escapeAt` never adjusts. Timeout/progression paths are
fail-closed (feed must answer up); admission, exits, claims and escape are
feed-independent (fail-open). Recorded deviation from the Phase 2 draft: feed
and ledger are global rather than per-policy objects; policy still commits
grace, lookback bound and content hash.

## 5. Open Phase 2 measurements (unchanged)

Hub-vs-vault gas benchmark, real-USDC fork verification, wallet matrix, and
the 8-scenario outage prototype still require fork runs (Phase 5). The MockUSDC
(EIP-3009 path included) and programmable MockFeed exist so those suites have
harness support. Custody choice follows the documented default rule (hub on
tie/no-data); benchmarks may still overturn it before audit since no mainnet
deployment exists.
