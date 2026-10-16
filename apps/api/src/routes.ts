// HTTP surface for Phase 6: drafts, signatures, admission, relay outbox,
// chain-first financial reads, recovery exports, indexer operations.
// Contract state is authoritative; projections are labeled as such.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { keccak256, stringToHex, type Address, type Hash } from "viem";
import { createViemReader, buildRecoveryPackage, confirmationLevel, PHASE_NAMES, type ChainReader } from "@midman/chain";
import { auditLog } from "./audit.js";
import { hashInvitationToken, newInvitationToken } from "./invitations.js";
import { loadConfig } from "./config.js";
import type { Store } from "./db.js";
import { Indexer } from "./indexer.js";
import {
  buildCanonicalTerms,
  verifyAcceptanceSignature,
  previewSettlement,
  type CanonicalTerms,
  type DraftTermsInput,
} from "./terms.js";
import type { FeeAllocationBps } from "@midman/shared";
import { validateAdmissionStruct, validateRelayFundPayload } from "@midman/api-client";
import { registerJourneyRoutes } from "./journey.js";
import { buildFullTerms } from "./fullTerms.js";
import {
  buildFundCalldata,
  type AdmissionInput,
  type AllowanceIntentInput,
  type Payment3009Input,
  type ReadinessAuthInput,
} from "./chainActions.js";
import { buildFundingBundle, storeDealSignature } from "./funding.js";
import { dealParty } from "./evidence/access.js";
import { resolveDraftBinding } from "./dealsMeta.js";
import { requestAdmission } from "./admission/service.js";

export interface RouteDeps {
  readonly store: Store;
  readonly reader: ChainReader | null;
  readonly indexer: Indexer | null;
  readonly hub: Address | null;
  readonly usdc: Address;
  readonly chainId: number | null;
  readonly rpcConfigured: boolean;
}

export function buildDeps(store: Store): RouteDeps {
  const config = loadConfig();
  const hub = (process.env["HUB_ADDRESS"] ?? "") as Address;
  const hasHub = /^0x[0-9a-fA-F]{40}$/.test(hub);
  const reader = config.rpcUrls.length > 0 ? createViemReader(config.rpcUrls) : null;
  const indexer =
    reader && hasHub
      ? new Indexer(reader, store, {
          hub,
          fromBlock: BigInt(process.env["INDEXER_FROM_BLOCK"] ?? "0"),
        })
      : null;
  return {
    store,
    reader,
    indexer,
    hub: hasHub ? hub : null,
    usdc: config.usdcAddress as Address,
    chainId: config.chainId,
    rpcConfigured: config.rpcUrls.length > 0,
  };
}

const asHash = (value: string, field: string): Hash => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid bytes32 for ${field}`);
  return value as Hash;
};

const asAddress = (value: string, field: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address for ${field}`);
  return value as Address;
};

/**
 * Terms plus `agreementDigest`: the EIP-712 DealTerms digest the hub stores as
 * the deal's termsHash. Every party action signature (delivery, dispute,
 * settlement) is bound to it, so clients must sign with this value, never
 * with agreementHash (the hash of the agreement text).
 */
export function withAgreementDigest(terms: Record<string, string>): Record<string, string> {
  const hub = terms["hub"];
  if (!hub || !/^0x[0-9a-fA-F]{40}$/.test(hub)) return terms;
  try {
    return { ...terms, agreementDigest: buildFullTerms(terms as CanonicalTerms, hub as Address).agreementDigest };
  } catch {
    return terms;
  }
}

const MAX_AGREEMENT_TEXT = 4_000;
const MAX_TITLE = 120;

/** Validate the optional agreement title/text against the signed agreementHash. */
export function agreementFromBody(
  body: Record<string, unknown>,
  agreementHash: string,
): { title: string | null; text: string | null } | { error: string } {
  const rawTitle = body["title"];
  const rawText = body["agreementText"];
  let title: string | null = null;
  let text: string | null = null;
  if (rawTitle !== undefined) {
    if (typeof rawTitle !== "string" || rawTitle.trim().length === 0 || rawTitle.length > MAX_TITLE) {
      return { error: `title must be 1-${MAX_TITLE} characters` };
    }
    title = rawTitle.trim();
  }
  if (rawText !== undefined) {
    if (typeof rawText !== "string" || rawText.length === 0 || rawText.length > MAX_AGREEMENT_TEXT) {
      return { error: `agreementText must be 1-${MAX_AGREEMENT_TEXT} characters` };
    }
    if (keccak256(stringToHex(rawText)).toLowerCase() !== agreementHash.toLowerCase()) {
      return { error: "agreementText does not match agreementHash" };
    }
    text = rawText;
  }
  return { title, text };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const bad = (message: string): { error: string } => ({ error: message });

  // ---- Drafts ----
  app.post<{ Body: Record<string, unknown> }>("/drafts", async (request, reply) => {
    try {
      const body = request.body;
      const raw = body["terms"] as DraftTermsInput;
      if (!raw || typeof raw !== "object") return reply.code(400).send(bad("Missing terms"));
      const binding = resolveDraftBinding(raw);
      if (!binding.ok) return reply.code(503).send(bad(binding.error));
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const terms = buildCanonicalTerms(binding.input, nowSeconds);
      // Optional human-readable agreement (title + text). The signed terms
      // only carry its hash, so the text is accepted only when it hashes to
      // exactly that agreementHash; it is private draft data (parties only).
      const agreement = agreementFromBody(body, terms["agreementHash"] ?? "");
      if ("error" in agreement) return reply.code(400).send(bad(agreement.error));
      if (agreement.text !== null) (terms as Record<string, string>)["agreementText"] = agreement.text;
      if (agreement.title !== null) (terms as Record<string, string>)["title"] = agreement.title;
      // Opaque, unguessable draft id (128 random bits), independent of dealId.
      const id = `draft_${randomBytes(16).toString("hex")}`;
      await deps.store.createDraft({
        id,
        dealId: terms["dealId"]!,
        creatorWallet: String(body["creatorWallet"] ?? ""),
        counterpartyHint: (body["counterpartyHint"] as string) ?? null,
        counterpartyAddress: null,
        terms,
        signatures: {},
        admission: null,
        revocationNote: null,
        status: "draft",
      });
      auditLog({ actor: String(body["creatorWallet"] ?? "?"), action: "draft.create", dealId: terms["dealId"] });
      return { id, dealId: terms["dealId"], terms };
    } catch (error) {
      return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid draft"));
    }
  });

  app.post<{ Params: { id: string } }>("/drafts/:id/invite", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    const token = newInvitationToken();
    await deps.store.updateDraft(draft.id, {
      status: "invited",
      revocationNote: draft.revocationNote,
    });
    // Token hash binding is recorded via audit metadata (redacted); the raw
    // token is shown exactly once. Draft linkage: invitation references dealId.
    auditLog({ actor: draft.creatorWallet, action: "draft.invite", dealId: draft.dealId, details: { tokenHash: hashInvitationToken(token) } });
    return { invitationToken: token, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/drafts/:id/accept", async (request, reply) => {
    try {
      const draft = await deps.store.getDraft(request.params.id);
      if (!draft) return reply.code(404).send(bad("Draft not found"));
      const counterpartyAddress = asAddress(String(request.body["counterpartyAddress"] ?? ""), "counterpartyAddress");
      if (draft.counterpartyHint && draft.counterpartyHint.toLowerCase() !== counterpartyAddress.toLowerCase()) {
        return reply.code(409).send(bad("Counterparty does not match the intended invitee"));
      }
      await deps.store.updateDraft(draft.id, { counterpartyAddress, status: "accepted" });
      auditLog({ actor: counterpartyAddress, action: "draft.accept", dealId: draft.dealId });
      return { ok: true, counterpartyAddress };
    } catch (error) {
      return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid accept"));
    }
  });

  app.get<{ Params: { id: string } }>("/drafts/:id/terms", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    return { terms: withAgreementDigest(draft.terms), signatures: draft.signatures, status: draft.status };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/drafts/:id/signatures", async (request, reply) => {
    try {
      const draft = await deps.store.getDraft(request.params.id);
      if (!draft) return reply.code(404).send(bad("Draft not found"));
      const role = String(request.body["role"] ?? "");
      const signature = String(request.body["signature"] ?? "") as Hash;
      const expected =
        role === "buyer" ? asAddress(draft.terms["buyer"]!, "buyer") : role === "seller" ? asAddress(draft.terms["seller"]!, "seller") : null;
      if (!expected) return reply.code(400).send(bad("Role must be buyer or seller"));
      const valid = await verifyAcceptanceSignature({
        terms: draft.terms as CanonicalTerms,
        expected,
        signature,
      });
      if (!valid) return reply.code(400).send(bad("Signature does not recover to the expected party"));
      await deps.store.updateDraft(draft.id, {
        signatures: { ...draft.signatures, [role]: signature },
        status: Object.keys(draft.signatures).length >= 1 ? "signed" : "accepted",
      });
      auditLog({ actor: expected, action: "draft.sign", dealId: draft.dealId, details: { role } });
      return { ok: true, role };
    } catch (error) {
      return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid signature"));
    }
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/drafts/:id/admission", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    // Strict canonical admission struct: only a valid grant is stored, so the
    // funding bundle can expose it verbatim (no re-validation downstream).
    let admission: Record<string, string>;
    try {
      const validated = validateAdmissionStruct(request.body["admission"], "admission");
      admission = {
        minPolicyId: validated.minPolicyId,
        admissionNonce: validated.admissionNonce,
        expiresAt: validated.expiresAt,
        signature: validated.signature,
      };
    } catch (error) {
      return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid admission"));
    }
    await deps.store.updateDraft(draft.id, { admission, status: "admitted" });
    auditLog({ actor: "admission", action: "draft.admission", dealId: draft.dealId });
    return { ok: true };
  });

  // Automated admission: a party asks, the risk rules decide, the service signs.
  app.post<{ Params: { id: string } }>("/drafts/:id/admission/request", async (request, reply) => {
    const decision = await requestAdmission(deps, request.params.id);
    if (!decision.ok) return reply.code(decision.status).send(bad(decision.reason));
    return { ok: true, admission: decision.admission, reused: decision.reused };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/drafts/:id/revoke-note", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    const note = { by: String(request.body["by"] ?? ""), at: new Date().toISOString() };
    await deps.store.updateDraft(draft.id, { revocationNote: note, status: "revocation-noted" });
    // On-chain revocation itself is a wallet transaction; the note only
    // records intent. Until chain inclusion, ordering is unresolved.
    return { ok: true, note, pendingUntil: "chain inclusion of revokeUnfundedTerms" };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/drafts/:id/quote", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    try {
      const terms = draft.terms as CanonicalTerms;
      const preview = previewSettlement({
        principalUnits: terms["principalUnits"]!,
        quotedFeeUnits: terms["quotedFeeUnits"]!,
        buyerFeeBps: Number(terms["buyerFeeBps"]) as FeeAllocationBps,
        sellerAwardUnits: request.query["sellerAward"] ?? terms["principalUnits"]!,
      });
      return { ...preview, source: "offchain-preview" };
    } catch (error) {
      return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid quote"));
    }
  });

  // ---- Chain-first deal reads ----
  app.get<{ Params: { dealId: string } }>("/deals/:dealId/status", async (request, reply) => {
    const dealId = request.params.dealId;
    let chain: Record<string, bigint | string | boolean | number> | null = null;
    if (deps.reader && deps.hub) {
      try {
        chain = await deps.reader.getDeal(deps.hub, asHash(dealId, "dealId"));
      } catch {
        chain = null;
      }
    }
    const events = await deps.store.getEventsByDeal(dealId);
    if (chain && chain["funded"] === true) {
      const phaseIndex = Number(chain["phase"]);
      return {
        dealId,
        source: "chain",
        phase: PHASE_NAMES[phaseIndex] ?? "UNKNOWN",
        fundedAt: chain["fundedAt"]?.toString(),
        deliveredAt: chain["deliveredAt"]?.toString(),
        disputeOpenedAt: chain["disputeOpenedAt"]?.toString(),
        disputeUsed: chain["disputeUsed"],
        events: events.length,
      };
    }
    const draft = await deps.store.getDraftByDeal(dealId);
    if (draft) {
      // Without the auth guard (legacy/no-enforcement mode) the projection is
      // returned as before. With guards registered, `request.session` is
      // always defined, so enforce party binding and never leak terms.
      if (request.session === undefined) {
        return { dealId, source: "draft", status: draft.status, terms: withAgreementDigest(draft.terms) };
      }
      const wallet = request.session?.wallet;
      let authorized = false;
      if (wallet) {
        const want = wallet.toLowerCase();
        if (draft.creatorWallet && draft.creatorWallet.toLowerCase() === want) authorized = true;
        else if ((draft.terms["buyer"] ?? "").toLowerCase() === want && (draft.terms["buyer"] ?? "") !== "") authorized = true;
        else if ((draft.terms["seller"] ?? "").toLowerCase() === want && (draft.terms["seller"] ?? "") !== "") authorized = true;
        else if (deps.reader && deps.hub) authorized = (await dealParty(deps.store, deps.reader, deps.hub, dealId, wallet)) !== null;
      }
      if (authorized) return { dealId, source: "draft", status: draft.status, terms: withAgreementDigest(draft.terms) };
      return reply.code(403).send(bad("Deal contents require party authentication"));
    }
    if (events.length > 0) return { dealId, source: "projection", phase: "UNKNOWN", events: events.length };
    return reply.code(404).send(bad("Unknown deal"));
  });

  app.get<{ Params: { dealId: string } }>("/deals/:dealId/confirmation", async (request, reply) => {
    if (!deps.reader) return reply.code(503).send(bad("No RPC configured"));
    try {
      const [safe, finalized] = await Promise.all([
        deps.reader.getBlockByTag("safe"),
        deps.reader.getBlockByTag("finalized"),
      ]);
      const events = await deps.store.getEventsByDeal(request.params.dealId);
      const latest = events.length > 0 ? events[events.length - 1]! : null;
      if (!latest) return { dealId: request.params.dealId, level: "pending" };
      return {
        dealId: request.params.dealId,
        level: confirmationLevel({
          txBlock: latest.blockNumber,
          safeBlock: safe ? safe.number : null,
          finalizedBlock: finalized ? finalized.number : null,
        }),
        txBlock: latest.blockNumber.toString(),
        safeBlock: safe ? safe.number.toString() : null,
        finalizedBlock: finalized ? finalized.number.toString() : null,
      };
    } catch {
      return reply.code(503).send(bad("Confirmation lookup failed"));
    }
  });

  app.get<{ Params: { dealId: string } }>("/deals/:dealId/recovery", async (request, reply) => {
    if (!deps.hub || deps.chainId === null) return reply.code(503).send(bad("Deployment not configured"));
    const dealId = request.params.dealId;
    const draft = await deps.store.getDraftByDeal(dealId);
    const events = await deps.store.getEventsByDeal(dealId);
    const txs = [...new Set(events.map((e) => e.txHash as `0x${string}`))];
    const tip = deps.hub ? await deps.store.getTip(deps.hub) : null;
    const zero = "0x0000000000000000000000000000000000000000000000000000000000000000";
    return buildRecoveryPackage({
      chainId: deps.chainId,
      hub: deps.hub,
      usdc: deps.usdc,
      dealId: asHash(dealId, "dealId"),
      agreementDigest: (draft ? (withAgreementDigest(draft.terms)["agreementDigest"] as `0x${string}` | undefined) : undefined) ?? (zero as `0x${string}`),
      canonicalTerms: draft?.terms ?? {},
      // The DealTerms signatures the hub verifies at fund(); legacy acceptance
      // signatures are a fallback for drafts signed before they existed.
      signatures: {
        buyer: ((draft?.signatures["dealTerms:buyer"] ?? draft?.signatures["buyer"]) as `0x${string}` | undefined) ?? (zero as `0x${string}`),
        seller: ((draft?.signatures["dealTerms:seller"] ?? draft?.signatures["seller"]) as `0x${string}` | undefined) ?? (zero as `0x${string}`),
      },
      policyIds: Object.fromEntries(Object.entries(draft?.terms ?? {}).filter(([k]) => k.startsWith("policy:"))),
      relevantTransactions: txs,
      indexerTip: tip ? { blockNumber: tip.blockNumber.toString(), blockHash: tip.blockHash as `0x${string}` } : null,
    });
  });

  // ---- Relay outbox (durable, idempotent) ----
  const RELAY_ACTIONS = new Set([
    "openDispute",
    "escalate",
    "postRespondentBond",
    "submitEvidenceCommitment",
    "approveSeller",
    "refundBuyer",
    "mutualSettlement",
    "markDelivered",
    "finalizeAfterTimeout",
    "refundForNonDelivery",
    "lapseDispute",
    "advanceToPrimary",
    "activateFallback",
    "queuePrimaryRuling",
    "queueFallbackRuling",
    "vetoPrimaryRuling",
    "vetoFallbackRuling",
    "executeRuling",
    "markDeadlock",
    "catastrophicEscape",
    "claimFor",
    "fund",
  ]);

  app.post<{ Body: Record<string, unknown> }>("/relay/submit", async (request, reply) => {
    const idempotencyKey = String(request.body["idempotencyKey"] ?? "");
    const action = String(request.body["action"] ?? "");
    const params = request.body["params"];
    if (!idempotencyKey || !RELAY_ACTIONS.has(action) || !params || typeof params !== "object") {
      return reply.code(400).send(bad("Invalid relay submission"));
    }
    const { inserted, existing } = await deps.store.enqueueRelay({
      idempotencyKey,
      queue: "relay",
      action,
      params: params as Record<string, unknown>,
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    auditLog({ actor: "relay-client", action: `relay.${action}`, details: { idempotencyKey, inserted } });
    return { idempotencyKey, inserted, status: existing ? existing.status : "queued" };
  });

  app.get<{ Params: { key: string } }>("/relay/:key", async (request, reply) => {
    const job = await deps.store.getRelay(request.params.key);
    if (!job) return reply.code(404).send(bad("Unknown relay job"));
    return job;
  });

  // ---- Indexer operations ----
  app.post("/indexer/tick", async (_request, reply) => {
    if (!deps.indexer) return reply.code(503).send(bad("Indexer not configured (need HUB_ADDRESS + RPC)"));
    try {
      return await deps.indexer.tick();
    } catch (error) {
      return reply.code(503).send(bad(error instanceof Error ? error.message : "Index tick failed"));
    }
  });

  app.post<{ Body: Record<string, unknown> }>("/indexer/replay", async (request, reply) => {
    if (!deps.indexer) return reply.code(503).send(bad("Indexer not configured (need HUB_ADDRESS + RPC)"));
    const from = request.body["fromBlock"];
    await deps.indexer.replay(from !== undefined ? BigInt(String(from)) : undefined);
    return { ok: true };
  });

  // ---- Funding flow (audit finding #6): full 32-field DealTerms + fund() ----
  // Typed-data messages carry bigints (for wallets); JSON has no bigint, so
  // decimal strings are the transport convention (same as awards/terms).
  const jsonSafe = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)));

  app.get<{ Params: { id: string } }>("/drafts/:id/funding-bundle", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    if (draft.status === "revocation-noted") {
      return reply.code(403).send(bad("Deal terms have been noted for revocation"));
    }
    try {
      const bundle = await buildFundingBundle(deps.store, deps, draft.id, Math.floor(Date.now() / 1_000));
      return jsonSafe(bundle);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      return reply.code(status).send(bad(error instanceof Error ? error.message : "Invalid draft"));
    }
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/drafts/:id/deal-signatures",
    async (request, reply) => {
      try {
        const role = String(request.body["role"] ?? "");
        const signature = String(request.body["signature"] ?? "");
        const result = await storeDealSignature(deps.store, request.params.id, role, signature);
        auditLog({
          actor: result.signer,
          action: "draft.deal-sign",
          dealId: request.params.id,
          details: { role: result.role },
        });
        return { ok: true, role: result.role, signer: result.signer };
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply.code(status).send(bad(error instanceof Error ? error.message : "Invalid deal signature"));
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/drafts/:id/relay-fund",
    async (request, reply) => {
      const draft = await deps.store.getDraft(request.params.id);
      if (!draft) return reply.code(404).send(bad("Draft not found"));
      // Single canonical relay-fund contract (@midman/api-client): exact field
      // names sigBuyer/sigSeller + completed pay/allowance/admission/readiness
      // structs. Anything else is a 400 — no silent field-shape drift.
      let payload: {
        idempotencyKey: string;
        sigBuyer: string;
        sigSeller: string;
        pay: Payment3009Input;
        allowance: AllowanceIntentInput;
        admission: AdmissionInput;
        readiness: ReadinessAuthInput;
      };
      try {
        const validated = validateRelayFundPayload(request.body, "relay-fund");
        payload = {
          idempotencyKey: validated.idempotencyKey,
          sigBuyer: validated.sigBuyer,
          sigSeller: validated.sigSeller,
          pay: validated.pay,
          allowance: validated.allowance,
          admission: validated.admission,
          readiness: validated.readiness,
        };
      } catch (error) {
        return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid fund payload"));
      }
      const { idempotencyKey, sigBuyer, sigSeller, pay, allowance, admission, readiness } = payload;
      try {
        const terms = draft.terms as CanonicalTerms;
        const hub = (deps.hub ?? terms["hub"]!) as Address;
        const { fullTerms } = buildFullTerms(terms, hub);
        const data = buildFundCalldata({
          fullTerms,
          sigBuyer,
          sigSeller,
          pay: pay as unknown as Payment3009Input,
          allowance: allowance as unknown as AllowanceIntentInput,
          admission: admission as unknown as AdmissionInput,
          readiness: readiness as unknown as ReadinessAuthInput,
        });
        const { inserted, existing } = await deps.store.enqueueRelay({
          idempotencyKey,
          queue: "relay",
          action: "fund",
          params: { dealId: draft.dealId, data },
          status: "queued",
          attempts: 0,
          txHash: null,
          result: null,
        });
        auditLog({
          actor: "relay-fund",
          action: "relay.fund",
          dealId: draft.dealId,
          details: { idempotencyKey, inserted },
        });
        return { idempotencyKey, inserted, status: existing ? existing.status : "queued" };
      } catch (error) {
        return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid fund payload"));
      }
    },
  );

  app.get<{ Params: { id: string } }>("/drafts/:id/funding-status", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    if (!deps.reader || !deps.hub || !/^0x[0-9a-fA-F]{64}$/.test(draft.dealId)) {
      return { dealId: draft.dealId, source: "unconfigured" };
    }
    try {
      const deal = await deps.reader.getDeal(deps.hub, draft.dealId as Hash);
      const phaseIndex = Number(deal["phase"]);
      return {
        dealId: draft.dealId,
        source: "chain",
        funded: deal["funded"] === true,
        phase: PHASE_NAMES[phaseIndex] ?? "UNKNOWN",
        phaseIndex,
        settlementNonce: deal["settlementNonce"] === undefined ? "0" : String(deal["settlementNonce"]),
        fundedAt: deal["fundedAt"] === undefined ? null : String(deal["fundedAt"]),
        termsHash: typeof deal["termsHash"] === "string" ? deal["termsHash"] : null,
      };
    } catch {
      return { dealId: draft.dealId, source: "unconfigured", note: "chain read failed" };
    }
  });

  registerJourneyRoutes(app, deps);
}
