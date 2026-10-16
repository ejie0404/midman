// GET /me/deals — the signed-in wallet's deals (creator, buyer or seller),
// newest first, so the web can show a dashboard instead of asking users to
// paste draft/deal ids. Draft data is the off-chain projection; when a chain
// reader is configured, funded deals carry their authoritative chain phase.
import type { FastifyInstance } from "fastify";
import type { Hash } from "viem";
import { PHASE_NAMES } from "@midman/chain";
import type { RouteDeps } from "./routes.js";
import { requireAuth } from "./auth/permissions.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

export interface MyDeal {
  readonly draftId: string;
  readonly dealId: string;
  readonly role: "buyer" | "seller" | "creator";
  readonly counterparty: string | null;
  readonly status: string;
  readonly category: string | null;
  readonly principalUnits: string | null;
  readonly fundedUnits: string | null;
  /** Chain phase name for funded deals; null when unfunded or unreadable. */
  readonly chainPhase: string | null;
}

export function registerMeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Querystring: { limit?: string } }>("/me/deals", async (request, reply) => {
    let wallet: string;
    try {
      wallet = requireAuth(request).wallet;
    } catch {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (typeof deps.store.listDraftsForWallet !== "function") {
      return reply.code(501).send({ error: "Deal listing is not supported by this store" });
    }
    const requested = Number(request.query.limit ?? DEFAULT_LIMIT);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
    const drafts = await deps.store.listDraftsForWallet(wallet, limit);
    const me = wallet.toLowerCase();

    const deals: MyDeal[] = await Promise.all(
      drafts.map(async (draft) => {
        const buyer = (draft.terms["buyer"] ?? "").toLowerCase();
        const seller = (draft.terms["seller"] ?? "").toLowerCase();
        const role = buyer === me ? "buyer" : seller === me ? "seller" : "creator";
        const counterparty =
          role === "buyer" ? draft.terms["seller"] ?? null : role === "seller" ? draft.terms["buyer"] ?? null : null;
        let chainPhase: string | null = null;
        if (deps.reader && deps.hub && /^0x[0-9a-fA-F]{64}$/.test(draft.dealId)) {
          try {
            const chain = await deps.reader.getDeal(deps.hub, draft.dealId as Hash);
            if (chain["funded"] === true) chainPhase = PHASE_NAMES[Number(chain["phase"])] ?? "UNKNOWN";
          } catch {
            chainPhase = null;
          }
        }
        return {
          draftId: draft.id,
          dealId: draft.dealId,
          role,
          counterparty,
          status: draft.status,
          category: draft.terms["category"] ?? null,
          principalUnits: draft.terms["principalUnits"] ?? null,
          fundedUnits: draft.terms["fundedUnits"] ?? null,
          chainPhase,
        };
      }),
    );
    return { wallet, deals };
  });
}
