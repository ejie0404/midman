# Phase 3 — Security baseline

Status: baseline 2026-10-03. Implements the Phase 3 gate with pointers to code.
Financial rules: `specs/policy-register.md` (approved P-01..P-15). Schemas: `specs/phase2-threat-model.md`.

## 1. Authentication and sessions

- Wallet-domain sign-in only (`apps/api/src/auth.ts`): EIP-191/EIP-4361-style challenge
  with `domain + chainId + wallet + nonce + expiresAt` and fixed purpose string
  `Midman sign-in only, no funds authorized`. Verifiers MUST reject login
  signatures as financial authorization (distinct EIP-712 primary types).
- Sessions: httpOnly + Secure + SameSite=Lax cookies, server-side store, rotation on
  privilege change, idle + absolute expiry. Re-authentication required for
  sensitive operational actions (role changes, unpause, admission overrides).
- Participant authorization is deal-bound: every state-changing call checks the
  caller against the signed `DealTerms` participants/recipients, not just the session.

## 2. Invitations and private data

- 256-bit bearer tokens (`apps/api/src/invitations.ts`), `base64url(randomBytes(32))`.
  Only `sha256(token)` is stored (`migrations/001_init.sql`). Raw tokens never touch
  logs, telemetry, or third-party scripts (`audit.ts` redaction set covers
  `invitationToken`, `signature`, `sessionToken`, `secret`, `privateKey`).
- HTTP posture for invite links: `no-referrer`, `no-store`, `noindex`, minimal
  previews. Post-acceptance, records are restricted to bound participants +
  assigned reviewers. Rotating an invitation never mutates signed terms.

## 3. Roles and secrets (P-15)

- Six isolated roles — pauser, arbitration, veto, relay, governance, feeRecipient —
  with separate credentials and least privilege (`OPERATIONAL_ROLES` in `auth.ts`).
  Reviewer signing follows hardware-backed procedures (runbook in Phase 9); primary
  and fallback signer sets are disjoint from day one.
- Secrets live in environment/KMS only (`.env.example` lists names, never values).
  No secrets in repo, logs, or error responses. CI uses placeholder/dev values.

## 4. Storage, backup, RPC, relay

- Encrypted S3-compatible evidence store (MinIO locally via `docker-compose.yml`),
  versioned buckets, per-environment KMS keys. Targets: RPO ≤ 15 min for private
  metadata, RTO ≤ 4 h (drills in Phases 8/10). Reconstructable chain projections
  stay separate from private records (terms text, chat, evidence, keys).
- RPC adapters: ordered `BASE_RPC_URLS` with failover + health checks; contract
  state stays authoritative for payments/entitlements; display tracks
  pending vs included vs safe/finalized.
- Relayer (`apps/worker/src/index.ts`): `relay` queue submits third-party
  transactions with zero discretion over recipients/awards; idempotency keys are
  the signed nonces/digests. Direct-call client access is always available, so no
  critical right (especially `openDispute`) depends on the relayer, the API, or
  the indexer.

## 5. Gate evidence

- `pnpm install --frozen-lockfile` reproduces the workspace (pinned deps, Node ≥ 24).
- `pnpm -r build|typecheck|test` green; `node specs/validate-spec.mjs` PASS.
- `/health` reports degraded (not failed) without DB/Redis; migrations require
  `DATABASE_URL` and are explicit (`pnpm db:migrate`).
- `forge build` / `forge test` prove the contract pipeline on the Phase 3 stub
  (full escrow in Phase 4, invariants in Phase 5).
