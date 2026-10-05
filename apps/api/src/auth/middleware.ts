// Fastify wiring for wallet auth: the /auth/* endpoints, the request.session
// decoration, and the declarative, fail-closed route-authorization guard.
//
// Guards are matched by `request.routeOptions.url` (the registered route
// pattern) + method, so parameterized paths such as /drafts/:id/summary work
// exactly. registerAuthGuards MUST be called before the routes it protects are
// registered (Fastify applies hooks to routes registered after them).
//
// Round-2 Phase 2: the previous `switch` with a `default: protectedRoute =
// false` branch (silent public) is replaced by ROUTE_PERMISSIONS
// (auth/routePermissions.ts). A registered route with no entry is DENIED for
// non-operators and logged as a config error at startup. PUBLIC is explicit.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createPublicClient, http, type Address } from "viem";
import { auditLog } from "../audit.js";
import { dealParty, hasAnyReviewerAssignment, isSupervisor, reviewerAssignedTo } from "../evidence/access.js";
import type { RouteDeps } from "../routes.js";
import {
  issueLoginChallenge,
  loginDomain,
  verifyLoginSignature,
  type ContractWalletVerifier,
} from "./challenge.js";
import {
  OPERATOR_ROLES,
  httpError,
  isOperatorRequest,
  recordInvitation,
  redeemInvitation,
  requireAnyOperator,
  requireAuth,
  type PartyStore,
} from "./permissions.js";
import {
  ROUTE_PERMISSIONS,
  routeKey,
  type RoutePermission,
} from "./routePermissions.js";
import {
  getCase,
  recordAssignmentAudit,
  validateProposedAssignment,
} from "../review/registry.js";
import {
  clearSession,
  isSessionNonceRevokedDurable,
  issueSession,
  maybeRotateSession,
  readSession,
  revokeSessionNonce,
  type Session,
} from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: Session | null;
  }
}

const DEFAULT_CHAIN_ID = 8453;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/** Per-app set of registered route keys, used for startup coverage auditing. */
const registeredRoutesByApp = new WeakMap<object, Set<string>>();

/** Keys captured for a running app (coverage test / startup diagnostics). */
export function getRegisteredRouteKeys(app: object): string[] {
  return [...(registeredRoutesByApp.get(app) ?? new Set<string>())];
}

function walletFrom(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value: string): boolean {
  return BYTES32_RE.test(value);
}

function routePath(req: FastifyRequest): string {
  return req.routeOptions?.url ?? "";
}

function paramId(req: FastifyRequest): string {
  const params = req.params as { id?: string; dealId?: string };
  return params.id ?? params.dealId ?? "";
}

function dealIdFor(req: FastifyRequest): string {
  const params = req.params as { dealId?: string };
  if (params.dealId) return params.dealId;
  const query = req.query as { dealId?: string } | undefined;
  return query?.dealId ?? "";
}

function errorResponse(reply: FastifyReply, error: unknown): FastifyReply {
  const status =
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? ((error as { statusCode: number }).statusCode as number)
      : 500;
  return reply.code(status).send({ error: error instanceof Error ? error.message : "Authorization failed" });
}

/** Optional EIP-1271 verifier built from a configured auth RPC endpoint. */
function contractWalletVerifier(env: NodeJS.ProcessEnv = process.env): ContractWalletVerifier | null {
  const url = env["MIDMAN_AUTH_RPC_URL"] ?? env["AUTH_RPC_URL"];
  if (!url || !url.trim()) return null;
  try {
    const client = createPublicClient({ transport: http(url.trim()) });
    return {
      verifyMessage: (args) => client.verifyMessage(args as Parameters<typeof client.verifyMessage>[0]),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Party / reviewer resolution (session-wallet based; handlers still require
// their signed-request scheme, so protected routes are double-gated).
// ---------------------------------------------------------------------------

type PartyDeps = Pick<RouteDeps, "store" | "reader" | "hub">;

async function resolveDraft(deps: PartyDeps, idOrDealId: string) {
  const byId = await deps.store.getDraft(idOrDealId);
  if (byId) return byId;
  return deps.store.getDraftByDeal(idOrDealId);
}

async function chainRole(deps: PartyDeps, dealId: string, wallet: string): Promise<"buyer" | "seller" | null> {
  if (!deps.reader || !deps.hub || !isBytes32(dealId)) return null;
  return dealParty(deps.store, deps.reader, deps.hub, dealId, wallet);
}

async function isCreatorOrParty(deps: PartyDeps, idOrDealId: string, wallet: string): Promise<boolean> {
  const want = wallet.toLowerCase();
  const draft = await resolveDraft(deps, idOrDealId);
  if (draft) {
    if (draft.creatorWallet && draft.creatorWallet.toLowerCase() === want) return true;
    if ((draft.terms["buyer"] ?? "").toLowerCase() === want && (draft.terms["buyer"] ?? "") !== "") return true;
    if ((draft.terms["seller"] ?? "").toLowerCase() === want && (draft.terms["seller"] ?? "") !== "") return true;
    return (await chainRole(deps, draft.dealId, wallet)) !== null;
  }
  return (await chainRole(deps, idOrDealId, wallet)) !== null;
}

async function isParty(deps: PartyDeps, idOrDealId: string, wallet: string): Promise<boolean> {
  const want = wallet.toLowerCase();
  const draft = await resolveDraft(deps, idOrDealId);
  if (draft) {
    if ((draft.terms["buyer"] ?? "").toLowerCase() === want && (draft.terms["buyer"] ?? "") !== "") return true;
    if ((draft.terms["seller"] ?? "").toLowerCase() === want && (draft.terms["seller"] ?? "") !== "") return true;
    return (await chainRole(deps, draft.dealId, wallet)) !== null;
  }
  return (await chainRole(deps, idOrDealId, wallet)) !== null;
}

async function enforceParty(req: FastifyRequest, deps: PartyDeps, idOrDealId: string): Promise<void> {
  const session = requireAuth(req);
  if (await isParty(deps, idOrDealId, session.wallet)) return;
  const draft = await resolveDraft(deps, idOrDealId);
  if (!draft && !(deps.reader && deps.hub)) throw httpError(404, "Draft not found");
  throw httpError(403, "Wallet is not a party to this draft");
}

async function enforceCreatorOrParty(req: FastifyRequest, deps: PartyDeps, idOrDealId: string): Promise<void> {
  const session = requireAuth(req);
  if (await isCreatorOrParty(deps, idOrDealId, session.wallet)) return;
  const draft = await resolveDraft(deps, idOrDealId);
  if (!draft && !(deps.reader && deps.hub)) throw httpError(404, "Draft not found");
  throw httpError(403, "Wallet is not the creator or a party to this draft");
}

async function enforceInvite(req: FastifyRequest, deps: PartyDeps, idOrDealId: string): Promise<void> {
  const draft = await resolveDraft(deps, idOrDealId);
  if (!draft) throw httpError(404, "Draft not found");
  // Anonymous drafting keeps an UNCLAIMED draft: its first invite is open so
  // the anonymous creator can hand a token to the intended counterparty.
  if (!draft.creatorWallet) return;
  const session = requireAuth(req);
  if (draft.creatorWallet.toLowerCase() !== session.wallet.toLowerCase()) {
    throw httpError(403, "Wallet is not the draft creator");
  }
}

async function enforcePartyOrReviewer(req: FastifyRequest, deps: PartyDeps, dealId: string): Promise<void> {
  const session = requireAuth(req);
  if (await isParty(deps, dealId, session.wallet)) return;
  if (reviewerAssignedTo(dealId, session.wallet)) return;
  throw httpError(403, "Wallet is not a party or assigned reviewer for this deal");
}

async function enforceAssignedReviewer(req: FastifyRequest, dealId: string): Promise<void> {
  const session = requireAuth(req);
  if (reviewerAssignedTo(dealId, session.wallet)) return;
  throw httpError(403, "Wallet is not assigned to this review case");
}

async function enforceQueueReviewer(req: FastifyRequest): Promise<void> {
  const session = requireAuth(req);
  if (isSupervisor(session.wallet) || hasAnyReviewerAssignment(session.wallet)) return;
  throw httpError(403, "Wallet is not an assigned reviewer");
}

// ---------------------------------------------------------------------------
// Invitation acceptance (compare-and-set redemption).
// ---------------------------------------------------------------------------

async function guardAccept(req: FastifyRequest, store: PartyStore): Promise<void> {
  const session = requireAuth(req);
  const id = paramId(req);
  const draft = await store.getDraft(id);
  if (!draft) throw httpError(404, "Draft not found");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body["invitationToken"] === "string" ? (body["invitationToken"] as string) : "";
  if (!token) throw httpError(403, "Invitation token required");
  const intended = (draft.counterpartyHint ?? "").toLowerCase();
  if (intended && intended !== session.wallet.toLowerCase()) {
    throw httpError(403, "Wallet is not the invited counterparty");
  }
  const redeemTx = typeof body["redeemTx"] === "string" ? (body["redeemTx"] as string) : null;
  const result = await redeemInvitation(id, token, session.wallet, { redeemTx });
  if (!result.ok) throw httpError(403, `Invalid invitation token (${result.reason})`);
  // Body wallet fields are never authority: the accepting wallet is the session.
  body["counterpartyAddress"] = session.wallet;
}

// ---------------------------------------------------------------------------
// Assignment authority (arbitration operator only).
// ---------------------------------------------------------------------------

interface AssignmentBody {
  primary?: unknown;
  fallback?: unknown;
  attestation?: unknown;
  authEpoch?: unknown;
}

function policiesAddress(env: NodeJS.ProcessEnv = process.env): Address | null {
  const raw = env["POLICIES_ADDRESS"] ?? "";
  return isAddress(raw) ? (raw as Address) : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function authorizeAssignment(
  req: FastifyRequest,
  deps: RouteDeps,
  dealId: string,
  body: AssignmentBody,
): Promise<void> {
  const operator = await requireAnyOperator(req, ["arbitration"]);
  const primary = stringList(body.primary);
  const fallback = stringList(body.fallback);

  let buyer: string | null = null;
  let seller: string | null = null;
  const draft = await deps.store.getDraftByDeal(dealId);
  if (draft) {
    buyer = draft.terms["buyer"] ?? null;
    seller = draft.terms["seller"] ?? null;
  }
  let chainDeal: Record<string, bigint | string | boolean | number> | null = null;
  if (deps.reader && deps.hub && isBytes32(dealId)) {
    try {
      chainDeal = await deps.reader.getDeal(deps.hub, dealId as `0x${string}`);
      buyer = buyer ?? (typeof chainDeal["buyer"] === "string" ? (chainDeal["buyer"] as string) : null);
      seller = seller ?? (typeof chainDeal["seller"] === "string" ? (chainDeal["seller"] as string) : null);
    } catch {
      chainDeal = null;
    }
  }

  const validated = validateProposedAssignment(dealId, { primary, fallback }, { buyer, seller });

  const attestation = typeof body.attestation === "string" ? body.attestation.trim() : "";
  const epochSource = body.authEpoch ?? chainDeal?.["authEpoch"];
  const policies = policiesAddress();
  let verified = false;
  let authEpoch: string | null = epochSource === undefined || epochSource === null ? null : String(epochSource);

  if (
    deps.reader &&
    policies &&
    authEpoch !== null &&
    /^[0-9]+$/.test(authEpoch)
  ) {
    const epoch = BigInt(authEpoch);
    for (const [house, list] of [
      ["primary", validated.primary],
      ["fallback", validated.fallback],
    ] as const) {
      for (const wallet of list) {
        const member = await deps.reader.isPanelMember(policies, epoch, house, wallet as Address);
        if (!member) {
          throw httpError(403, `${wallet} is not on the on-chain ${house} panel for epoch ${epoch}`);
        }
      }
    }
    verified = true;
  } else if (!attestation) {
    throw httpError(
      403,
      "Chain panel unavailable: arbitration must supply an explicit operator attestation to assign",
    );
  }

  await recordAssignmentAudit({
    dealId,
    action: "assign",
    actor: operator.wallet,
    operatorRole: "arbitration",
    verified,
    attestation: attestation === "" ? null : attestation,
    authEpoch,
    primary: [...validated.primary],
    fallback: [...validated.fallback],
    at: new Date().toISOString(),
  });
}

async function authorizeRecusal(req: FastifyRequest, dealId: string, body: Record<string, unknown>): Promise<void> {
  const operator = await requireAnyOperator(req, ["arbitration"]);
  if (!getCase(dealId)) throw httpError(404, "Unknown review case");
  const reviewer = String(body["reviewer"] ?? "");
  const reason = String(body["reason"] ?? "").trim();
  if (!isAddress(reviewer)) throw httpError(400, "Invalid reviewer address");
  if (reason === "") throw httpError(400, "Recusal reason is required");
  await recordAssignmentAudit({
    dealId,
    action: "recuse",
    actor: operator.wallet,
    operatorRole: "arbitration",
    verified: false,
    attestation: null,
    authEpoch: null,
    reviewer,
    reason,
    at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// /auth/* endpoints
// ---------------------------------------------------------------------------

/** POST/GET /auth/challenge, POST /auth/verify, POST /auth/logout, GET /auth/session. */
export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const chainIdForRequest = (value: unknown): number => {
    const parsed = Number(value ?? deps.chainId ?? DEFAULT_CHAIN_ID);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : (deps.chainId ?? DEFAULT_CHAIN_ID);
  };

  const issue = (wallet: string, chainId: number, reply: FastifyReply) => {
    if (!isAddress(wallet)) return reply.code(400).send({ error: "Invalid wallet address" });
    try {
      const issued = issueLoginChallenge({ domain: loginDomain(), chainId, wallet });
      auditLog({ actor: wallet, action: "auth.challenge", details: { domain: loginDomain(), chainId } });
      return {
        challenge: issued.challenge,
        message: issued.message,
        uri: issued.uri,
        expiresAt: issued.challenge.expiresAt,
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Challenge failed" });
    }
  };

  app.post<{ Body: Record<string, unknown> }>("/auth/challenge", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return issue(walletFrom(body["wallet"]), chainIdForRequest(body["chainId"]), reply);
  });

  app.get<{ Querystring: Record<string, string> }>("/auth/challenge", async (req, reply) => {
    return issue(walletFrom(req.query["wallet"]), chainIdForRequest(req.query["chainId"]), reply);
  });

  app.post<{ Body: Record<string, unknown> }>("/auth/verify", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nonce = String(body["nonce"] ?? "");
    const wallet = String(body["wallet"] ?? "");
    const signature = String(body["signature"] ?? "");
    if (!nonce || !wallet || !signature) {
      return reply.code(400).send({ error: "nonce, wallet and signature are required" });
    }
    const result = await verifyLoginSignature({
      nonce,
      wallet,
      signature,
      ...(body["domain"] !== undefined ? { domain: String(body["domain"]) } : {}),
      ...(body["chainId"] !== undefined ? { chainId: Number(body["chainId"]) } : {}),
      expectedDomain: loginDomain(),
      expectedChainId: deps.chainId ?? DEFAULT_CHAIN_ID,
      contractWallet: contractWalletVerifier(),
    });
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.reason });
    const session = issueSession(reply, result.wallet);
    auditLog({ actor: result.wallet, action: "auth.verify" });
    return { ok: true, wallet: result.wallet, expiresAt: session.expiresAt };
  });

  app.post("/auth/logout", async (req, reply) => {
    const session = req.session !== undefined ? req.session : readSession(req);
    if (session) await revokeSessionNonce(session.nonce);
    clearSession(reply);
    return { ok: true };
  });

  app.get("/auth/session", async (req, reply) => {
    const session = req.session !== undefined ? req.session : readSession(req);
    if (!session) return { authenticated: false };
    const rotated = maybeRotateSession(reply, session);
    return {
      authenticated: true,
      wallet: rotated.wallet,
      issuedAt: rotated.issuedAt,
      expiresAt: rotated.expiresAt,
    };
  });

  // First authenticated access binds an unclaimed (anonymous-created) draft.
  app.post<{ Params: { id: string } }>("/drafts/:id/claim", async (req, reply) => {
    const session = requireAuth(req);
    const draft = await deps.store.getDraft(req.params.id);
    if (!draft) return reply.code(404).send({ error: "Draft not found" });
    if (draft.creatorWallet && draft.creatorWallet.toLowerCase() !== session.wallet.toLowerCase()) {
      return reply.code(403).send({ error: "Draft already claimed by another wallet" });
    }
    if (!draft.creatorWallet) {
      await deps.store.updateDraft(draft.id, { creatorWallet: session.wallet });
      auditLog({ actor: session.wallet, action: "draft.claim", dealId: draft.dealId });
      return { ok: true, creatorWallet: session.wallet, claimed: true };
    }
    return { ok: true, creatorWallet: draft.creatorWallet, claimed: false };
  });
}

// ---------------------------------------------------------------------------
// Declarative fail-closed guard
// ---------------------------------------------------------------------------

/**
 * Register the route permission guard. Must run before the protected routes.
 * Also wires the auth onSend pass (invitation recording + relay redaction).
 */
export function registerAuthGuards(app: FastifyInstance, deps: RouteDeps): void {
  // `undefined` means "guard has not run"; `null` means "checked, no valid
  // session". Requiring an explicit assignment prevents a fallback re-read from
  // resurrecting a session the durable blocklist just revoked.
  app.decorateRequest("session", undefined);

  const seen = new Set<string>();
  registeredRoutesByApp.set(app, seen);
  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) {
      if (typeof method !== "string") continue;
      if (method === "HEAD" || method === "OPTIONS") continue;
      seen.add(routeKey(method, routeOptions.url));
    }
  });
  app.addHook("onReady", async () => {
    for (const key of seen) {
      if (!(key in ROUTE_PERMISSIONS)) {
        // Fail closed at runtime; surface the misconfiguration loudly at boot.
        console.error(`[auth] no route-permission entry for ${key}; non-operator access is DENIED (fail closed)`);
      }
    }
  });

  app.addHook("preHandler", async (req, reply) => {
    let session = readSession(req);
    // Cross-instance revocation: a logout on any API instance must invalidate
    // the nonce here even though the local deny-list has never seen it.
    if (session && (await isSessionNonceRevokedDurable(session.nonce))) session = null;
    req.session = session;

    const method = req.method.toUpperCase();
    const route = routePath(req);
    const key = routeKey(method, route);
    const permission: RoutePermission | undefined = ROUTE_PERMISSIONS[key];

    try {
      // PUBLIC create: bind creatorWallet to the session; anonymous -> unclaimed.
      if (key === "POST /drafts") {
        const body = req.body;
        if (body && typeof body === "object") {
          (body as Record<string, unknown>)["creatorWallet"] = session?.wallet ?? "";
        }
      }

      if (!permission) {
        // Fail closed. Operators (session + signed request + role) may pass.
        if (await isOperatorRequest(req, OPERATOR_ROLES)) return;
        throw httpError(401, "Route is not authorized (missing route-permission entry)");
      }

      switch (permission.access) {
        case "public":
          break;
        case "authenticated":
          requireAuth(req);
          break;
        case "creator":
          await enforceInvite(req, deps, paramId(req));
          break;
        case "creator-or-party":
          await enforceCreatorOrParty(req, deps, paramId(req));
          break;
        case "party":
          await enforceParty(req, deps, paramId(req));
          break;
        case "party-or-reviewer":
          await enforcePartyOrReviewer(req, deps, dealIdFor(req));
          break;
        case "reviewer":
          await enforceAssignedReviewer(req, paramId(req));
          break;
        case "reviewer-queue":
          await enforceQueueReviewer(req);
          break;
        case "operator":
          await requireAnyOperator(req, permission.roles ?? ["relay", "governance"]);
          break;
        case "accept":
          await guardAccept(req, deps.store);
          break;
        case "deal-status":
          await enforceDealStatus(req, deps);
          break;
        case "relay-submit":
          await enforceRelaySubmit(req, deps);
          break;
        case "assignment":
          await authorizeAssignment(req, deps, paramId(req), (req.body ?? {}) as AssignmentBody);
          break;
        case "recusal":
          await authorizeRecusal(req, paramId(req), (req.body ?? {}) as Record<string, unknown>);
          break;
      }
    } catch (error) {
      return errorResponse(reply, error);
    }

    if (session) maybeRotateSession(reply, session);
    return;
  });

  app.addHook("onSend", async (req, _reply, payload) => {
    const method = req.method.toUpperCase();
    const route = routePath(req);

    if (method === "POST" && route === "/drafts/:id/invite" && _reply.statusCode === 200) {
      const id = paramId(req);
      try {
        const body = JSON.parse(String(payload)) as { invitationToken?: unknown; expiresAt?: unknown };
        if (typeof body.invitationToken === "string" && typeof body.expiresAt === "string") {
          const draft = await deps.store.getDraft(id);
          recordInvitation(id, body.invitationToken, body.expiresAt, draft?.counterpartyHint ?? null);
        }
      } catch {
        // Invite response was not JSON; nothing to bind.
      }
      return payload;
    }

    if (method === "GET" && route === "/relay/:key" && _reply.statusCode === 200) {
      const operator = await isOperatorRequest(req, ["relay", "governance"]);
      if (!operator) {
        try {
          const job = JSON.parse(String(payload)) as Record<string, unknown>;
          if (job && typeof job === "object" && "idempotencyKey" in job) {
            return JSON.stringify({
              idempotencyKey: job["idempotencyKey"],
              queue: job["queue"],
              action: job["action"],
              status: job["status"],
              attempts: job["attempts"],
              txHash: job["txHash"],
              redacted: true,
            });
          }
        } catch {
          // Non-JSON payload; leave as-is.
        }
      }
    }
    return payload;
  });
}

/** Party/creator may read draft contents; anonymous only when the chain says funded. */
async function enforceDealStatus(req: FastifyRequest, deps: RouteDeps): Promise<void> {
  const dealId = paramId(req);
  const session = req.session;
  if (session && (await isCreatorOrParty(deps, dealId, session.wallet))) return;
  if (deps.reader && deps.hub && isBytes32(dealId)) {
    try {
      const chainDeal = await deps.reader.getDeal(deps.hub, dealId as `0x${string}`);
      if (chainDeal && chainDeal["funded"] === true) return;
    } catch {
      // Chain read failed: do NOT fall through to draft contents.
    }
  }
  throw httpError(401, "Authentication required to read deal contents");
}

/** Operators bypass; otherwise a party of a known deal is required. */
async function enforceRelaySubmit(req: FastifyRequest, deps: RouteDeps): Promise<void> {
  if (await isOperatorRequest(req, ["relay", "governance"])) return;
  const body = (req.body ?? {}) as { params?: { dealId?: unknown } };
  const dealId = typeof body.params?.dealId === "string" ? body.params.dealId : "";
  if (!dealId) return; // non-deal relay job (legacy)
  const draft = await deps.store.getDraftByDeal(dealId);
  if (!draft && !(deps.reader && deps.hub)) return; // unknown deal (legacy tolerance)
  const session = requireAuth(req);
  if (await isParty(deps, dealId, session.wallet)) return;
  throw httpError(403, "Wallet is not a party to this deal's relay job");
}
