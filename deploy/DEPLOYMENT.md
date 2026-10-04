# Mainnet deployment and verification runbook

Status: **draft, pre-launch**. There is no live mainnet deployment. This runbook
describes the reproducible deploy + verification procedure that must be
executed and recorded in the release manifest before Phase 13 rollout. Contract
source of truth: `packages/contracts/script/Deploy.s.sol`.

> Ownership note: the release manifest (`deploy/manifest*.json`) and the strict
> manifest verifier (`scripts/verify-manifest.mjs`, backed by
> `scripts/policy-hash.mjs` and `deploy/policies/*.json`) are owned by the
> deployment/manifest workstream. `deploy/manifest.example.json` demonstrates the
> required shape; the release run uses a filled copy. This runbook references
> these artefacts but does not modify them.

---

## 1. Prerequisites

### 1.1 Roles and keys (all must be distinct, real, and independently held)

| Role | Purpose | Notes |
|---|---|---|
| Broadcaster / `GOVERNANCE` | Deploys + registers the 8 policies | `Deploy.s.sol` requires the broadcaster to equal `GOVERNANCE` for registrations (or transfer governance first). |
| Governance timelock / multisig | Sole policy/role authority; 72h rotation, 24h unpause | Must be a multisig/timelock, not an EOA, for production. |
| `PAUSER` | Funding-only pause | Separate credential from governance. |
| `ADMISSION_SIGNER` | Signs `FundingAdmission` for every deal | Risk role; cannot settle/redirect. |
| `TREASURY` | Receives excess-only rescue | `rescueExcess` sends at most `balance - totalLiabilities()`. |
| Primary panel (≥3) | Ruling quorum, tier 0/1/2 | Disjoint from fallback. |
| Fallback panel (≥3) | Independent fallback quorum | Disjoint from primary (enforced at registration). |
| Veto panel (≥3, quorum 2) | Cancel-only veto | No award/recipient fields by construction. |
| Platform fee recipient | Per-deal `platformFeeRecipient` | Supplied in `DealTerms`, not a global role. |
| Arbitration cost recipient | Per-deal `arbitrationCostRecipient` | Supplied in `DealTerms`. |

Panel members must use hardware-backed signing procedures. Single-person
coverage of both primary and fallback is prohibited (`specs/policy-register.md`
P-15).

### 1.2 Environment variables

From `.env.example` and `Deploy.s.sol` (all optional; defaults are
broadcaster/local keys, which are **never** acceptable for mainnet):

```text
USDC_ADDRESS        # mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals, enforced)
FEED_ADDRESS        # Chainlink Base sequencer uptime feed
GOVERNANCE          # governance timelock/multisig (must equal broadcaster for registration)
PAUSER              # pauser address
ADMISSION_SIGNER    # admission signer address
TREASURY            # treasury address
PRIMARY_ADDR_0..2   # or PRIMARY_PK_0..2
FALLBACK_ADDR_0..2  # or FALLBACK_PK_0..2
VETO_ADDR_0..2      # or VETO_PK_0..2
BASE_RPC_URL        # deploy/fork RPC
ETHERSCAN_API_KEY   # source verification (Basescan)
```

`*_ADDR_<i>` wins over `*_PK_<i>`; if neither is set the script uses
deterministic local keys (anvil only). Addresses are preferred for production so
private keys never touch the shell.

---

## 2. Deploy

### 2.1 Local / anvil (default, deploys Mocks)

With no `USDC_ADDRESS`/`FEED_ADDRESS`, the script deploys `MockUSDC`
(EIP-3009 included) and `MockFeed`:

```text
anvil &
forge script packages/contracts/script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast
```

This default is **not** a production deployment. It exists so fork/local tests
have a harness (`packages/contracts/ABI.md` §5).

### 2.2 Base mainnet (pinned USDC + real sequencer feed)

Mainnet MUST pass the pinned token and real feed via env so no mock is deployed:

```text
$env:BASE_RPC_URL="https://<base-mainnet-rpc>"
$env:USDC_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
$env:FEED_ADDRESS="0xBCF85224fc0756B9Fa45aA7892530B47e10b6433"
$env:GOVERNANCE="<timelock>"
$env:PAUSER="<pauser>"
$env:ADMISSION_SIGNER="<admission>"
$env:TREASURY="<treasury>"
# PRIMARY_ADDR_0..2 / FALLBACK_ADDR_0..2 / VETO_ADDR_0..2 have been exported

forge script packages/contracts/script/Deploy.s.sol `
  --rpc-url $env:BASE_RPC_URL --broadcast `
  --verify --etherscan-api-key $env:ETHERSCAN_API_KEY
```

The script:

1. Deploys `MidmanPolicies(governance, pauser, admission, treasury, feed, primary, fb, veto)`.
2. Deploys `MidmanHub(usdc, policies)` — reverts if `usdc.decimals() != 6`.
3. Registers the 8 standard policies and logs every address and policy ID
   (`Deploy.s.sol:88-95`):

| Policy ID | ID input | Content hash input |
|---|---|---|
| FEE | `keccak256("MIDMAN.FEE.v1")` | `keccak256("MIDMAN.FEE.content.v1")` |
| CATEGORY | `keccak256("MIDMAN.CATEGORY.v1")` | `keccak256("MIDMAN.CATEGORY.content.v1")`, min inspection 3600s |
| READINESS | `keccak256("MIDMAN.READINESS.NONE.v1")` | `keccak256("MIDMAN.READINESS.content.v1")`, not required |
| EVIDENCE | `keccak256("MIDMAN.EVIDENCE.v1")` | `keccak256("MIDMAN.EVIDENCE.content.v1")` |
| BOND | `keccak256("MIDMAN.BOND.5USDC.v1")` | `keccak256("MIDMAN.BOND.content.v1")`, claimant/respondent 5,000,000 |
| ARBITRATION | `keccak256("MIDMAN.ARBITRATION.ALL.v1")` | `keccak256("MIDMAN.ARBITRATION.content.v1")`, tiers `0x07` |
| OUTAGE | `keccak256("MIDMAN.OUTAGE.v1")` | `keccak256("MIDMAN.OUTAGE.content.v1")`, grace 1800s, max 8 |
| CATASTROPHIC | `keccak256("MIDMAN.CATASTROPHIC.v1")` | `keccak256("MIDMAN.CATASTROPHIC.content.v1")` |

> If governance is a foreign timelock (not the broadcaster), deploy first, then
> `transferGovernance(timelock)`, then register the 8 policies from that address.
> The `keccak256("...content.v1")` values above are the script's placeholder
> inputs. The frozen release records the real content hashes computed from
> `deploy/policies/*.json` by `scripts/policy-hash.mjs` — the same hashes the
> strict verifier recomputes in §3.

---

## 3. Post-deploy verification (before any user funds)

1. **Verify source** for hub, policies and the linked library on Basescan
   (`--verify`), then confirm bytecode matches the frozen build (see
   `docs/release-checklist.md`).
2. **Fill the manifest addresses** in a copy of `deploy/manifest.example.json`,
   then run the strict verifier against that file:

   ```text
   node scripts/verify-manifest.mjs deploy/manifest.mainnet.json --strict
   # default path is deploy/manifest.example.json; also supports --json,
   # --policies=<dir>, --artifacts=<dir>
   ```

   Strict mode promotes every unresolved placeholder (token/feed/hub/library,
   role holders, bytecode hashes, release commit, freeze date) and missing build
   artifacts to a blocking failure. It also recomputes the 8 policy content
   hashes from `deploy/policies/*.json` via `scripts/policy-hash.mjs`, checks the
   EIP-712 domain (`MidmanEscrow`/`1`/8453/verifyingContract == hub), panel sizes
   (>=3), non-floating dependency pins, and — when `packages/contracts/out`
   artifacts exist — the keccak256 of each contract's `deployedBytecode`
   (`MidmanHub`, `MidmanPolicies`, `HubDispute`). Record the run in
   `docs/phase12-manifest.md`.
3. **Register/confirm the 8 policies** with the recorded content hashes from
   `deploy/policies/*.json` (recomputed by `scripts/policy-hash.mjs`) and confirm
   each `PolicyRegistered` event and the read-back values (`feePolicies`,
   `categoryPolicies`, …, `catastrophicPolicies`).
4. **Verify the domain separator and token address.** Confirm
   `hub.usdc() == USDC_ADDRESS` and that the EIP-712 domain is
   `MidmanEscrow/1/8453/<hub>`. The pinned digest vector is
   `packages/contracts/test/DigestParity.t.sol`; `actionDigest` must match the
   off-chain builder.
5. **Transfer roles to the timelock/multisig.** If the broadcaster was an EOA,
   `transferGovernance(timelock)` and hand over `PAUSER`, `ADMISSION_SIGNER`,
   `TREASURY`. Confirm pauser ≠ governance, admission signer cannot settle,
   primary/fallback panels are disjoint, and veto signer set is independent.
6. **Fund nothing until the checklist is green.** `fund` stays paused
   (`pauseNewFunding`) and no user funds are accepted until
   `docs/release-checklist.md` is fully signed off.
7. **Monitoring/alert destinations live.** Configure `ALERT_WEBHOOK_URL` and
   confirm the monitoring/alert paths from `docs/incident-runbooks.md` and
   `apps/worker`.

---

## 4. DO NOT proceed if

- `USDC_ADDRESS` or `FEED_ADDRESS` is unset (would deploy Mocks to mainnet).
- `USDC_ADDRESS` is not the pinned 6-decimal native USDC.
- The broadcaster does not equal `GOVERNANCE` and the 8 policies are not
  registered from the correct governance address.
- Any `*_ADDR_<i>` / `*_PK_<i>` resolves to the deterministic local default key.
- Primary and fallback panels overlap, or any panel has fewer than 3 members.
- `pauser == governance` or the governance key is a single EOA (no timelock).
- `scripts/verify-manifest.mjs --strict` does not pass, or bytecode does not
  match the frozen/reviewed build.
- Source verification fails or the domain separator / token address is wrong.
- Any Critical/High review finding is unresolved (`docs/release-checklist.md`).
- The bounty program and disclosure channels are not live
  (`docs/bug-bounty.md`, `SECURITY.md`).
- Monitoring/alert destinations are not live and staffed.
- `docs/release-checklist.md` is not fully green.

---

## 5. Roles summary after handover

| Control | Holder | Constraint |
|---|---|---|
| Governance / policies / role rotation | Timelock/multisig | 72h delay; append-only; no funded-deal rewrite |
| Pause new funding | `PAUSER` | Funding-only; cannot stop vested rights |
| Unpause | Governance | 24h timelock (`proposeUnpause`/`executeUnpause`) |
| Admission | `ADMISSION_SIGNER` | Deny new funding only; cannot settle/redirect |
| Excess rescue | Governance | At most `balance - totalLiabilities()`; sends to treasury only |
| Rulings | Primary/fallback panels | On-chain quorum 2-of-3 / 3-of-5; cancel-only veto |
