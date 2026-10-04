# Phase 12 — External review and release preparation record

Status: **in progress**. This is the Phase 12 record defined in
`implementation-plan.md` ("Obtain independent contract security review … prepare
the release"). It ties together the review dossier, the reporting program, the
deployment runbook and the go/no-go checklist. It makes no claim that an audit
has been completed or that a mainnet deployment exists.

Companion documents:

- Audit-readiness dossier: `docs/security-review-package.md`
- Reporting program: `docs/bug-bounty.md` + `SECURITY.md`
- Deployment runbook: `deploy/DEPLOYMENT.md`
- Go/no-go gate: `docs/release-checklist.md`

---

## 1. Review scope

Independent review is sought for the exact financial implementation and the
money-path application surface documented in
`docs/security-review-package.md` §1:

- Contracts: `MidmanHub`, `HubDispute`, `MidmanPolicies`, `Finance`
  (`packages/contracts/src/`).
- Governance and policy registration (append-only registry, 72h rotation,
  cancel-only veto, funding-only pause).
- Signature and payment binding (EIP-712 domain `MidmanEscrow/1`, EIP-3009 and
  deal-bound allowance funding, one-use nonces).
- Chosen custody architecture (single hub; default rule, benchmark pending).
- Protocol dependencies (native USDC, Chainlink Base sequencer feed).
- Application security: wallet authorization, reviewer access, evidence
  privacy, indexer/relay paths.

Explicitly out of scope for this phase: prototype/mock code, test files, and
third-party dependencies (see `docs/security-review-package.md` §1.3).

---

## 2. Findings process

1. **Intake.** Findings are received through the private channel in `SECURITY.md`
   and recorded with severity, component, reproduction and impact.
2. **Severity.** Critical/High/Medium/Low per the rubric in
   `docs/bug-bounty.md` §3 (crypto-escrow-specific impacts: theft of escrowed
   funds, settlement bypass, quorum/governance bypass, replay/payment
   substitution, denial of claims/escape, evidence privacy).
3. **Blocking rule.** **Critical and High findings block release**, as do any
   findings the team assesses as release-blocking even if rated Medium (e.g. a
   conservation or solvency gap). No mainnet funding opens while any blocker is
   open.
4. **Non-blocking rule.** Medium/Low findings are triaged into a disposition
   record and either fixed or explicitly accepted with rationale and owner.
5. **Remediation evidence.** Each fix is followed by the relevant re-run:
   `forge test` (and fork suite), `pnpm -r test`, and
   `node specs/validate-spec.mjs`. The remediation commit and test delta are
   recorded against the finding.
6. **Ownership.** Security lead owns disposition; arbitration operations
   co-signs any finding that implicates reviewer independence or an active case
   (`docs/bug-bounty.md` §4).

---

## 3. Freeze procedure

After the review candidate is accepted (all Critical/High closed, medium/low
triaged):

1. **Pin the commit.** Tag the exact reviewed commit and record its hash as the
   release candidate.
2. **Pin dependencies.** Commit `pnpm-lock.yaml` and the contract library pins
   (OpenZeppelin 5.0.2, solc 0.8.26, forge-std) and confirm
   `pnpm install --frozen-lockfile` and `forge build --sizes` reproduce.
3. **Freeze policy records.** Record the 8 registered policy IDs and their
   content hashes (`deploy/policies/*.json`, recomputed by
   `scripts/policy-hash.mjs`), the panel sets, quorums and delays, and the
   token/feed/domain addresses in the release manifest
   (`deploy/manifest*.json`; record the verified run in
   `docs/phase12-manifest.md`).
4. **No post-audit change without re-review.** Any change to reviewed contracts,
   governance, policy registration, signature/payment binding or the application
   money path after the freeze requires re-review of the affected scope before it
   can ship. Emergency fixes follow the same rule via expedited re-review; there
   is no silent post-audit edit path.
5. **Reproducibility.** Re-run the full evidence set from
   `docs/security-review-package.md` §7 on the frozen commit and attach results.

---

## 4. Release artifacts

| Artifact | Location / owner |
|---|---|
| Reviewed release commit (pinned) | to be recorded on freeze |
| Dependency lock + toolchain pins | `pnpm-lock.yaml`, `packages/contracts/foundry.toml` |
| Verified source/bytecode | Basescan verification via `Deploy.s.sol` `--verify` |
| Deployment manifest | `deploy/manifest*.json` + verified run in `docs/phase12-manifest.md` |
| Strict manifest verifier | `scripts/verify-manifest.mjs --strict` (with `scripts/policy-hash.mjs`, `deploy/policies/*.json`) |
| Deployment + verification runbook | `deploy/DEPLOYMENT.md` |
| Policy records (8 IDs + content hashes) | registered by `Deploy.s.sol`; recorded in manifest |
| Role assignment + handover record | governance timelock/multisig, pauser, admission, treasury, panels |
| Emergency controls + recovery package | `docs/incident-runbooks.md`, `packages/chain/src/recovery.ts`, `apps/web/public/emergency.html` |
| Monitoring/alert destinations | `ALERT_WEBHOOK_URL` + `apps/worker` monitoring |
| Review report + remediation log | to be produced by the independent reviewer and the team |
| Bounty program | `docs/bug-bounty.md` (funding to be set pre-launch) |
| Go/no-go checklist | `docs/release-checklist.md` |

---

## 5. Completion gate

Phase 12 is complete only when:

- Independent review of the exact reviewed scope is complete and its report is
  delivered.
- All Critical/High/release-blocking findings are resolved, with re-run evidence;
  medium/low findings are triaged with owners.
- The release, dependency versions and policy records are frozen, and the
  reviewed build reproduces from the pinned commit.
- Deployed bytecode and configuration match the reviewed release, verified via
  the strict manifest verifier.
- Roles and emergency controls are assigned to real timelock/multisig/panel
  addresses; monitoring and alert destinations are live.
- Drills are re-run against the deployment; the bounty program is funded and
  live; user-facing disclosures are published.
- `docs/release-checklist.md` is fully green.

Current state: **the independent review has not been performed, RB-06 mainnet
addresses/config are not instantiated, and no live deployment exists.**
Therefore the Phase 12 gate is **not met** and mainnet funding must not open.
Per `implementation-plan.md`, external review and release gates must complete
before unrestricted mainnet admission (Phase 13).
