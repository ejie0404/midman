# Round-2 remediation finding tracker

Base commit: `4191ab7`. Status reflects the tree as of this document.
Status legend: **Open** / **Implemented** (code + regression present) /
**Verified** (runtime/integration evidence) / **Release-blocking** (external).
A finding is closed only when the affected runtime path is corrected and a
regression/integration/recovery check proves it — not merely because a helper
exists.

Approved financial rules are unchanged: quote CEIL, catastrophic odd unit to
the buyer, proportional partial bond costs, unilateral full bond refunds,
bounded mutual choices.

| # | Finding (affected files) | Owner | Change | Regression | Integration evidence | Status |
|---|---|---|---|---|---|---|
| 1 | Outage calc shortens/loses protected windows; order-based history; missing history → earlier deadline (`HubDispute.sol`, `MidmanPolicies.sol`) | Contract eng | Least-fixpoint `E = D0 + downtime(A,E) + grace(A,E)`; append-only ledger + `prunedBefore` + permanent dedupe + saturation→`available=false`; deep feed validation | `test/OutageDeadline.t.sol` (cross-deadline, in-extension, cascading, duplicate-after-prune, overflow→unavailable, malformed feed, boundary, escape) | `forge test` 243 pass; invariant suite | Verified |
| 2 | No authoritative deadline views; escape must stay fixed | Contract eng | `effectiveDeadlines(bytes32)` returns 7 deadlines + `available`; `escapeAt` fixed | `OutageDeadline.t.sol` view + escape-cutoff tests | forge | Verified |
| 3 | Panel rotation can shrink 5-member panel to 3 | Contract eng | 5/5/3 floors at construction + rotation; disjoint/distinct | `PanelValidation.t.sol` (5→3 rejected) | forge | Verified |
| 4 | Route authorization gaps / private leaks (`auth/*`, `routes.ts`) | API/security | Declarative `ROUTE_PERMISSIONS` (fail-closed); creator bound to session; party/operator/reviewer classes | `apps/api/test/authorization.test.mjs` (coverage + denials) | api suite 223 pass | Verified |
| 5 | Invitation token not enforced; non-durable auth state | API/security | Atomic CAS redemption via `AuthPersistence`; store-backed adapter wired at boot | `authorization.test.mjs`; `createStoreAuthPersistence` transactional redeem | api suite | Verified |
| 6 | Reviewer self-assignment; global reviewer fallback | API/security | Strict assigned-reviewer access; arbitration-only assignment; audit trail | `authorization.test.mjs` | api suite | Verified |
| 7 | `pg` undeclared; multiple stores; swallowed writes; non-authoritative reads | Storage | `pg` declared in `@midman/store`; one store per service; awaited writes; versioned CAS; authoritative reads | `packages/store/test/pg-integration.test.mjs` (gated), `apps/api/test/durability.test.mjs` | store 60 pass; pg integration 11/11 (local PG) | Verified |
| 8 | Relays: ambiguous retries, nonce races, no receipt finality (`worker`, `indexer`) | Worker eng | Leases + ownership verify; tx-identity-before-broadcast; durable nonce coordinator; budget reservation; receipt finality; serialized indexer | `apps/worker/test/phase5.test.mjs`, `apps/api/test/indexer-phase5.test.mjs` | worker 120 pass | Verified |
| 9 | Evidence: key race, content-binding, scan gating, rotation/restore | API/security | Metadata-bound upload signing; atomic finalize; quarantine; persisted keyring + resumable rotation; restore drill | `apps/api/test/evidence-phase6.test.mjs` + web evidence tests | api 223 pass | Verified |
| 10 | Browser unusable: no session, invitation not sent, schema drift, empty policies, random settlement nonce | Web/product | Same-origin proxy; session UI; token acceptance; shared client validators; real policy ids/recipients; required live settlement nonce | `apps/web/test/phase4.test.mjs`, `apps/api/test/phase4.test.mjs` | web 120 pass | Verified |
| 11 | Release verification checks ids not values; library unpinned; ABI drift; skippable gates | Release eng | Value checks, governance/panel/tier completeness, HubDispute pin, deterministic ABI + CI drift gate, mandatory `verify-release.mjs` | `scripts/verify-deployment.test.mjs`, `scripts/verify-release.test.mjs` | verify-release PASS; anvil e2e 56 checks | Verified |
| 12 | Independent review not performed | External | — | — | — | **Release-blocking** |
| 13 | RB-06 mainnet addresses/domain/policy instantiation + custody benchmark | Release eng | — | — | — | **Release-blocking** |
| 14 | Live infrastructure drills (restore/on-call/reviewer-loss) | Ops | Code-level drills exist | `apps/worker/src/drills/*` | anvil e2e; PG integration run | Implemented (live rehearsal open) |
| 15 | `uuid` moderate advisory | Release eng | Unused v3/v5/v6 `buf` path; accepted | `docs/dependency-pins.md` | `pnpm audit` 0 critical/0 high | Verified (accepted) |

## Gate evidence (this tree)

- `pnpm -r test`: 603 pass / 0 fail (+1 skipped pg-gated).
- `pnpm test:scripts`: 87 pass.
- `forge test`: 243 pass / 4 fork-skip.
- `node specs/validate-spec.mjs`: PASS (567,700).
- `node scripts/verify-release.mjs --optional`: PASS.
- `node scripts/e2e-anvil.mjs`: deploy + live verification PASS (56 checks).

## Remaining release-blocking work (external)

Independent third-party contract + application security review of the exact
release candidate; concrete Base mainnet addresses/roles/domain/policy
instantiation and the hub-vs-vault benchmark; live restore/on-call drills.
See `docs/release-checklist.md`.
