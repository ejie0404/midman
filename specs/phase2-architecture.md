# Phase 2 — Architecture decision record (DRAFT, prototype results pending)

Status: DRAFT 2026-10-03. Phase 1 approved (v0.2.0-phase1-approved). This file bounds the two permitted Phase 2 experiments (P-16). It makes NO production contract choice yet.

Toolchain note: Node v24 available; `forge`/`cast` NOT installed in this environment. Gas/fork numbers below are TBD and must be measured before the Phase 2 gate. Do not fabricate them.

## 1. Hub vs minimal-vault prototype scope (disposable, not production)

Build two throwaway Foundry prototypes with identical financial semantics (L-FUND/L-BOND/L-NORMAL/L-CATASTROPHIC/L-CLAIM per $P-01..P-04$):

- A. Hub: single `MidmanHub` holds all `D + Qb + Qs` liabilities, `dealId => Deal` mapping, fixed recipients, pull claims.
- B. Clones: immutable `DealVault` implementation + `Factory` deploying deterministic minimal proxies (EIP-1167 or ERC-1967 fixed, NO upgradeable beacon). Deploy + initialize + fund atomically in one transaction; validate `custodyAddress` == predicted address from signed `dealId/nonce/salt`.

Measure on Base fork (pinned USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`):

1. Deployment: hub deploy; factory + implementation deploy; per-deal clone deploy.
2. Funding: `fund` with exact `D=P+B0` (buyer-paid, seller-paid, split; 5 USDC min; odd-unit fee).
3. Dispute lifecycle: `openDispute` → `escalate` (real bond) → `postRespondentBond` → `advanceToPrimary` → `queuePrimaryRuling` → `executeRuling`.
4. Settlement/claim: `finalizeAfterTimeout`, `mutualSettlement`, `catastrophicEscape`, `claimFor` per recipient (isolated failure test).
5. Indexing: logs-only projection replay from deployment block; reorg rollback check (orphaned `markDelivered` event).
6. Collateral: fresh-token bond vs `ReserveExistingClaim` transfer; double-reservation attempt (must revert).
7. Isolation: one deal's pause/exploit must not move another deal's liabilities (hub shared-code risk vs vault per-address risk).
8. Roles: pauser / arbitration / veto / relay / governance / fee-recipient separation; admission signer cannot settle.

Decision criteria (record why, majority needed):

- Gas: median + p95 for fund/dispute/claim; per-deal clone overhead vs hub amortization at 100 / 10k / 100k deals.
- Isolation: vault wins iff a hub accounting bug class is shown to be containable per-address without reintroducing shared-freeze via centralized fee/bond buckets. Otherwise hub wins on simplicity.
- Indexing/ops: single-address subscription (hub) vs factory + N-vault discovery (clones); reconcile `tokenBalance >= liabilities` globally AND per-vault if clones.
- Upgrade safety: clones must prove fixed implementation (no beacon, no `delegatecall` to mutable target); hub must prove funding-only pause cannot touch funded rights.
- Default if measurements tie: hub (fewer deployments, simpler indexer, no address-prediction binding risk).

Result: TBD — fill gas table + decision + rationale here before Phase 4. No Phase 4 contract work starts until this section is filled and reviewed.

## 2. Deployed USDC verification checklist (fork, must pass)

Against pinned native Base USDC, on fork block pinned in manifest at release:

- [ ] `decimals()` == 6 (5 USDC == 5,000,000; 0.50 == 500,000).
- [ ] `receiveWithAuthorization` (EIP-3009) exists and enforces payee-only consumption; `nonce` unconsumed → consumed atomically inside `fund`.
- [ ] `approve`/`transferFrom` fallback path works; authorization consumption validated (no replay of same payment nonce into second deal).
- [ ] Exact-amount funding: `D` else revert (no partial, no top-up, no direct-transfer credit).
- [ ] Transfer failure modes: pauser/blacklist revert propagates; failed `claimFor` reverts only its claim update, preserves liability.
- [ ] Wallet matrix: EOA, Safe (EIP-1271 contract signatures validated at execution), Coinbase Smart Wallet / passkey signer, WalletConnect signers — record which funding paths (3009 vs approve) each supports.

## 3. Payment-to-deal binding (locked design, test vectors in Phase 5)

Neither payment authorization may fund a different accepted deal even if amounts match:

```text
paymentNonce = keccak256(abi.encode(dealId, agreementDigest, paymentSalt))
fund(bytes agreement, bytes sigBuyer, bytes sigSeller,
     EIP3009Auth { payer, recipient=custodyAddress, amount=D, validAfter, validBefore, nonce=paymentNonce, v,r,s })
  require(tokenNonceNotConsumed(paymentNonce) OR approve-allowance path with same binding check)
  require(payer == buyerAddress; recipient == custodyAddress; amount == D)
  require(agreementDigest matches both signatures; revocation/expiry/use checked)
  receiveWithAuthorization(...) INSIDE fund (same tx) → atomic; else revert all
```

- Approve path: `transferFrom(payer, custodyAddress, D)` inside `fund` after checking `allowance >= D` AND a separately signed `FundingIntent { dealId, agreementDigest, paymentNonce, expiresAt }` binding the allowance to this deal. Raw pre-approved allowance without intent MUST NOT fund.
- Test vectors required: same-amount second deal replay (must revert), front-run payment auth by third party (payee check must block), expired/invalid-interval auth (must revert), wrong-recipient auth (must revert).

## 4. Domain / custody binding (one exact choice, no duality at release)

- Hub: `EIP712Domain { name "MidmanEscrow", version "1", chainId <Base mainnet id>, verifyingContract <hub> }`; `factory=0, implementation=0, custodyAddress=hub`. Funding rejects `token != pinned USDC`.
- Clones: domain verifier = factory (agreement verification) OR predicted vault exclusively — pick ONE before audit; `factory` + `implementation` pinned nonzero; `custodyAddress` must equal `predictDeterministicAddress(factory, dealId, nonce, salt)`; deploy+init+fund atomic or revert.
- Testnet/mainnet domains disjoint. Deployment manifest pins: chainId, hub/factory/implementation, USDC address, signer registries, policy hashes. `fund` rejects mismatched `chainId/verifyingContract/token`.

Gate: fill Sections 1–2 measurements + select Section 4 branch, then external design review before Phase 4.
