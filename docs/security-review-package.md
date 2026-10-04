# Midman V1 — External security review package (audit-readiness dossier)

Status: prepared 2026-10-04 for an independent review that has **not yet been
performed**. No third-party auditor has reviewed this codebase; no mainnet
deployment exists. This document describes the reviewed-scope candidate and the
evidence a reviewer can reproduce today. It deliberately claims no completed
audit and no live deployment.

Evidence baseline (verified on this checkout):

| Check | Command | Result |
|---|---|---|
| Spec/model | `node specs/validate-spec.mjs` | `PASS`, 567,700 model cases, `releaseBlockers: 9` (all 9 allocated RB-01..RB-09) |
| Node suites | `pnpm -r test` | 193 pass / 0 fail (api 72, web 47, worker 57, shared 10, store 2, chain 5) |
| Contract suites | `forge test` | 163 pass / 0 fail / 4 fork-skip (167 total) |
| Fork suites | `BASE_RPC_URL=... forge test` | 4 fork tests against pinned Base block 52126164 |

---

## 1. Scope for review

### 1.1 In scope (contracts)

All units are immutable; there are no proxies or upgrade paths.

| Unit | File | Role |
|---|---|---|
| `MidmanHub` | `packages/contracts/src/MidmanHub.sol` | Single custody address: funding, exits, claims, pause/rescue, the one EIP-712 domain |
| `HubDispute` | `packages/contracts/src/HubDispute.sol` | Dispute machine + settlement cores; executed by `DELEGATECALL` in hub context |
| `MidmanPolicies` | `packages/contracts/src/MidmanPolicies.sol` | Append-only policy registry, reviewer/veto panels with 72h epochs, role timelocks, outage ledger |
| `Finance` | `packages/contracts/src/Finance.sol` | Exact integer ledger math (internal library, inlined) |
| `DealTypes` | `packages/contracts/src/DealTypes.sol` | Shared structs, `MidmanDK` constants, EIP-712 typehashes, errors, events |

Key invariants a reviewer should attack:

- **Single hub custody.** The library holds no funds and runs only in hub
  storage context (`MidmanHub.sol:342-347`). Events are always attributed to the
  hub. Custody is never split per deal.
- **Exact-token funding.** `fund` requires `t.token == address(usdc)`,
  `t.custodyAddress == address(this)`, `t.factory == t.implementation == 0`,
  and takes `principal + prepaidBuyerFee` atomically via EIP-3009
  `receiveWithAuthorization`, or via a deal-bound signed `FundWithAllowance`
  intent (`MidmanHub.sol:168-340`). A raw pre-approved allowance cannot fund.
- **Immutable funded terms.** A funded `Deal` has no setters; policy IDs,
  quorum, exec delay and reviewer epoch are pinned at funding
  (`MidmanHub.sol:274-311`). The registry is append-only and rotation is
  epoch-gated (`MidmanPolicies.sol:170-268`).

### 1.2 In scope (application authorization, evidence privacy, signing/payment binding)

- **Wallet authorization.** Login is EIP-191/EIP-4361-style with the fixed
  purpose string `Midman sign-in only, no funds authorized`
  (`apps/api/src/auth.ts`); financial authorization uses distinct EIP-712
  primary types. Session cookies are httpOnly/Secure/SameSite=Lax and rotate on
  privilege change (`docs/security-baseline.md` §1).
- **Evidence privacy.** Evidence objects are AES-256-GCM encrypted with
  per-deal envelope DEKs; only `sha256(token)` invitations are stored; audit
  redaction covers `invitationToken`, `signature`, `sessionToken`, `secret`,
  `privateKey` (`docs/security-baseline.md` §2; `apps/api/src/evidence/`).
- **Signing/payment binding.** `paymentNonce = keccak256(abi.encode(dealId,
  agreementDigest, paymentSalt))`; agreement nonces, payment nonces, settlement
  nonces and ruling nonces are one-use; cross-deal replay is tested
  (`packages/contracts/test/Adversarial.t.sol`).

### 1.3 Out of scope / not yet evidenced

- No live Base mainnet deployment, no production addresses, no audit report.
- Hub-vs-vault custody benchmark not run (see §7).
- Real smart-wallet (EIP-1271) funding matrix not executed (see §7).
- Long-duration wall-clock soak; only local time travel.

---

## 2. Architecture summary

- **Hub custody (RB-06 default rule).** Single `MidmanHub` holds all
  `D + Qb + Qs` liabilities. The Phase 2 criterion says hub wins on a tie or
  no data; the benchmark that could overturn it has not been run, and no upgrade
  path exists. See `specs/phase2-architecture.md` §1 and `packages/contracts/ABI.md` §1.
- **EIP-712 domain.** `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`,
  name `MidmanEscrow`, version `1`, verifier = hub for every action
  (`MidmanHub.sol:77`, `:141-143`). `actionDigest(bytes32)` exposes exact
  digests for relayers/SDKs.
- **Delegatecall dispute library.** `HubDispute` is deployed as a linked
  library and invoked through the hub's forwarders so state, funds, domain and
  events stay on the custody address (`MidmanHub.sol:342-493`).
- **Immutable funded terms.** Policy registration is append-only; panels rotate
  behind a 72h timelock and only affect future queues; a validly queued ruling
  survives rotation unless vetoed inside its delay (P-07,
  `docs/phase9-rehearsal.md` R3b).
- **Fixed escape.** `escapeAt = disputeOpenedAt + 5,184,000` (60 days), never
  adjusted by the outage algorithm (`DealTypes.sol:207`, `MidmanHub.sol:596-600`).
- **Fixed-recipient pull claims.** `claimFor(dealId, kind)` pays the recorded
  recipient; effects-first and failure reverts only that claim
  (`MidmanHub.sol:496-506`).

---

## 3. Invariants and their evidence

| Invariant | Statement | Evidence |
|---|---|---|
| Solvency | `usdc.balanceOf(hub) >= hub.totalLiabilities()` after every sequence | `packages/contracts/test/Invariants.t.sol:35-37`; `totalLiabilities = escrow + bonds + claims` (`MidmanHub.sol:547-549`) |
| Conservation | `ghostFunded + ghostBonds == totalLiabilities + ghostClaimed` (donations excluded) | `packages/contracts/test/Invariants.t.sol:42-48`, handler `test/HubHandler.t.sol`; invariant config 64 runs × depth 20 (`foundry.toml:11-14`) |
| Fee/bond reference model | Independent plain-arithmetic model cross-checked against `Finance`: `earned = F*S/P`, `buyerFee = E*b/10000`, `Cb = floor(Qb*S/P)`, `Cs = floor(Qs*(P-S)/P)`, endpoints, ceil-quote `[0,10000)` slack, catastrophic odd unit to buyer | `packages/contracts/test/FinanceFuzz.t.sol:20-104`, `packages/contracts/src/Finance.sol:26-64` |
| EIP-1901 digest parity | Off-chain canonical-terms builder produces byte-identical struct hash and full EIP-712 digest (incl. domain) to the contract for a fixed vector | `packages/contracts/test/DigestParity.t.sol:63-81` (vector also in `apps/api/test/journey.test.mjs`) |
| Payment/agreement binding | Payment auth can never fund a different accepted deal; same-amount second-deal replay reverts | `test/MidmanHub.t.sol::testPaymentAuthCannotFundAnotherDeal`, `test/Adversarial.t.sol` |
| Ledger exactness at boundaries | Every `<`/`>=` edge at the exact second; stale settlement nonce | `packages/contracts/test/Boundaries.t.sol` (19) |
| Off-chain/chain parity | Same money vectors and adversarial branches through HTTP/auth layers; contract remains final arbiter | `apps/api/test/acceptance.test.mjs` (13), `docs/phase11-acceptance.md` |

Full requirement-to-test map: `packages/contracts/COVERAGE.md` §2.

---

## 4. Threat model summary → mitigations

From `specs/phase2-threat-model.md` §1, mapped to implemented controls:

| Vector | Control in code / ops |
|---|---|
| Buyer+seller subsidy collusion | Admission concurrency + $10k/24h pair caps, subsidy metrics (`apps/worker/src/capacity/`, P-14) |
| Malicious buyer late/repeated freeze | `< deadline` admission, permanent `disputeUsed`, lapse → T08 same anchor, no restore |
| Malicious seller false delivery / clock reset | One `markDelivered` + required manifest commitment; no clock reset (`HubDispute`) |
| Stolen wallet | No wallet replacement on funded deals; registry rotation only behind 72h timelock; login sig ≠ financial auth |
| Compromised reviewer | On-chain quorum 2-of-3 / 3-of-5, disjoint primary/fallback, epochs, cancel-only veto, `executeAt < escapeAt` |
| Compromised governance/admission | Admission can only deny NEW funding; funding-only pause; quorum replacement needs same quorum+delay; 72h rotation |
| Relayer/keeper front-run/censor | `expiresAt` + consumed nonces + phase checks; permissionless progression; payment bound to deal |
| Signature replay | One-use agreement/payment/settlement/ruling nonces; chainId+contract in domain |
| Accidental transfers | Only `fund`/`postBond` create liabilities; direct transfers are excess-only rescue (`MidmanHub.sol:539-544`) |
| Evidence omission/substitution | Delivery commitment at declaration; append-only manifest with prev-hash chain; signed receipts; reviewers rule on manifest only |
| RPC/indexer outage | Chain state authoritative; pending vs included vs safe/finalized; contract deadlines need no keeper/indexer |
| Aggregate splitting | Admission aggregate monitoring; compromise-loss analysis per panel key-set |

---

## 5. Dependency inventory

| Dependency | Version / pin | Use |
|---|---|---|
| OpenZeppelin Contracts | `5.0.2` | `EIP712`, `ECDSA`, `IERC1271`, `ReentrancyGuard`, `SafeERC20`, `Math.mulDiv` |
| Solidity | `0.8.26` (pinned, `foundry.toml:5-6`) | all contracts |
| Foundry / forge-std | forge 1.8.4, `lib/forge-std` | build + tests (tests only) |
| Native USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | escrow token, EIP-3009/approve paths |
| Chainlink Base sequencer uptime feed | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` (fork pin `test/Fork.t.sol:39`) | outage source |
| Node | `>=24` (`package.json`, `.node-version`) | api/web/worker/spec tooling |
| viem | `2.9.0` | digests, signing, chain reads |
| Fastify | `4.26.2` | API surface |
| TypeScript | `5.4.5` (strict) | apps |

Build config: `via_ir = true`, `optimizer_runs = 200` (`packages/contracts/foundry.toml`);
deployed sizes Hub 19,595 / Lib 18,211 bytes vs EIP-170 limit 24,576
(`packages/contracts/ABI.md` §status).

---

## 6. Known risks and limitations

1. **Custody choice not benchmarked (RB-06).** Hub is chosen under the
   documented default rule; the hub-vs-vault gas/isolation benchmark has not
   been run. It may overturn the choice before audit — no mainnet deployment
   exists, so nothing is locked in. `docs/phase11-acceptance.md` "Residual
   risks"; `packages/contracts/COVERAGE.md` §3.
2. **EIP-1271 smart-wallet matrix not executed.** The hub dispatches to
   `isValidSignature` at execution and the 1271 path was hit in a fork trial,
   but no real Safe/Coinbase-wallet/passkey funding flow has been run.
   Approve/transferFrom is the documented route until the matrix is run
   (pre-launch requirement). `COVERAGE.md` §3.
3. **Issuer token freeze / blacklist.** Modeled via a mock blocklist with
   liabilities preserved; an issuer-level event is an incident-runbook item
   (R8, `docs/incident-runbooks.md`), not a contract behavior.
4. **Off-chain metadata vs chain truth.** Terms text, chat, evidence and keys
   are private records; on-chain commitments are the truth for entitlements.
   A hash is a commitment, not proof of truthful delivery; projections never
   override a chain read (`docs/indexer-recovery.md` §1).
5. **via-IR TIMESTAMP e2e caveat.** Under `via_ir`, repeated `block.timestamp`
   derivations across `vm.warp` boundaries were CSE'd into a pre-warp value in
   one e2e harness (test-only). Production contracts never assume TIMESTAMP
   stability across calls; fixed with a `_now()` helper.
   `docs/phase9-rehearsal.md` "Defects found and fixed" #1.
6. **Bounded fuzz.** Unit fuzz 256 default, invariant 64×20; expand before audit
   if cheap (`COVERAGE.md` §3).
7. **Storage error mapping.** A blob-store I/O failure maps to HTTP 500, not a
   retryable 503 (documented residual gap, `docs/phase11-acceptance.md`).
8. **No live deployment and no completed audit.** Any production claim is
   premature until Phase 13 rollout.

---

## 7. Reproduce all evidence

From the repository root (PowerShell shown; use `forge` from the pinned
toolchain):

```text
# 1. Specification / financial reference model (567,700 cases)
node specs/validate-spec.mjs

# 2. All Node suites (193 tests)
pnpm -r test

# 3. Contracts: build sizes + full suite (163 pass, 4 fork-skip)
#    run from packages/contracts, or pass --root
forge build --sizes
forge test

# 4. Fork integration (4 tests) against pinned Base block 52126164
$env:BASE_RPC_URL="https://mainnet.base.org"; forge test
# (bash equivalents: export BASE_RPC_URL=...; forge test)

# 5. Per-app node suites if isolating
pnpm --filter @midman/api test
pnpm --filter @midman/web test
pnpm --filter @midman/worker test

# 6. Reproducible dependency install (do NOT run against a dirty CI cache)
pnpm install --frozen-lockfile
```

Fork re-pin procedure when block 52126164 ages out: update `FORK_BLOCK`,
`DOWN_ROUND`, `DOWN_START`, `UP_START` in `packages/contracts/test/Fork.t.sol`
from `cast call` output (`packages/contracts/COVERAGE.md` §4).

---

## 8. Reviewer orientation

- Start with `packages/contracts/ABI.md` (transition→implementation map T01–T26)
  and `specs/policy-register.md` (approved P-01..P-15).
- The security-critical math is small and self-contained:
  `packages/contracts/src/Finance.sol` (65 lines).
- The threat model's frozen schemas live in `specs/phase2-threat-model.md` §2 and
  are pinned in `packages/contracts/src/DealTypes.sol:222-264`.
- Open questions the team wants answered are enumerated in §6 above and in
  `packages/contracts/COVERAGE.md` §3.
