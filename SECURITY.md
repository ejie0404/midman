# Security policy

## Reporting a vulnerability

**Do not report security vulnerabilities in public issues, pull requests,
discussions, or social channels.**

Send reports to the private security channel below. Replace the placeholder with
the live, monitored address before launch:

```text
Security contact: <security@… — set before launch>
Encrypted report / PGP: <… — set before launch>
```

Include, where possible: affected component (contract/API/evidence), a
description, a proof of concept or reproduction steps, impact, and whether
funds or user data are currently at risk.

Expected response:

- **Acknowledgement** within 24 h for reports that may affect funds or privacy
  (48 h otherwise).
- **Triage and initial severity** within 72 h for potential Critical/High.
- Coordinated disclosure on a 90-day default timeline, or sooner once a fix is
  shipped and verified. We will not publish your identity without consent.

## Supported versions

Only the current released, audited-in-review deployment is supported:

| Version | Supported |
|---|---|
| Current release candidate (Phase 12 freeze) | Yes |
| Testnet / dev / `Mock*` deployments and test files | No |
| Any pre-release or unaudited build | No |

There is no live mainnet deployment yet; concrete addresses are published in the
release manifest when Phase 13 rollout begins.

## Please do not publicly disclose

Give us a reasonable window to investigate and remediate before any public
disclosure. Do not test against other users' deals, do not access evidence you
are not assigned to, and do not move funds beyond the minimum needed to prove
the issue. Good-faith research within scope is protected by the safe-harbour
terms in `docs/bug-bounty.md`.

## More detail

Scope, severity rubric, response SLAs, ownership, disclosure policy, safe
harbour and bounty funding live in [`docs/bug-bounty.md`](docs/bug-bounty.md).
The audit-readiness evidence package is in
[`docs/security-review-package.md`](docs/security-review-package.md).
