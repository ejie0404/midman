// Category delivery forms, deal chat messages, and evidence-commitment
// payloads. Contract state is authoritative; everything here is an off-chain
// view or signing payload.
//
// Deps are structural (CategoryRouteDeps) so server.ts can pass its own
// RouteDeps without modification. Auth delegates to the parallel worker's
// evidence/access.js exports (verifySignedRequest, dealParty) — never
// reimplemented here; see authWallet/partyOf below.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Address } from "viem";
import type { ChainReader } from "@midman/chain";
import type { DraftRecord, Store } from "../db.js";
import { verifySignedRequest, dealParty } from "../evidence/access.js";
import { CATEGORY_ORDER, getCategory, hashDeliveryManifest, validateDelivery } from "./categories.js";
import {
  deliveryForms,
  messageThreads,
  type DeliveryFormRegistry,
  type MessageThreadRegistry,
} from "./registry.js";
import { validateMessageText } from "../messages.js";
import {
  buildEvidenceManifestTypedData,
  encodeSubmitEvidenceCommitmentCalldata,
  evidenceManifestCommitment,
  validateCommitmentInput,
} from "../commitments.js";

/** Structural deps: a subset of the API RouteDeps; extra fields are ignored. */
export interface CategoryRouteDeps {
  readonly store: Store;
  readonly reader: ChainReader | null;
  readonly hub: Address | null;
  readonly usdc: Address;
  readonly chainId: number | null;
  readonly rpcConfigured: boolean;
}

export interface CategoryRouteOptions {
  readonly forms?: DeliveryFormRegistry;
  readonly threads?: MessageThreadRegistry;
}

const DEAL_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Authenticate the signed-request scheme owned by evidence/access.js
 * (EIP-191 personal_sign of `${METHOD}\n${path}\n${sha256hex(body)}\n${expiry}`
 * in x-wallet-address / x-wallet-expiry / x-wallet-signature headers).
 * Returns the wallet on success, null on any failure (never throws).
 */
async function authWallet(request: FastifyRequest): Promise<string | null> {
  try {
    return await verifySignedRequest(request);
  } catch {
    return null;
  }
}

type PartyRole = "buyer" | "seller";

function localRole(draft: DraftRecord, wallet: string): PartyRole | null {
  const buyer = draft.terms["buyer"];
  const seller = draft.terms["seller"];
  if (typeof buyer === "string" && buyer.toLowerCase() === wallet.toLowerCase()) return "buyer";
  if (typeof seller === "string" && seller.toLowerCase() === wallet.toLowerCase()) return "seller";
  return null;
}

/**
 * Resolve the wallet's deal role via evidence/access.js dealParty
 * (chain state wins when readable, else the draft projection). Falls back to
 * the local draft comparison only if the module itself throws.
 */
async function partyOf(deps: CategoryRouteDeps, dealId: string, wallet: string): Promise<PartyRole | null> {
  try {
    return await dealParty(deps.store, deps.reader, deps.hub, dealId, wallet);
  } catch {
    const draft = await deps.store.getDraftByDeal(dealId);
    return draft ? localRole(draft, wallet) : null;
  }
}

/** Reviewer allowlist read access via REVIEWER_WALLETS (comma-separated). */
function isReviewer(wallet: string): boolean {
  const raw = process.env["REVIEWER_WALLETS"] ?? "";
  const allowlist = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
  return allowlist.has(wallet.toLowerCase());
}

async function authedDeal(
  request: FastifyRequest,
  dealId: string,
  store: Store,
): Promise<{ wallet: string; draft: DraftRecord } | { status: number; error: string }> {
  const wallet = await authWallet(request);
  if (!wallet) return { status: 401, error: "Authentication required" };
  if (!DEAL_ID_RE.test(dealId)) return { status: 400, error: "Invalid dealId" };
  const draft = await store.getDraftByDeal(dealId);
  if (!draft) return { status: 404, error: "Unknown deal" };
  return { wallet, draft };
}

function bad(message: string): { error: string } {
  return { error: message };
}

export function registerCategoryRoutes(
  app: FastifyInstance,
  deps: CategoryRouteDeps,
  opts?: CategoryRouteOptions,
): void {
  const forms = opts?.forms ?? deliveryForms;

  app.get("/categories", async () => ({
    categories: CATEGORY_ORDER.map((id) => {
      const schema = getCategory(id)!;
      return {
        id: schema.id,
        fields: schema.fields,
        completionCriteria: schema.completionCriteria,
        minInspection: schema.minInspection,
      };
    }),
  }));

  app.post<{ Params: { dealId: string } }>("/deals/:dealId/delivery-form", async (request, reply) => {
    const authed = await authedDeal(request, request.params.dealId, deps.store);
    if ("error" in authed) return reply.code(authed.status).send(bad(authed.error));
    const role = await partyOf(deps, request.params.dealId, authed.wallet);
    if (role !== "seller") return reply.code(403).send(bad("Seller only"));
    const body = (request.body ?? {}) as Record<string, unknown>;
    const category = body["category"];
    if (typeof category !== "string") {
      return reply.code(400).send({ ok: false, errors: ['Field "category" is required'] });
    }
    const result = validateDelivery(category, body["data"]);
    if (!result.ok) return reply.code(400).send({ ok: false, errors: result.errors });
    const data = body["data"] as Record<string, unknown>;
    const deliveryManifestHash = hashDeliveryManifest(request.params.dealId, category, data);
    const record = forms.set({
      dealId: request.params.dealId,
      category,
      data,
      deliveryManifestHash,
      submittedBy: authed.wallet,
      submittedAt: new Date().toISOString(),
    });
    // deliveryManifestHash is the bytes32 manifestHash for markDelivered.
    return { ok: true, deliveryManifestHash: record.deliveryManifestHash, version: record.version };
  });

  app.get<{ Params: { dealId: string } }>("/deals/:dealId/delivery-form", async (request, reply) => {
    const authed = await authedDeal(request, request.params.dealId, deps.store);
    if ("error" in authed) return reply.code(authed.status).send(bad(authed.error));
    const role = await partyOf(deps, request.params.dealId, authed.wallet);
    if (!role && !isReviewer(authed.wallet)) return reply.code(403).send(bad("Not authorized"));
    const form = forms.get(request.params.dealId);
    if (!form) return reply.code(404).send(bad("No delivery form"));
    return form;
  });
}

export function registerMessageRoutes(
  app: FastifyInstance,
  deps: CategoryRouteDeps,
  opts?: CategoryRouteOptions,
): void {
  const threads = opts?.threads ?? messageThreads;

  app.post<{ Params: { dealId: string } }>("/deals/:dealId/messages", async (request, reply) => {
    const authed = await authedDeal(request, request.params.dealId, deps.store);
    if ("error" in authed) return reply.code(authed.status).send(bad(authed.error));
    const role = await partyOf(deps, request.params.dealId, authed.wallet);
    if (!role) return reply.code(403).send(bad("Deal party only"));
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = validateMessageText(body["text"]);
    if (!result.ok) return reply.code(400).send({ ok: false, errors: result.errors });
    return threads.append(request.params.dealId, authed.wallet, body["text"] as string);
  });

  app.get<{ Params: { dealId: string } }>("/deals/:dealId/messages", async (request, reply) => {
    const authed = await authedDeal(request, request.params.dealId, deps.store);
    if ("error" in authed) return reply.code(authed.status).send(bad(authed.error));
    const role = await partyOf(deps, request.params.dealId, authed.wallet);
    if (!role && !isReviewer(authed.wallet)) return reply.code(403).send(bad("Not authorized"));
    return { dealId: request.params.dealId, messages: threads.list(request.params.dealId) };
  });
}

export function registerCommitmentRoutes(app: FastifyInstance, deps: CategoryRouteDeps): void {
  app.post<{ Params: { dealId: string } }>("/deals/:dealId/evidence/payload", async (request, reply) => {
    const authed = await authedDeal(request, request.params.dealId, deps.store);
    if ("error" in authed) return reply.code(authed.status).send(bad(authed.error));
    const role = await partyOf(deps, request.params.dealId, authed.wallet);
    if (!role) return reply.code(403).send(bad("Deal party only"));
    const parsed = validateCommitmentInput(request.body);
    if (!parsed.ok) return reply.code(400).send({ ok: false, errors: parsed.errors });
    const input = parsed.value;
    if (input.uploader.toLowerCase() !== authed.wallet.toLowerCase()) {
      return reply.code(403).send(bad("uploader must match the authenticated wallet"));
    }
    // termsHash is unknown off-chain pre-fund: canonical draft terms carry an
    // agreementHash, NOT the EIP-712 agreementDigest (derived at download via
    // buildFullTerms, pinned on-chain at funding). Prefer a digest already
    // recorded on the draft; otherwise require the client to supply one (e.g.
    // from GET /drafts/:id/download).
    const body = (request.body ?? {}) as Record<string, unknown>;
    const draftDigest = authed.draft.terms["agreementDigest"];
    const suppliedDigest = body["agreementDigest"];
    const agreementDigest =
      typeof draftDigest === "string" && BYTES32_RE.test(draftDigest)
        ? draftDigest
        : typeof suppliedDigest === "string" && BYTES32_RE.test(suppliedDigest)
          ? suppliedDigest
          : null;
    if (!agreementDigest) {
      return reply.code(400).send({
        ok: false,
        errors: [
          'Field "agreementDigest" is required: not resolvable from the deal draft (termsHash unknown off-chain pre-fund); supply the EIP-712 agreement digest from GET /drafts/:id/download',
        ],
      });
    }
    if (!deps.hub || deps.chainId === null) {
      return reply.code(503).send(bad("Deployment not configured"));
    }
    const dealId = request.params.dealId;
    const typedData = buildEvidenceManifestTypedData({
      chainId: deps.chainId,
      hub: deps.hub,
      dealId,
      agreementDigest,
      input,
    });
    // Pre-encoded with a 0x signature placeholder: the uploader signs
    // typedData separately, then submits with the signature attached.
    const calldata = encodeSubmitEvidenceCommitmentCalldata({ dealId, input });
    const commitment = evidenceManifestCommitment({ dealId, agreementDigest, input });
    return {
      dealId,
      agreementDigest,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      calldata,
      commitment,
      note: "termsHash unknown off-chain pre-fund: agreementDigest resolved from the draft when present, else client-supplied. Sign the EIP-712 EvidenceManifest typed-data, then call submitEvidenceCommitment with the signature.",
    };
  });
}
