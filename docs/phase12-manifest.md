# Phase 12 — Release manifest, policy records and the freeze gate

This document ties the Phase 12 deliverable together: the human-reviewed policy
records, the release manifest, the canonical hashing function, and the
pre-deploy verifier. Together they make "deployed configuration equals the
reviewed release" a checkable property instead of a promise.

## Components

| Artifact | Path | Role |
|---|---|---|
| Policy records (8) | `deploy/policies/{fee,category,readiness,evidence,bond,arbitration,outage,catastrophic}.json` | Canonical, human-reviewed `{ id, version:1, description, values, sourceRefs }` records. Every money/second quantity is an exact integer string. |
| Canonical hasher | `scripts/policy-hash.mjs` | `policyContentHash(record)` = `keccak256` over a deterministic serialization (recursively sorted keys, no whitespace, exact integers). Exports `canonicalize`, `loadPolicyRecords`, `hashAll`. |
| Release manifest | `deploy/manifest.example.json` | Full schema instance: network, contracts, roles, policy hashes, EIP-712 domain, bytecode hashes, pinned dependencies, release commit, unresolved list. |
| Verifier | `scripts/verify-manifest.mjs` | Pre-deploy gate. Recomputes everything and compares against the manifest; exit 0 only when all checks pass. |
| Tests | `scripts/policy-hash.test.mjs`, `scripts/verify-manifest.test.mjs` | Determinism, record loading, reconciliation, failure and placeholder behavior. |

## Why canonical hashing

The on-chain registry (`packages/contracts/src/MidmanPolicies.sol`) is
append-only and stores a `contentHash` per registered policy. Funded deals pin
those policy IDs, so a later re-registration can never rewrite an existing
deal's economics. For that guarantee to hold, the off-chain record that a
reviewer approves, the hash registered on-chain, and the hash recorded in the
release manifest must all be the same 32 bytes.

`policyContentHash` is deliberately independent of JSON formatting:

- object keys are sorted at every depth, so reordering a record's fields does
  not change the hash;
- there is no insignificant whitespace;
- quantities are exact integer strings, so `10800` seconds is never confused
  with a float or a different unit;
- changing any value or the record `id` changes the hash.

`node scripts/policy-hash.mjs` prints the eight approved hashes. Those exact
values are copied into `deploy/manifest.example.json` under `policyHashes`. The
verifier recomputes them from `deploy/policies/*.json` and fails if any of the
eight differ, are missing, or if a record is not `version: 1`.

## Registration must use the recorded hashes

The deployment/freeze sequence is:

1. Freeze the audited source and lockfile; set `releaseCommit` (40-hex) and the
   `freezeDate` in the manifest.
2. Build the contracts from the frozen commit and record the `keccak256` of
   each `deployedBytecode.object` for `MidmanHub`, `MidmanPolicies`, and
   `HubDispute` under `bytecodeHashes`.
3. Fill every deployment address (policies, hub, dispute library, domain
   `verifyingContract`) and every role/panel member.
4. Run `node scripts/verify-manifest.mjs --strict` until it exits 0.
5. Register each policy on-chain with the governance timelock using the **same
   content hash** recorded in the manifest (`registerFeePolicy`,
   `registerCategoryPolicy`, `registerBondPolicy`, `registerArbitrationPolicy`,
   `registerOutagePolicy`, ...).
6. Verify the emitted `PolicyRegistered(id, contentHash)` events match the
   manifest before allowing any funding admission.

Step 5 is the contract-level trust boundary: the manifest's `policyHashes`
block is the allowlist the deployment script reads; nothing may be registered
that is not in it.

## The verifier is the pre-deploy gate

`scripts/verify-manifest.mjs` prints a table of checks and exits non-zero while
any hard check fails. Checks performed:

- schema shape (required top-level keys);
- `network.name == "base"`, `network.chainId == domain.chainId == 8453`;
- `contracts.usdc == 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and
  `contracts.sequencerFeed == 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`;
- all 8 policy records load (`version: 1`, exact-string quantities) and their
  recomputed hashes equal `policyHashes`;
- `domain.name == "MidmanEscrow"`, `domain.version == "1"`;
- `bytecodeHashes` equal recomputed keccak256 of `deployedBytecode.object`
  when the Foundry artifacts exist (otherwise reported `artifacts-missing`);
- role panels have at least three members and non-placeholder role addresses
  are valid checksum-agnostic addresses;
- `dependencies` are pinned (no floating ranges);
- `releaseCommit` is 40-hex, `freezeDate` is set.

**Placeholders are warnings, not failures, in non-strict mode.** This lets the
example manifest — and an in-progress deployment — be checked early without
pretending it is release-ready. `--strict` promotes every unresolved or
`artifacts-missing` result to a blocking failure, which is the mode used for
the actual freeze.

## What remains unresolved before mainnet

`deploy/manifest.example.json` carries `deploymentStatus:
"UNVERIFIED_PLACEHOLDER"` and an explicit `unresolved` array. As of writing:

1. **RB-06 — concrete addresses.** Policies, hub, dispute library,
   `domain.verifyingContract`, and all role holders are placeholders pending the
   Phase 2 hub-vs-clone decision and fork verification of native USDC
   (`0x8335...2913`), payment binding, and custody/domain rules.
2. **Reviewer identities.** Primary, fallback, and veto panels must be
   independently staffed and keyed; primary and fallback must be disjoint.
   Placeholder entries are not deployable authorities.
3. **Audit completion.** External contract and application security review
   findings must be closed; remediation evidence is required before
   `deploymentStatus` can leave `UNVERIFIED_PLACEHOLDER`.
4. **Release commit and freeze date.** Must point at the audited source and the
   `pnpm-lock.yaml` used to produce the recorded bytecode hashes.
5. **Bytecode hashes.** Recomputed from artifacts built from the frozen commit
   (currently reported as placeholder/unresolved by the verifier because the
   manifest intentionally ships `"0x..."` values).

Until all five are resolved, non-strict verification passes by design to
support staging, but `--strict` fails and no policy should be registered and no
funding admission enabled.

## Reproduce

```sh
node scripts/policy-hash.mjs                 # print the 8 approved hashes
node scripts/verify-manifest.mjs             # non-strict: pass + unresolved warnings
node scripts/verify-manifest.mjs --strict    # freeze mode: fail while unresolved
node --test scripts/*.test.mjs               # determinism + verifier behavior
```
