# Phase 5 — Verification record and requirement coverage

Status: 2026-10-03. `forge build` clean, `forge test`: **163 passed, 4 fork-skip (167 total, 10 suites)**
(current count; this file records the Phase 5 baseline of 135), plus spec model PASS (567,700 cases).
Invariant config: 64 runs × depth 20 (1,280 calls/run, both invariants hold).

## 1. Suite inventory

| Suite | File | What it proves |
|---|---|---|
| Unit/lifecycle | `test/MidmanHub.t.sol` (22) | Every T01–T26 path executes: fund (3009 + allowance), revoke, deliver, release/refund/mutual/timeout/non-delivery, lapse, full/partial rulings, veto→fallback, escape (even + odd), vested-claim reserve, pause/unpause, excess-only rescue, payment-binding |
| Finance fuzz | `test/FinanceFuzz.t.sol` | Independent reference model cross-checked on fuzzed (P,F,S,b): conservation, endpoints, ceil-quote property, bond formula + endpoints, catastrophic dust, tiny awards, tier boundaries |
| Boundaries | `test/Boundaries.t.sol` (19) | Every `<`/`>=` edge at the exact second: funding, delivery, inspection/dispute/timeout, negotiation/escalation/lapse, evidence, primary queue, execution delay, escape, stale settlement nonce |
| Adversarial | `test/Adversarial.t.sol` (14) | Cross-deal sig replay, double settlement/claim, quorum (single/outsider/duplicate), rotation epoch gating + queued-award survival, veto bounds, admission binding, keeper inactivity (lapse + deadlock paths), outage extension + ongoing-outage fail-closed, token blocklist liability preservation, evidence sequencing |
| Invariants | `test/Invariants.t.sol` + `test/HubHandler.t.sol` | Randomized full lifecycles: solvency (`balance >= liabilities`) and conservation (`funded + bonded == liabilities + claimed`) hold after every sequence |
| Fork | `test/Fork.t.sol` (4) | Pinned Base block 52126164: USDC 6 decimals / "USD Coin" / EIP-3009 live, sequencer feed answers 0 with historical down/up rounds, full approve-path funding→timeout→claim in real USDC, gasless 3009 with the real domain separator, real outage recording, fixed escape |

## 2. Requirement → test map (plan §Phase 5 checklist)

- Three fee allocations, minimum principal, odd units, tiny awards: FinanceFuzz + unit vectors.
- Separate bond deposits + vested-balance reservations: unit (fresh both sides) + vested-claim escalation + invariant handler (fresh paths).
- Zero respondent bonds: partial-ruling unit (Cs=0 branch) + fuzz endpoints.
- Voluntary outcomes + catastrophic refunds: unit + boundaries + fork escape math.
- Replay/domain separation: cross-deal replay, cross-agreement admission, payment-nonce binding, stale nonces/nonces-once (unit + adversarial).
- Expired/revoked signatures: funding-deadline edges, revoke-then-fund, stale queue expiries (implicit in queue tests).
- Stale offers: settlement-nonce test.
- Duplicate funding: double-fund revert.
- Double settlement: release→refund, execute→escape, double-claim reverts.
- Reentrancy: effects-first claims (double-claim revert); no external callbacks exist on token pulls (standard ERC20, no hooks).
- Reviewer compromise: quorum/outsider/duplicate/origin-mismatch cases; rotation + epoch gating + survival.
- Veto boundaries: origin, quorum, post-delay closure.
- Aggregate authorization: admission-per-agreement binding (no blanket approvals).
- Keeper inactivity: lapse + deadlock with zero housekeeping.
- Outage/recovery: programmed outage extension, ongoing-outage fail-closed timeout, fail-open dispute path (by construction: no feed gate on admission), real-round recording on fork.
- Admission pause: pause blocks funding, timelocked unpause restores, stale admissions stay valid-but-blocked-while-paused.
- Failed withdrawals: blocklisted recipient preserves liability; blocklisted hub blocks funding; rescue untouched.
- Token-wide failures + accidental rescue: donation creates excess-only rescue; zero-excess revert.
- 60-day path: time-travel escape tests (even + odd principal) without touching the production constant.

## 3. Explicitly open / unsupported (Phase 5 gate notes)

- **EIP-1271 contract-wallet matrix**: the hub dispatches to `isValidSignature`
  at execution (proven: a mainnet contract address correctly took the 1271
  path in fork trials), but no real Safe/Coinbase-wallet funding flow has been
  executed. Approve/transferFrom fallback is the documented route until the
  matrix is run (pre-launch requirement).
- **Real 3009 wallet support**: proven against the real token with an EOA key;
  smart-wallet 3009 support is wallet-dependent (same matrix).
- **Token-wide pause/blacklist of the hub by the issuer**: modeled via the
  mock blocklist (liabilities preserved); an issuer-level event remains an
  incident-runbook item (Phase 10), not a contract behavior.
- **Hub-vs-vault benchmark**: not run; custody default stands per the
  documented rule, overturnable before audit.
- **Long-duration mainnet soak**: covered by time-travel, not wall-clock.
- Fuzz runs are bounded (256 default for unit fuzz, 64×20 invariant); expand
  before audit if cheap.

## 4. Reproduce

- Local: `forge build --sizes && forge test` (skips fork suite without RPC).
- Full: `BASE_RPC_URL=https://mainnet.base.org forge test` (runs 4 fork tests
  against pinned block 52126164; re-pin by updating `FORK_BLOCK` + round IDs
  from `cast call` output if the pin ages out).
