// Explicit route-permission register (Round-2 Phase 2, gap #1).
//
// Authorization used to be hook-matching with a `default: protectedRoute =
// false` branch, so any route not explicitly listed was silently public. This
// table is the single source of truth: `registerAuthGuards` looks up
// `${METHOD} ${req.routeOptions.url}` here and FAILS CLOSED — a registered
// route with no entry is denied (401) for non-operators and logged as a config
// error at startup. `PUBLIC` is never implicit.
import type { OperatorRole } from "./permissions.js";

export type RouteAccess =
  | "public"
  | "authenticated"
  | "creator"
  | "creator-or-party"
  | "party"
  | "party-or-reviewer"
  | "reviewer"
  | "reviewer-queue"
  | "operator"
  | "accept"
  | "deal-status"
  | "relay-submit"
  | "assignment"
  | "recusal";

export interface RoutePermission {
  readonly access: RouteAccess;
  /** Operator roles allowed when access === "operator". */
  readonly roles?: readonly OperatorRole[];
  readonly note?: string;
}

export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/**
 * Frozen register. Every route registered by routes.ts (incl. journey),
 * evidence/categories/messages/review routes, the auth routes, and /health
 * MUST appear here. Coverage is asserted by test/authorization.test.mjs.
 */
export const ROUTE_PERMISSIONS: Readonly<Record<string, RoutePermission>> = Object.freeze({
  // ---- auth (public by construction) ----
  "POST /auth/challenge": { access: "public", note: "issue a login challenge" },
  "GET /auth/challenge": { access: "public", note: "issue a login challenge" },
  "POST /auth/verify": { access: "public", note: "verify login signature -> session" },
  "POST /auth/logout": { access: "public", note: "clears/revokes the caller's own session" },
  "GET /auth/session": { access: "public", note: "session introspection" },
  "GET /health": { access: "public", note: "liveness probe" },
  "GET /health/live": { access: "public", note: "liveness probe" },
  "GET /health/ready": { access: "public", note: "readiness probe (200 only when safe for traffic)" },
  "GET /config/deal-defaults": {
    access: "public",
    note: "deployment-derived public policy binding; contains no private data",
  },

  // ---- drafts ----
  "POST /drafts": { access: "authenticated", note: "creator is bound to the session wallet" },
  "POST /drafts/:id/invite": { access: "creator", note: "only the creator may rotate/issue an invite" },
  "POST /drafts/:id/accept": { access: "accept", note: "invitation-token redemption + counterparty assignment" },
  "POST /drafts/:id/claim": { access: "authenticated", note: "binds an unclaimed draft on first authenticated access" },
  "GET /me/deals": { access: "authenticated", note: "the session wallet's own deals" },
  "GET /drafts/:id/terms": { access: "creator-or-party" },
  "GET /drafts/:id/summary": { access: "creator-or-party" },
  "GET /drafts/:id/download": { access: "creator-or-party" },
  "GET /drafts/:id/quote": { access: "creator-or-party" },
  "POST /drafts/:id/signatures": { access: "party" },
  "POST /drafts/:id/deal-signatures": { access: "party" },
  "POST /drafts/:id/admission": { access: "operator", roles: ["admission"] },
  "POST /drafts/:id/admission/request": { access: "party", note: "automated admission; risk rules decide" },
  "POST /drafts/:id/revoke-note": { access: "party" },
  "POST /drafts/:id/readiness-payload": { access: "party" },
  "GET /drafts/:id/funding-bundle": { access: "party" },
  "GET /drafts/:id/funding-status": { access: "party" },
  "POST /drafts/:id/relay-fund": { access: "party" },

  // ---- chain-first deal reads ----
  "GET /deals/:dealId/status": { access: "deal-status", note: "party/creator, or anonymous chain-only fields" },
  "GET /deals/:dealId/confirmation": { access: "public", note: "chain-only confirmation levels; no draft contents" },
  "GET /deals/:dealId/recovery": { access: "party", note: "recovery bundle contains canonical terms" },

  // ---- relay / indexer ----
  "POST /relay/submit": { access: "relay-submit", note: "operator, or party of params.dealId for a known deal" },
  "GET /relay/:key": { access: "public", note: "operator sees full job; params redacted otherwise" },
  "POST /indexer/tick": { access: "operator", roles: ["relay", "governance"] },
  "POST /indexer/replay": { access: "operator", roles: ["relay", "governance"] },

  // ---- journey ----
  "GET /tx/:hash/status": { access: "public", note: "chain receipt lookup" },

  // ---- evidence ----
  "POST /deals/:dealId/evidence": { access: "party", note: "uploader must be a deal party (handler re-checks)" },
  "GET /deals/:dealId/evidence": { access: "party-or-reviewer" },
  "GET /evidence/:fileHash": { access: "party-or-reviewer", note: "dealId supplied via ?dealId=" },
  "GET /evidence/:fileHash/receipt": { access: "party-or-reviewer", note: "dealId supplied via ?dealId=" },
  "GET /deals/:dealId/export": { access: "party-or-reviewer" },
  "POST /deals/:dealId/evidence/restore-check": { access: "party-or-reviewer" },

  // ---- categories / messages / evidence payload ----
  "GET /categories": { access: "public" },
  "POST /deals/:dealId/delivery-form": { access: "party", note: "seller-only enforced in the handler" },
  "GET /deals/:dealId/delivery-form": { access: "party-or-reviewer" },
  "POST /deals/:dealId/messages": { access: "party" },
  "GET /deals/:dealId/messages": { access: "party-or-reviewer" },
  "POST /deals/:dealId/evidence/payload": { access: "party" },

  // ---- review console ----
  "GET /review/queue": { access: "reviewer-queue", note: "assigned reviewer or supervisor" },
  "GET /review/cases/:dealId": { access: "reviewer", note: "assigned to this deal's epoch only" },
  "POST /review/cases/:dealId/assign": { access: "assignment", note: "arbitration operator only" },
  "POST /review/cases/:dealId/recuse": { access: "recusal", note: "arbitration operator only" },
  "POST /review/cases/:dealId/awards/draft": { access: "reviewer" },
  "POST /review/cases/:dealId/approvals": { access: "reviewer" },
  "POST /review/cases/:dealId/queue-ruling": { access: "reviewer" },
  "POST /review/cases/:dealId/veto": { access: "public", note: "handler verifies veto authority signatures" },
  "GET /deals/:dealId/escalation": { access: "public", note: "handler requires a signed request" },
  "POST /deals/:dealId/settlement-proposals": { access: "party" },
  "GET /deals/:dealId/settlement-proposals": { access: "party-or-reviewer" },
  "POST /settlement-proposals/:id/accept": { access: "public", note: "handler resolves the proposal's deal party" },
});

/** All registered keys that have no permission entry (fail-closed coverage). */
export function missingRoutePermissions(keys: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const key of keys) {
    if (!(key in ROUTE_PERMISSIONS)) missing.push(key);
  }
  return missing;
}
