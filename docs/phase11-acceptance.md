# Phase 11 Acceptance — Adversarial end-to-end through every browser-facing layer

Status: 2026-10-04. Acceptance suite: `apps/api/test/acceptance.test.mjs` — **13/13 pass**
(API suite total **72 pass / 0 fail / 0 skipped**, 19 suites). Toolchain: Node 24.14,
TypeScript 5.4 strict built to `dist`, `node:test` `.mjs`, viem 2.9.

Scope: create `apps/api/test/acceptance.test.mjs` and this document; append the file to
the `test` script in `apps/api/package.json`. No source, spec, or contract files were
modified.

## How the suite is wired

- **One Fastify app per scenario, every route group registered directly** (never
  `buildServer`/`server.ts`): `registerRoutes`, `registerEvidenceRoutes`,
  `registerCategoryRoutes`, `registerMessageRoutes`, `registerCommitmentRoutes`,
  `registerReviewRoutes`, fed a synthetic `RouteDeps`/`ReviewRouteDeps`.
- **`MemoryStore` + a mutable scripted `ChainReader` stub.** `getDeal` returns deal
  records the test mutates as the acceptance progresses, so `/deals/:id/status`,
  reviewer deadline/escalation math, and relay preconditions all read "chain" state.
  The stub also serves `getClaim`, `getLiabilities`, `getTokenBalance`, block/receipt
  methods, `isPanelMember`, and `getBondPolicy`.
- **Auth is the exact shared scheme** from `src/evidence/access.ts`: viem keys sign the
  EIP-191 message `${METHOD}\n${req.url}\n${sha256hex(bodyBytes)}\n${expiry}` in
  `x-wallet-address` / `x-wallet-expiry` / `x-wallet-signature`. Multipart bodies are
  signed over `sha256("")` per the access spec.
- **Worker ops code is the same compiled dist the worker loads** (relative imports):
  `processRelayJob` (relay preconditions), `progressionPass`/`escapePass`/`dueAction`,
  `runMonitoringPass`, `AdmissionControls`/`aggregateExposure`, `AbuseControls`. This
  crosses the API boundary into the exact operational paths a browser triggers
  indirectly. No `pnpm install`, no commits.
- All money is asserted as exact decimal strings / `bigint`; secrets are asserted to be
  absent from response bodies.

## Scenario matrix

| # | Scenario | Layers exercised | Result |
|---|---|---|---|
| a | Happy path create→invite→accept→sign→fund→deliver→inspect→release→claims | draft lifecycle, relay outbox + worker fund precondition, chain-first status, delivery form, quote/summary | PASS |
| b | False delivery: S=0 award, buyer full+refund, zero fee/arb | relay openDispute, multipart evidence (both parties), assign/award/approvals/queue-ruling, execute, claims | PASS |
| c | Partial S=70% proportional bond costs | reviewer award derivation, exact `floor(Q·S/P)` costs, refunds, quote claims | PASS |
| d | Lapsed escalation + exhausted second dispute | `dueAction`/`progressionPass` lapse, relay `openDispute` precondition (`not-disputable`) | PASS |
| e | Missing respondent completes on claimant evidence | evidence manifest single-uploader, award with `Qs=0`, quorum, queue | PASS |
| f | Mutual settlement countersign + stale nonce | `settlement-proposals` create/list/accept, EIP-712 Mutual, re-accept 409, superseded-nonce 400 | PASS |
| g | Veto cancel-only → fallback | veto endpoint (primary + fallback origins), no award fields, chain-flip to `FALLBACK_REVIEW` | PASS |
| h | Revoked terms: fund path unavailable | revoke-note intent, chain-flip `revokedTerms`, funded-only relay skip (`not-funded`) | PASS |
| i | Forwarded invitation bound to intended counterparty | `accept` counterparty binding (409) | PASS |
| j | Failed services degrade; secret inputs rejected | missing reader/hub/chainId 503s, oversize evidence 413, I/O storage failure non-crash, message/evidence secret 400 with finding codes | PASS |
| k | Subsidized-case abuse | admission caps (pair/pod/protocol/category/min), abuse rate+duplicate+payload controls, monitoring solvency + sponsor-cap alerts | PASS |
| l | 60-day escape + token-wide claim failure | `escapePass`, escalation windows, `escape-eligible` alert, `claimFor` skipped (`claim-unreadable`) preserving liability | PASS |
| m | Frozen EIP-712 schema parity | evidence-commitment payload field order + selector; Ruling/Mutual/Veto field order vs Phase 2 threat model | PASS |

## Exact ledger vectors verified (smallest USDC units)

Common: `P = 100_000_000` (100 USDC), duration 46,800 s → 50 bps, `buyerFeeBps = 10_000`.

- **(a) S = P** — `F = 500_000`, prepaid `500_000`, funded `100_500_000`, effective
  `50` bps; seller claim `100_000_000`, buyer claim `0`, earned fee `500_000`.
- **(b) false delivery, S = 0, no respondent bond** — buyer claim `100_500_000`
  (principal + prepaid refund), seller claim `0`, earned fee `0`, `Cb = Cs = 0`
  (zero arbitration revenue).
- **(c) S = 70_000_000, Qb = Qs = 5_000_000** — earned fee `350_000`, buyer claim
  `30_150_000`, seller claim `70_000_000`, `Cb = 3_500_000`, `Cs = 1_500_000`
  (`== Qb·S/P`, `Qs·(P−S)/P`), buyer bond refund `1_500_000`, seller bond refund
  `3_500_000`, arbitration cost `5_000_000`.
- **(e) missing respondent** — `Cb = Cs = 0`, buyer claim `100_500_000`, fee `0`;
  manifest has exactly one entry (claimant).
- **(k) admission** — three 5-USDC deals aggregate to `15_000_000` exposure; the
  $10,000/24h pair cap, 20-protocol and 5-per-pod concurrency caps, category
  allowlist, and 5-USDC floor all reject with the expected `AdmissionReason`.
- **(l) escape** — `escapeAt = disputeOpenedAt + 5_184_000`; `secondsToEscape <= 0`;
  `escapePass` enqueues `catastrophicEscape`; monitoring emits `escape-eligible`.

## On-chain cross-reference

The off-chain acceptance is complementary to the contract-level suite already shipped:

- `packages/contracts/test/e2e/Arbitration.t.sol` — **13/13 rehearsals** (R1 full
  primary/both bonds/both-side evidence; R2 veto → independent fallback; R3a/R3b
  epoch rotation; R4 veto bounds; R5 global ruling nonce; R6 missing respondent
  subsidy; R7 lapsed/no-escalation exhaustion; R8 late respondent bond; R9 deadlock →
  escape; X1/X2/X3 escape cutoff edges). Recorded in `docs/phase9-rehearsal.md`.
- `packages/contracts/test/e2e/Journey.t.sol` — **5/5 journeys** (A happy path, B full
  dispute partial S=70%, C missing-respondent win + catastrophic escape, D
  relayer-submitted calldata equivalence, E mutual settlement + stale-offer revert).
  Recorded in `docs/phase7-acceptance.md`.

The off-chain suite proves the same money vectors and adversarial branches through the
HTTP/auth layers; `Arbitration.t.sol`/`Journey.t.sol` prove the contract remains the
final arbiter (real EIP-712 recovery, quorum, nonces, escape cutoff, token transfers).

## Defects found / fixed

Honest account. All fixes are confined to the new test file; no protocol/source defect
was found and no source file was edited.

1. **(test-harness, fixed) fund precondition needed chain state.** Scenario (a) first
   ran the relay `fund` job without any stub deal, so the worker returned
   `skipped: deal-unreadable` instead of `unsigned: unfunded`. Fixed by seeding an
   **unfunded** stub record before the precondition check, then flipping it funded —
   which is also what the scenario is meant to prove.
2. **(test-harness, fixed) defensive undefined store.** An intermediate revision of
   scenario (b) called `processRelayJob` with an undefined store in a throwaway probe;
   removed in favour of the real store and a strict assertion on
   `openDispute -> unsigned`.
3. **(product observation, not fixed — out of scope) evidence storage I/O failure
   returns 500, not 503.** `registerEvidenceRoutes.replyError` defaults unknown errors
   to 500, so a blob-store write failure (e.g. `EVIDENCE_DIR` un-writable) surfaces
   `500` with a generic message, while oversize uploads correctly degrade to `413`.
   The test asserts the server stays up (`GET /categories` still 200) and documents the
   desired `503` mapping as a residual gap. A source edit was out of the allowed scope.
4. **(product observation, not fixed — contract is the gate) no off-chain
   `revokedTerms` precondition on `fund`.** The worker `checkPreconditions` treats
   `fund` as always admissible for an unfunded deal, so revocation is enforced only
   on-chain (`MidmanHub.fund` reverts `Revoked()`; `testFundRejectsRevoked`). Scenario
   (h) therefore asserts the observable chain-flip (status stays `draft`,
   `revocation-noted`) and that funded-only relay actions become `not-funded`.

## Residual risks

- **Process-local registries.** Evidence manifests, reviewer cases/awards/approvals,
  and settlement proposals are in-memory in the acceptance run; pg wiring
  (migrations 001–003) is not exercised here. Durability/restore is covered separately
  by `apps/api/test/evidence.test.mjs` restore drills and `docs/phase10-recovery.md`.
- **Scripted chain.** The stub deliberately fabricates phases/timestamps/claims; live
  RPC lag, reorgs, and token transfer semantics are proven at the contract/fork level
  (`Fork.t.sol`, `Arbitration.t.sol`), not here.
- **Fund/revocation off-chain gap (#4).** A client that submits the unsigned `fund`
  calldata learns about revocation only via the on-chain `Revoked()` revert. Consider a
  relay precondition that reads `isRevoked(agreementDigest)` for `fund` in a later
  hardening pass.
- **Storage error mapping (#3).** Blob-store operational failures should ideally map to
  `503` (retryable) rather than `500`.
- **Oversize upload test allocates ~25 MB** in memory; correct for an acceptance guard,
  not representative of load/DoS limits.

## Verify

```text
pnpm --filter @midman/api build      # tsc -p tsconfig.json            -> pass
pnpm --filter @midman/api typecheck  # tsc -p tsconfig.json --noEmit   -> pass
node --test test/acceptance.test.mjs # run from apps/api               -> 13 pass / 0 fail
pnpm --filter @midman/api test       # full API suite                  -> 72 pass / 0 fail
```
