# Deploy-readiness and redesign plan

Audit date: 2026-10-16, against `main` @ `0cc5475` plus uncommitted health/evidence work.
Baseline: `forge test` 244 pass / 4 fork-skipped; all Node suites pass
(shared 10, store 60, chain 24, worker 127, api-client 46, api 239, web 120).

The codebase is well engineered (exact integer finance, EIP-712 everywhere,
fail-closed route permissions, durable auth state, encrypted evidence). What
keeps it from production is a small number of real defects, missing
operational pieces, and a UI built for developers rather than traders.

## Findings

### Critical

**C-1 Outage watermark can brick every deadline.** `effectiveDeadline` reports
`available=false` unless `lastAuditedRound` matches the sequencer-feed head,
and only `reportOutage(roundId == lastAuditedRound + 1)` advances it.
- Nothing calls `reportOutage`: the worker has no keeper. After the first Base
  sequencer outage, `markDelivered`, `finalizeAfterTimeout`,
  `refundForNonDelivery`, `escalate`, `lapseDispute`, `queueRuling`, … all
  revert `OutageUnknown` until someone reports it by hand.
- `executeFeed()` rotates the feed but does not reseed the watermark: the old
  feed's round number is compared to the new feed's head forever.
- Chainlink proxy round IDs are `(phaseId << 64) | aggregatorRound`. An
  aggregator upgrade jumps the round ID, so `+1` can never match again.
- Effect: funds only leave via voluntary release/refund/mutual settlement or
  the 60-day escape (escalated deals only). Non-delivered deals are stuck.

### High

- **H-1 Client chooses fee recipients and policy IDs.** `POST /drafts` takes
  `platformFeeRecipient`, `arbitrationCostRecipient`, `policyIds`, `hub`,
  `token`, `chainId` from the request body. A seller can route the platform fee
  or arbitration costs to themselves, or pick a weaker category policy than the
  displayed category.
- **H-2 Admission is manual.** Every deal needs an operator-signed
  `FundingAdmission`, and the fund page asks the buyer to paste JSON. Needs an
  admission service (caps, pair limits, sanctions screen, recipient/policy
  check, kill switch).
- **H-3 No HTTP abuse controls.** No rate limiting; `/auth/challenge` stores
  challenges that are never pruned unless verified (unbounded memory on a 4 GB
  box); `/tx/:hash/status` and `/deals/:id/confirmation` burn RPC quota
  anonymously; anonymous `/drafts` creation.

### Medium

- Anonymous drafts allow anyone who knows the draft ID to issue a new invite
  (overwriting the real one) and take the counterparty slot when no hint is set.
- No security headers (CSP, `frame-ancestors`, HSTS) on a wallet-signing UI.
- `logger: false`: no request logs for incident forensics.
- `transferGovernance` is single-step (typo bricks governance and unpause).
- Wallets: `window.ethereum` only. No WalletConnect/EIP-6963/Coinbase Smart
  Wallet; the 3009 path is `v,r,s` only (smart wallets need the USDC v2.2
  `bytes signature` overload); undeployed smart wallets need ERC-6492.
- Landing copy is wrong: says "Arbitration 2-of-3" (panels are 5/5/3, quorum
  2 or 3) and "Inspection 1h–30d" (contract max is 14 days).
- `outageSaturated` never clears once set.
- Dev `docker-compose.yml` exposes Postgres/Redis/MinIO with default creds.

### Low / cleanup

Dead `authOrDirect` helper; unused `terminalPolicyVersion`; `escapeAt` returns
a value for undisputed deals; stale `apps/api/migrations`; unused
`ioredis`/`bullmq`; viem 2.9.0 is old; redundant 5-field "MidmanDraft"
acceptance signature; uncommitted WIP.

### Operational blockers (from your own docs, still open)

Independent audit; 13 distinct panel keys (5 primary + 5 fallback + 3 veto, all
disjoint, hardware-backed); Safe multisig governance; bug bounty; legal review
(custody/arbitration fees, game-account ToS, sanctions screening).
Decide panel size now: if you cannot staff 13 people, change the floors
before the audit, not after.

## Phases

1. **Critical fixes.** Watermark successor logic across phases, feed reseed,
   outage keeper + alert in the worker, server-pinned recipients/policies.
2. **Backend gaps.** Admission service; rate limits + challenge pruning;
   auth-required drafts with long opaque IDs; headers; structured logs with
   redaction; `GET /me/deals`; deadline notifications (email/Telegram);
   two-step governance; smart-wallet signatures.
3. **UI/UX redesign** (below).
4. **Infra on the VPS**, staging against Base Sepolia.
5. **Testnet beta** with real users, E2E, load test on the VPS.
6. **External audit + bounty**, fix findings, freeze.
7. **Guarded mainnet**: admission caps (per-deal and TVL), allowlist, raise
   gradually.

## VPS layout (2 vCPU / 4 GB / 35 GB)

| Service | Notes | RAM budget |
|---|---|---|
| Caddy | TLS, HTTP/3, security headers | 64 MB |
| web | Next `output: "standalone"` | 256 MB |
| api | Fastify | 256 MB |
| worker | relay, indexer, keeper, monitoring | 256 MB |
| Postgres 16 | `shared_buffers=512MB`, internal network only | 768 MB |
| ClamAV (clamd) | `ConcurrentDatabaseReload no` | ~1.3 GB |
| OS + headroom | + 2–4 GB swapfile | ~500 MB |

- Drop Redis and MinIO (unused / replaceable). Evidence → Cloudflare R2 via
  the existing S3 client, keeping the 35 GB disk for Postgres and images.
- Cloudflare in front (proxy, WAF, rate-limit rules, Turnstile on draft
  creation). Two RPC providers for `RpcPool`; never run a Base node here.
- Build images in GitHub Actions → GHCR → `docker compose pull && up -d`.
  Never `next build` on the VPS. Migrations as a one-shot job.
- Hardening: SSH keys only, ufw 22/80/443, fail2ban, unattended-upgrades,
  ports bound to the internal network, non-root containers, log rotation.
- Backups: nightly age-encrypted `pg_dump` → R2/B2 (30 days); KEK and receipt
  key escrowed offline; monthly restore drill.
- Hot keys on the VPS only: sponsor (gas, small balance, daily cap), receipt
  signer, admission signer, pauser (optional circuit breaker). Never
  governance, panel, veto or treasury keys.
- Alerts (`ALERT_WEBHOOK_URL` → Discord/Telegram): watermark lag, relay
  failures, sponsor ETH low, liabilities vs balance, disk > 80%, backup failure.
- Host `public/emergency.html` separately (Cloudflare Pages) so users can
  claim/finalize if the VPS is down.

## UI/UX redesign

**Visual system.** Light-first with a real dark mode; trustworthy fintech
rather than neon-terminal.
- Fonts via `next/font`: Geist Sans (UI), Geist Mono with tabular numerals
  (amounts, addresses), optional Instrument Serif for marketing headlines.
- Tokens: bg `#F8F8F6`, surface `#FFFFFF`, text `#111418`, muted `#5B6470`,
  border `#E3E5E8`, primary `#1F4FD8`; dark bg `#0B0D10`, surface `#12151A`,
  primary `#6E8BFF`. Phase colors: draft gray, funding/funded blue, inspecting
  teal, disputed amber, arbitration violet, released green, refunded slate.
- Tailwind v4 + CSS variables + Radix primitives instead of inline style
  objects; TanStack Query for polling.

**Flows.**
1. Wallet: wagmi + Reown AppKit/RainbowKit (EIP-6963, WalletConnect, Coinbase
   Smart Wallet), sign-in on connect.
2. "My deals" dashboard with status chips, next action, countdowns.
3. Create-deal wizard: what & how much → timeline presets with fee-tier hints
   → invite link. No hub/token/chain/address fields.
4. Invite page: plain summary, risks, connect & accept in one signature.
5. Signatures: one DealTerms signature per party; buyer funds with one payment
   signature (or a batched approve+fund for smart wallets); admission is
   invisible.
6. Deal room: stepper, role-aware "next action" card, amounts ("you'll
   receive"), outage-adjusted countdowns, activity feed, evidence, dispute
   centre. Fund/deliver/inspect/claim become panels, not pages.
7. Human-readable errors for custom reverts; pending vs included toasts with
   explorer links.
8. Mobile: collapsible nav, bottom action bar. WCAG AA, `aria-live` tx status,
   reduced motion.
9. Separate `/ops` console (admission overrides, review queue, pause, relay,
   watermark); remove "Review queue" from public nav.
10. Trust content: fee calculator, FAQ, verified contract links, audit report,
    status page, Terms/Privacy/prohibited items.
