// Fastify wiring for wallet auth: the /auth/* endpoints, the request.session
// decoration, and the hook-matching guards that protect existing routes
// WITHOUT editing routes.ts.
//
// Guards are matched by `request.routeOptions.url` (the registered route
// pattern) + method, so parameterized paths such as /drafts/:id/summary work
// exactly. registerAuthGuards MUST be called before the routes it protects are
// registered (Fastify applies hooks to routes registered after them).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditLog } from "../audit.js";
import { dealParty } from "../evidence/access.js";
import type { RouteDeps } from "../routes.js";
import { issueLoginChallenge, loginDomain, verifyLoginSignature } from "./challenge.js";
import {
  httpError,
  isOperatorRequest,
  recordInvitation,
  requireAnyOperator,
  requireAuth,
  requireCreatorOrParty,
  requireOperator,
  requireParty,
  verifyInvitation,
  type PartyResolver,
  type PartyStore,
} from "./permissions.js";
import {
  clearSession,
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

function walletFrom(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function routePath(req: FastifyRequest): string {
  return req.routeOptions?.url ?? "";
}

function errorResponse(reply: FastifyReply, error: unknown): FastifyReply {
  const status =
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? ((error as { statusCode: number }).statusCode as number)
      : 500;
  return reply.code(status).send({ error: error instanceof Error ? error.message : "Authorization failed" });
}

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
    });
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.reason });
    const session = issueSession(reply, result.wallet);
    auditLog({ actor: result.wallet, action: "auth.verify" });
    return { ok: true, wallet: result.wallet, expiresAt: session.expiresAt };
  });

  app.post("/auth/logout", async (req, reply) => {
    const session = readSession(req);
    if (session) revokeSessionNonce(session.nonce);
    clearSession(reply);
    return { ok: true };
  });

  app.get("/auth/session", async (req, reply) => {
    const session = readSession(req);
    if (!session) return { authenticated: false };
    const rotated = maybeRotateSession(reply, session);
    return {
      authenticated: true,
      wallet: rotated.wallet,
      issuedAt: rotated.issuedAt,
      expiresAt: rotated.expiresAt,
    };
  });
}

async function guardAccept(req: FastifyRequest, store: PartyStore, id: string): Promise<void> {
  const session = requireAuth(req);
  const draft = await store.getDraft(id);
  if (!draft) throw httpError(404, "Draft not found");
  const invited = (draft.counterpartyHint ?? "").toLowerCase();
  if (!invited || invited !== session.wallet.toLowerCase()) {
    throw httpError(403, "Wallet is not the invited counterparty");
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body["invitationToken"] === "string" ? (body["invitationToken"] as string) : "";
  if (!token) throw httpError(403, "Invitation token required");
  if (!verifyInvitation(id, token)) throw httpError(403, "Invalid or expired invitation token");
}

/**
 * Register the auth hooks. Must run before the protected routes are declared.
 * Adds a preHandler authorization pass and an onSend pass that (a) captures
 * invitation token hashes from invite responses and (b) redacts relay job
 * params for non-operator callers.
 */
export function registerAuthGuards(app: FastifyInstance, deps: RouteDeps): void {
  app.decorateRequest("session", null);

  const store: PartyStore = deps.store;
  const reader = deps.reader;
  const hub = deps.hub;
  const resolver: PartyResolver | undefined =
    reader && hub ? (dealId: string, wallet: string) => dealParty(store, reader, hub, dealId, wallet) : undefined;

  app.addHook("preHandler", async (req, reply) => {
    const session = readSession(req);
    req.session = session;

    const method = req.method.toUpperCase();
    const route = routePath(req);
    const id = (req.params as { id?: string }).id ?? "";
    const key = `${method} ${route}`;

    // Public create: bind creatorWallet to the session when present.
    if (key === "POST /drafts" && session) {
      const body = req.body;
      if (body && typeof body === "object") (body as Record<string, unknown>)["creatorWallet"] = session.wallet;
    }

    let protectedRoute = true;
    try {
      switch (key) {
        case "POST /drafts/:id/accept":
          await guardAccept(req, store, id);
          break;
        case "POST /drafts/:id/signatures":
          await requireParty(req, store, id, session?.wallet, resolver);
          break;
        case "POST /drafts/:id/admission":
          await requireOperator(req, "admission");
          break;
        case "POST /drafts/:id/revoke-note":
          await requireParty(req, store, id, session?.wallet, resolver);
          break;
        case "GET /drafts/:id/terms":
          await requireCreatorOrParty(req, store, id, session?.wallet, resolver);
          break;
        case "GET /drafts/:id/summary":
        case "GET /drafts/:id/download":
          await requireParty(req, store, id, session?.wallet, resolver);
          break;
        case "POST /indexer/tick":
        case "POST /indexer/replay":
          await requireAnyOperator(req, ["relay", "governance"]);
          break;
        default:
          protectedRoute = false;
          break;
      }
    } catch (error) {
      return errorResponse(reply, error);
    }

    if (session && (protectedRoute || key === "GET /auth/session")) {
      maybeRotateSession(reply, session);
    }
    return;
  });

  app.addHook("onSend", async (req, _reply, payload) => {
    const method = req.method.toUpperCase();
    const route = routePath(req);

    if (method === "POST" && route === "/drafts/:id/invite" && _reply.statusCode === 200) {
      const id = (req.params as { id?: string }).id ?? "";
      try {
        const body = JSON.parse(String(payload)) as { invitationToken?: unknown; expiresAt?: unknown };
        if (typeof body.invitationToken === "string" && typeof body.expiresAt === "string") {
          recordInvitation(id, body.invitationToken, body.expiresAt);
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
