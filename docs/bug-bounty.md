# Midman V1 — Vulnerability reporting and bug bounty program

Status: **draft for launch**. The program is not yet live. The bounty pool line
in §7 is a placeholder that must be set before mainnet funding is opened.
Reporting channels are placeholders that must be replaced with live, monitored
addresses before launch (see `SECURITY.md`).

---

## 1. Purpose

Give security researchers a clear, safe way to report vulnerabilities in
Midman's crypto-escrow contracts and money-path application code, and to be
rewarded for real risk reduction without extortion or public exposure.

---

## 2. Scope

### 2.1 In scope — smart contracts

Once deployed, at the addresses published in the release manifest:

| Contract | Source |
|---|---|
| `MidmanHub` (custody, funding, exits, claims, pause/rescue) | `packages/contracts/src/MidmanHub.sol` |
| `HubDispute` (dispute machine / settlement, DELEGATECALL library) | `packages/contracts/src/HubDispute.sol` |
| `MidmanPolicies` (policy registry, panels, roles, outage ledger) | `packages/contracts/src/MidmanPolicies.sol` |
| `Finance` (ledger math, inlined) | `packages/contracts/src/Finance.sol` |

**Assets at risk:** native USDC held in hub custody, per-deal entitlements and
pull claims, the platform/arbitration fee recipients, governance/pauser/panel
roles, and the integrity of the fixed 60-day escape.

### 2.2 In scope — application (money-path / privacy)

- Wallet authorization and session handling (`apps/api/src/auth.ts`).
- Signing/payment binding and canonical term generation (`apps/api/src/`,
  `packages/shared`, `packages/chain`).
- Evidence privacy, encryption, receipts and manifests
  (`apps/api/src/evidence/`).
- Reviewer access control and quorum enforcement helpers (contract enforces
  quorum; console must not bypass it).
- Indexer/relay paths that could misstate or block a user right
  (`apps/api/src/indexer.ts`, `apps/worker/src/relay.ts`).

### 2.3 Out of scope

- Pre-deployment `Mock*` contracts and all test files in
  `packages/contracts/test/`.
- Issues in third-party dependencies (report upstream; OpenZeppelin 5.0.2,
  viem, Fastify, Next.js, etc.) unless Midman integrates them unsafely.
- Findings that require a compromised operator key, malicious governance, or
  physical device compromise.
- Testnet/dev-only deployments and shortened test policies.
- Availability/DoS with no loss or lock of funds and no privacy breach.
- Phishing, social engineering, spam, and physical attacks.
- Gas-griefing with negligible cost.
- Known issues already documented in
  `docs/security-review-package.md` §6 (custody benchmark, EIP-1271 matrix,
  issuer freeze, via-IR test caveat, storage 500→503 mapping).

---

## 3. Crypto-escrow severity rubric

| Severity | Impact examples (midman-specific) |
|---|---|
| **Critical** | Theft or permanent loss of escrowed USDC; **settlement bypass** (force a payout inconsistent with signed terms); **quorum/governance bypass** (execute a ruling, rotate panels, or move roles without required signatures/delay); mint a fabricated claim; drain via an exit function. |
| **High** | **Replay / payment substitution** (fund or settle two deals with one authorization; fund a different deal than signed); permanent denial of a claim or of the fixed escape for a funded deal; compromise of evidence confidentiality for unassigned parties; unbounded or griefable bond/fee accounting that breaks conservation. |
| **Medium** | Temporary denial or delay of a right without fund loss; incorrect-but-recoverable accounting; role/authorization gaps requiring additional preconditions; findings that bypass off-chain controls the contract enforces but with limited impact. |
| **Low** | Informational correctness, event/indexer mismatches, gas inefficiency with no security impact, hardening recommendations. |

Reviewers receive a severity recommendation; Midman assigns the final severity
based on demonstrable impact on funds, rights, and privacy.

---

## 4. Response SLAs and ownership

| Stage | Critical | High | Medium | Low |
|---|---|---|---|---|
| Acknowledgement | 24 h | 48 h | 5 business days | 10 business days |
| Triage + severity decision | 72 h | 5 business days | 10 business days | 30 business days |
| Fix / mitigation target | emergency change control | next release | backlog | backlog |
| Status update cadence | every 24–48 h | every 5 days | every 10 days | on request |

Ownership:

- **Security lead — primary owner.** Intake, triage, severity, remediation
  coordination, disclosure and reward decision. The security lead is the only
  role that may declare a finding resolved for bounty purposes.
- **Arbitration operations — secondary.** Owns disputes/governance impact
  assessment, reviewer-key/panel exposure, and evidence-privacy impact. Must
  co-sign any Critical/High disposition that implicates reviewer independence
  or an active case.
- Contract changes follow the freeze procedure in `docs/phase12-release.md`
  (no post-audit change without re-review).

---

## 5. Disclosure policy

- Coordinated disclosure. Reporters must give Midman a reasonable window before
  publishing; default **90 days** from acknowledgement, or sooner if a fix is
  shipped and verified, or by mutual agreement.
- Midman will not publish reporter identity without consent.
- Emergency disclosure is allowed if an active exploit is being used against
  live funds; in that case notify Midman immediately and use the private
  channel first.
- Do not test against other users' deals, do not access evidence you are not
  assigned to, and do not move or destroy funds beyond the minimum provable
  PoC. Use your own funded test deals on a testnet where possible.

---

## 6. Safe harbour

Midman will not pursue civil action or report to law enforcement for good-faith
security research that: (a) stays within the in-scope targets in §2; (b) avoids
privacy violations, data destruction and service degradation; (c) does not
access funds other than your own test deals except to the minimum extent needed
to prove an issue; (d) reports promptly and does not extort; and (e) complies
with applicable law. This safe harbour is void if a reporter's actions are
malicious or if the reporter knew of the issue and used it for gain.

---

## 7. Rewards and funding

Impact-based rewards, at Midman's discretion, scaled by severity and quality of
the report:

| Severity | Indicative range (USDC) |
|---|---|
| Critical | TBD |
| High | TBD |
| Medium | TBD |
| Low | Recognition / TBD |

**Bounty funding line (placeholder to be set pre-launch):**

```text
Bounty pool: <TBD — set before mainnet funding opens>
Currency:    <TBD, e.g. USDC>
Wallet/custody: <TBD>
Program start: <TBD>
```

An unfunded or unset bounty pool is a release checklist item
(`docs/release-checklist.md`); funding must be in place before users can fund
real deals.

---

## 8. Reporting channel (placeholder)

```text
Security contact: <security@… — set before launch>
PGP key / secure form: <… — set before launch>
```

Do **not** open a public issue or post details in chat/social channels. See
`SECURITY.md` for the top-level reporting instructions.
