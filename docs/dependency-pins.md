# Dependency Pins (Midman V1 release freeze)

Every runtime and build dependency is pinned to an exact version. Floating
ranges (`^`, `~`, `*`, `x`, `latest`) are rejected by the release-manifest
verifier (`scripts/verify-manifest.mjs`), which fails the `dependencies` check
if any appear. This file records the pinned set, why each is needed, and how it
may change.

Source of truth for the manifest copy is `deploy/manifest.example.json`
(`dependencies`). Workspace declarations live in each `package.json`; the
`pnpm-lock.yaml` is the reproducible resolution.

## Foundation

| Dependency | Pinned version | Why | Update policy |
|---|---|---|---|
| Node.js | `24.14.1` (`.node-version`, `engines.node >=24`) | ESM `.mjs` tooling, `node:test`, native `fetch`, BigInt/exact-integer money handling | Major upgrade is a release-gate change: re-run all suites and forks, re-review. Patch/minor within 24: re-run CI, no manifest change required until freeze. |
| pnpm | `9.12.3` (`packageManager`) | Workspace linking, frozen lockfile installs in CI | Only bump with a lockfile regeneration and a full `--frozen-lockfile` install check. |
| TypeScript | `5.4.5` | Shared type checking across api/web/worker/packages | Bump only after `pnpm -r typecheck` and builds pass; no behavior-affecting compiler flags change without review. |

## Solidity / Foundry

| Dependency | Pinned version | Why | Update policy |
|---|---|---|---|
| solc | `0.8.26` (`foundry.toml`) | Contract ABI/storage layout baseline for `MidmanHub`, `MidmanPolicies`, `HubDispute` | Compiler version is part of the reviewed release; changing it invalidates bytecode hashes and requires re-audit/re-verification. |
| Foundry (forge) | toolchain pinned in CI (`foundry-rs/foundry-toolchain@v1`) | Build/test of the contracts package | Re-freeze by recording the toolchain version and rebuilding artifacts; bytecode hashes in the manifest must be recomputed. |
| Optimizer | `optimizer = true`, `optimizer_runs = 200` | Deployment gas vs. runtime gas balance; part of reviewed bytecode | Any change alters bytecode and requires a new build + bytecode-hash review. |
| via-IR | `via_ir = true` | Enables the reviewed high-level pipeline; affects bytecode | Same rule as optimizer settings. |
| OpenZeppelin Contracts | `5.0.2` (submodule) | Reviewed EIP-712, ECDSA, ERC20, SafeERC20, ReentrancyGuard primitives | Only re-pin to a reviewed tag; re-run all Foundry suites and re-freeze bytecode hashes. |
| forge-std | `1.17.0` (submodule) | Test harness (`Test`, `Vm`, assertions, fork cheats) | Test-only; bump allowed off the freeze path, but record the new pin. |

## JavaScript / TypeScript runtime

| Dependency | Pinned version | Used by | Why | Update policy |
|---|---|---|---|---|
| viem | `2.9.0` | web, api, worker, `@midman/chain`, hash scripts | Typed chain access, ABI encoding, `keccak256` for policy/bytecode hashes | Security updates require re-review and a re-run of hashing + manifest verification so recorded hashes are unchanged. |
| @walletconnect/ethereum-provider | `2.25.0` | web | WalletConnect v2 EIP-1193 provider (mobile wallets via QR/deep link); loaded on demand, only offered when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set | Signs nothing itself; bump with a wallet smoke test. Pulls `zod` as a viem peer, which re-keys the viem install variant in the lockfile. |
| @coinbase/wallet-sdk | `4.3.7` | web | Coinbase Wallet / Smart Wallet (passkeys) EIP-1193 provider; loaded on demand | Bump with a wallet smoke test (sign-in, DealTerms signature, deposit). |
| next | `15.5.27` | `@midman/web` | Frontend framework/build | Patch updates via security review; major requires full user-journey re-acceptance. |
| react | `19.3.0` | `@midman/web` | UI runtime | Pair with `next` upgrades only. |
| react-dom | `19.3.0` | `@midman/web` | DOM renderer | Pair with `react`. |
| fastify | `5.12.5` | `@midman/api` | HTTP API server | Security updates reviewed against the acceptance suite before bump. |
| @fastify/multipart | `9.4.0` | `@midman/api` | Evidence upload handling | Must move with `fastify`; re-run evidence tests. |
| @aws-sdk/client-s3 | `3.1146.0` | `@midman/api` | Encrypted evidence object storage (S3-compatible) | Security updates re-reviewed; verify restore drill still passes. |
| pg | `8.11.3` | `@midman/api` | PostgreSQL client for migrations/reads | Re-run migrations + store tests on bump. |
| ioredis | `5.3.2` | api, worker | Redis client for BullMQ queues/locks | Pair with `bullmq`. |
| bullmq | `5.4.2` | `@midman/worker` | Durable worker/queue orchestration | Re-run worker/reliability/capacity suites on bump. |

## Dev/build-only

| Dependency | Pinned version | Used by | Why |
|---|---|---|---|
| @types/node | `20.12.12` | api, web, worker, packages | Node type definitions |
| @types/pg | `8.10.9` | `@midman/api` | `pg` types |
| @types/react | `18.3.3` | `@midman/web` | React types |

## Local infrastructure images

These are development-only compose images; production equivalents are pinned at
deploy time and recorded in the deployment manifest/tooling.

| Image | Pinned tag | Why |
|---|---|---|
| postgres | `16.4` | Local API/store database |
| redis | `7.4` | Local queue backend |
| minio/minio | `RELEASE.2024-08-03T04-33-14Z` | Local S3-compatible evidence storage |

## Advisory assessment

`pnpm audit` reports **0 critical, 0 high, 0 low, 1 moderate**. The single
moderate advisory is explicitly assessed and accepted here:

| Advisory | Package | Dependency path | Disposition |
|---|---|---|---|
| GHSA-xvch-5gv4-984h / `1119441`: uuid missing buffer bounds check in v3/v5/v6 when `buf` is provided | `uuid@9.0.1` | `apps/worker > bullmq@5.4.2 > uuid@9.0.1` | **ACCEPTED (unused code path)** |

**Rationale.** The vulnerable code is the optional `buf` output parameter of
the v3/v5/v6 generators. `bullmq@5.4.2` imports only the v4 generator and calls
it with no output buffer:

```js
// node_modules/.pnpm/bullmq@5.4.2/.../dist/cjs/classes/{flow-producer,queue,worker}.js
const uuid_1 = require("uuid");
const jobId = ... || (0, uuid_1.v4)();
this.token = (0, uuid_1.v4)();
this.id = (0, uuid_1.v4)();
```

No v3/v5/v6 call site exists in the dependency graph, so the missing bounds
check is unreachable. `uuid@9.0.1` is therefore not exploitable in this
codebase and no forced upgrade is applied (an override to `uuid@11` would be an
unreviewed transitive lift against `bullmq`'s CommonJS import and is out of
scope for this freeze). The advisory is re-checked on every dependency bump and
must be re-triaged if any dependency starts using v3/v5/v6 with a `buf`
argument.

## Update policy

1. No floating ranges anywhere. The verifier rejects `^`, `~`, `*`, `x`,
   `latest`, and `next` in the manifest `dependencies` block.
2. Security updates are applied only after re-review, then `pnpm install`
   regenerates `pnpm-lock.yaml` and CI runs `pnpm install --frozen-lockfile`,
   all package tests, and the contract fork suite.
3. Any dependency that changes compiled Solidity bytecode (solc, Foundry,
   optimizer/via-IR, OpenZeppelin) invalidates `bytecodeHashes` and must be
   followed by a rebuild and a manifest verification pass.
4. Any dependency that could alter canonical hashing (viem) requires a re-run
   of `node scripts/policy-hash.mjs`; recorded policy hashes must be unchanged
   or the change is treated as a new policy version.
5. Bumps land outside a freeze window. During a freeze the manifest
   `releaseCommit` is immutable until a new reviewed release is cut.
