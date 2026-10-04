// Reviewer console HTTP surface (Phase 9).
//
// Structural deps (ReviewRouteDeps): a subset of the API RouteDeps; extra
// fields are ignored, so server.ts can pass its own RouteDeps without
// modification. Someone else wires registerReviewRoutes into server.ts.
//
// Reviewer auth: the signed-request wallet from evidence/access.js
// (verifySignedRequest) that is either an assigned panel member for the deal
// or in REVIEWER_WALLETS (drills). Contract state stays authoritative: every
// mutating console output is a signing/relay payload, never a submission.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  encodeFunctionData,
  recoverTypedDataAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { HUB_ABI, PHASE_NAMES, TYPES as EIP712_TYPES, type ChainReader } from "@midman/chain";
import { MIN_BOND_UNITS } from "@midman/shared";
import type { Store } from "../db.js";
import { isReviewer, verifySignedRequest } from "../evidence/access.js";
import { getSharedRegistry } from "../evidence/registry.js";
import { deliveryForms } from "../categories/registry.js";
import {
  assignReviewers,
  getCase,
  listOpen,
  recordRecusal,
  reviewRegistry,
} from "./registry.js";
import { draftAward, findAwardDraft, getAwardDrafts } from "./awards.js";
import {
  getApprovalProgress,
  getApprovalSignatures,
  listApprovalProgress,
  quorumComplete,
  quorumNeed,
  recordApproval,
} from "./approvals.js";
import {
  acceptProposal,
  getProposal,
  listProposals,
  proposeSettlement,
} from "./proposals.js";

/** Structural deps: a subset of the API RouteDeps; extra fields are ignored. */
export interface ReviewRouteDeps {
  readonly store: Store;
  readonly reader: ChainReader | null;
  readonly hub: Address | null;
  readonly usdc: Address;
  readonly chainId: number | null;
  readonly rpcConfigured: boolean;
}

export const VETO_TYPES = {
  VetoRuling: EIP712_TYPES.VetoRuling,
} as const;

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const UNITS_RE = /^[0-9]+$/;

const SELF_RESOLUTION_SECONDS = 86_400;
const ESCALATION_WINDOW_SECONDS = 86_400;
const RESPONDENT_EVIDENCE_SECONDS = 86_400;
const PRIMARY_REVIEW_SECONDS = 604_800;
const FALLBACK_REVIEW_SECONDS = 604_800;
const CATASTROPHIC_ESCAPE_SECONDS = 5_184_000;

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function replyError(reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown): unknown {
  const statusCode =
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
  return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Review request failed" });
}

type DealRecord = Record<string, bigint | string | boolean | number>;

function jsonDeal(deal: DealRecord | null): Record<string, string | boolean | number | null> | null {
  if (!deal) return null;
  const out: Record<string, string | boolean | number | null> = {};
  for (const [key, value] of Object.entries(deal)) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") out[key] = value;
    else out[key] = null;
  }
  return out;
}

async function readChainDeal(deps: ReviewRouteDeps, dealId: string): Promise<DealRecord | null> {
  if (!deps.reader || !deps.hub || !BYTES32_RE.test(dealId)) return null;
  try {
    return await deps.reader.getDeal(deps.hub, dealId as Hash);
  } catch {
    return null;
  }
}

function num(value: bigint | string | boolean | number | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return 0;
}

function policiesAddress(): Address | null {
  const raw = process.env["POLICIES_ADDRESS"] ?? "";
  return ADDRESS_RE.test(raw) ? (raw as Address) : null;
}

/** Signed-request wallet that is an assigned panel member OR in REVIEWER_WALLETS (drills). */
async function authReviewer(req: FastifyRequest, dealId?: string): Promise<Address> {
  const wallet = await verifySignedRequest(req);
  if (dealId) {
    const tracked = getCase(dealId);
    if (tracked) {
      const member = [...tracked.primary, ...tracked.fallback].some(
        (entry) => entry.toLowerCase() === wallet.toLowerCase(),
      );
      if (member) return wallet;
    }
  } else {
    const tracked = listOpen();
    if (tracked.some((c) => [...c.primary, ...c.fallback].some((m) => m.toLowerCase() === wallet.toLowerCase()))) {
      return wallet;
    }
  }
  if (isReviewer(wallet)) return wallet;
  throw httpError(403, "Wallet is not an assigned reviewer");
}

/** Deal party (buyer/seller) via chain-first lookup, else the draft projection. */
async function authParty(
  req: FastifyRequest,
  dealId: string,
  deps: ReviewRouteDeps,
): Promise<{ wallet: Address; role: "buyer" | "seller" }> {
  const wallet = await verifySignedRequest(req);
  const want = wallet.toLowerCase();
  const chainDeal = await readChainDeal(deps, dealId);
  if (chainDeal) {
    const buyer = String(chainDeal["buyer"] ?? "").toLowerCase();
    const seller = String(chainDeal["seller"] ?? "").toLowerCase();
    if (buyer === want && buyer !== "") return { wallet, role: "buyer" };
    if (seller === want && seller !== "") return { wallet, role: "seller" };
    if (buyer !== "0x0000000000000000000000000000000000000000" && buyer !== "") {
      throw httpError(403, "Wallet is not a party to this deal");
    }
  }
  const draft = await deps.store.getDraftByDeal(dealId);
  if (draft) {
    if (String(draft.terms["buyer"] ?? "").toLowerCase() === want) return { wallet, role: "buyer" };
    if (String(draft.terms["seller"] ?? "").toLowerCase() === want) return { wallet, role: "seller" };
  }
  // Drill path: explicit proposal parties recorded off-chain also authorize.
  const proposals = listProposals(dealId);
  for (const proposal of proposals) {
    if (proposal.buyer?.toLowerCase() === want) return { wallet, role: "buyer" };
    if (proposal.seller?.toLowerCase() === want) return { wallet, role: "seller" };
  }
  throw httpError(403, "Wallet is not a party to this deal");
}

async function authPartyOrReviewer(
  req: FastifyRequest,
  dealId: string,
  deps: ReviewRouteDeps,
): Promise<{ wallet: Address }> {
  try {
    return await authParty(req, dealId, deps);
  } catch (partyError) {
    try {
      return { wallet: await authReviewer(req, dealId) };
    } catch {
      throw partyError;
    }
  }
}

interface DeadlineSummary {
  readonly evidenceEnd: string | null;
  readonly primaryEnd: string | null;
  readonly fallbackEnd: string | null;
  readonly escapeAt: string | null;
  readonly secondsToEvidenceEnd: number | null;
  readonly secondsToEscape: number | null;
}

/** Stage + deadline summary from chain timestamps (nulls when chain is unreadable). */
function deadlineSummary(chainDeal: DealRecord | null, nowSeconds: number): DeadlineSummary {
  if (!chainDeal) {
    return {
      evidenceEnd: null,
      primaryEnd: null,
      fallbackEnd: null,
      escapeAt: null,
      secondsToEvidenceEnd: null,
      secondsToEscape: null,
    };
  }
  const escalatedAt = num(chainDeal["escalatedAt"]);
  const disputeOpenedAt = num(chainDeal["disputeOpenedAt"]);
  const evidenceEnd = escalatedAt > 0 ? escalatedAt + RESPONDENT_EVIDENCE_SECONDS : 0;
  const primaryEnd = evidenceEnd > 0 ? evidenceEnd + PRIMARY_REVIEW_SECONDS : 0;
  const fallbackEnd = primaryEnd > 0 ? primaryEnd + FALLBACK_REVIEW_SECONDS : 0;
  const escapeAt = disputeOpenedAt > 0 ? disputeOpenedAt + CATASTROPHIC_ESCAPE_SECONDS : 0;
  return {
    evidenceEnd: evidenceEnd > 0 ? String(evidenceEnd) : null,
    primaryEnd: primaryEnd > 0 ? String(primaryEnd) : null,
    fallbackEnd: fallbackEnd > 0 ? String(fallbackEnd) : null,
    escapeAt: escapeAt > 0 ? String(escapeAt) : null,
    secondsToEvidenceEnd: evidenceEnd > 0 ? evidenceEnd - nowSeconds : null,
    secondsToEscape: escapeAt > 0 ? escapeAt - nowSeconds : null,
  };
}

export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  // GET /review/queue — tracked deals in dispute phases 2-8 with stage + deadlines.
  app.get("/review/queue", async (req, reply) => {
    try {
      await authReviewer(req);
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const queue: Record<string, unknown>[] = [];
      for (const tracked of listOpen()) {
        const chainDeal = await readChainDeal(deps, tracked.dealId);
        const phaseIndex = chainDeal ? num(chainDeal["phase"]) : -1;
        const inDispute = phaseIndex >= 2 && phaseIndex <= 8;
        queue.push({
          dealId: tracked.dealId,
          source: chainDeal ? "chain" : "projection",
          phase: chainDeal ? (PHASE_NAMES[phaseIndex] ?? "UNKNOWN") : "UNKNOWN",
          phaseIndex: chainDeal ? phaseIndex : null,
          inDispute: chainDeal ? inDispute : null,
          stage: chainDeal ? (PHASE_NAMES[phaseIndex] ?? "UNKNOWN") : "unknown",
          deadlines: deadlineSummary(chainDeal, nowSeconds),
          primaryEligible: reviewRegistry.eligible(tracked.dealId, "primary"),
          fallbackEligible: reviewRegistry.eligible(tracked.dealId, "fallback"),
          recusals: tracked.recusals.length,
        });
      }
      // Chain-filtered view: dispute phases 2-8 first, projections last.
      queue.sort((a, b) => Number(b["inDispute"] === true) - Number(a["inDispute"] === true));
      return { queue, filtered: "dispute phases 2-8 first; projections last" };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // GET /review/cases/:dealId — read-only bundle for the assigned reviewer.
  app.get<{ Params: { dealId: string } }>("/review/cases/:dealId", async (req, reply) => {
    try {
      const { dealId } = req.params;
      await authReviewer(req, dealId);
      const tracked = getCase(dealId);
      if (!tracked) return reply.code(404).send({ error: "Unknown review case" });
      const chainDeal = await readChainDeal(deps, dealId);
      const manifest = getSharedRegistry();
      const drafts = getAwardDrafts(dealId);
      const approvals = listApprovalProgress(dealId);
      const latest = drafts.length > 0 ? drafts[drafts.length - 1]! : null;
      return {
        dealId,
        chain: jsonDeal(chainDeal),
        evidence: { head: manifest.getHead(dealId), entries: manifest.getManifest(dealId) },
        deliveryForm: deliveryForms.get(dealId),
        primary: tracked.primary,
        fallback: tracked.fallback,
        recusals: tracked.recusals,
        remainingEligible: {
          primary: reviewRegistry.eligible(dealId, "primary"),
          fallback: reviewRegistry.eligible(dealId, "fallback"),
        },
        drafts,
        approvals,
        quorumNeed: latest ? quorumNeed(chainDeal, latest.origin) : quorumNeed(chainDeal, 0),
      };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // POST /review/cases/:dealId/assign {primary[], fallback[]}.
  app.post<{ Params: { dealId: string }; Body: { primary?: unknown; fallback?: unknown } }>(
    "/review/cases/:dealId/assign",
    async (req, reply) => {
      try {
        const { dealId } = req.params;
        await authReviewer(req, getCase(dealId) ? dealId : undefined);
        const body = (req.body ?? {}) as { primary?: string[]; fallback?: string[] };
        const record = assignReviewers(dealId, {
          primary: body.primary ?? [],
          fallback: body.fallback ?? [],
        });
        return record;
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );

  // POST /review/cases/:dealId/recuse {reviewer, reason} (reviewer-signed).
  app.post<{ Params: { dealId: string }; Body: { reviewer?: unknown; reason?: unknown } }>(
    "/review/cases/:dealId/recuse",
    async (req, reply) => {
      try {
        const { dealId } = req.params;
        const wallet = await authReviewer(req, dealId);
        const body = (req.body ?? {}) as { reviewer?: string; reason?: string };
        if (typeof body.reviewer !== "string" || body.reviewer.toLowerCase() !== wallet.toLowerCase()) {
          throw httpError(403, "Recusal must be signed by the recusing reviewer");
        }
        const record = recordRecusal(dealId, body.reviewer, String(body.reason ?? ""));
        return {
          ...record,
          remainingEligible: {
            primary: reviewRegistry.eligible(dealId, "primary"),
            fallback: reviewRegistry.eligible(dealId, "fallback"),
          },
          note: "Recusal does not halt the case; the recused signer counts as ABSENT for console quorum math. The contract still enforces quorum on-chain at queue time.",
        };
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );

  // POST /review/cases/:dealId/awards/draft.
  app.post<{ Params: { dealId: string } }>("/review/cases/:dealId/awards/draft", async (req, reply) => {
    try {
      const { dealId } = req.params;
      await authReviewer(req, dealId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const chainDeal = await readChainDeal(deps, dealId);
      const draft = draftAward({
        principalUnits: String(body["principalUnits"] ?? ""),
        quotedFeeUnits: String(body["quotedFeeUnits"] ?? ""),
        buyerFeeBps: Number(body["buyerFeeBps"] ?? 0) as 0 | 5000 | 10000,
        sellerAwardUnits: String(body["sellerAwardUnits"] ?? ""),
        claimantBondUnits: String(
          body["claimantBondUnits"] ?? (chainDeal ? String(chainDeal["claimantBond"] ?? "") : ""),
        ),
        respondentBondUnits: String(
          body["respondentBondUnits"] ?? (chainDeal ? String(chainDeal["respondentBond"] ?? "") : ""),
        ),
        evidenceCommitment: String(body["evidenceCommitment"] ?? ""),
        origin: Number(body["origin"] ?? 0),
        rulingNonce: String(body["rulingNonce"] ?? ""),
        authEpoch: (body["authEpoch"] as string | number) ?? "0",
        queueExpiry: (body["queueExpiry"] as string | number) ?? "0",
        arbitrationPolicyId: String(
          body["arbitrationPolicyId"] ?? (chainDeal ? String(chainDeal["arbitrationPolicyId"] ?? "") : ""),
        ),
        dealId,
        agreementDigest: String(
          body["agreementDigest"] ?? (chainDeal ? String(chainDeal["termsHash"] ?? "") : ""),
        ),
        chainId: deps.chainId ?? Number(body["chainId"] ?? 0),
        hub: deps.hub ?? String(body["hub"] ?? ""),
      });
      return draft;
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // POST /review/cases/:dealId/approvals {signer, signature, rulingDigest, epoch, origin}.
  app.post<{ Params: { dealId: string } }>("/review/cases/:dealId/approvals", async (req, reply) => {
    try {
      const { dealId } = req.params;
      await authReviewer(req, dealId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const chainDeal = await readChainDeal(deps, dealId);
      const progress = await recordApproval(
        dealId,
        {
          signer: String(body["signer"] ?? ""),
          signature: String(body["signature"] ?? ""),
          rulingDigest: String(body["rulingDigest"] ?? ""),
          epoch: (body["epoch"] as string | number) ?? "",
          origin: Number(body["origin"] ?? 0),
        },
        { reader: deps.reader, policies: policiesAddress(), chainDeal },
      );
      return progress;
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // POST /review/cases/:dealId/queue-ruling — quorum-gated calldata + relay payload, NOT submitted.
  app.post<{ Params: { dealId: string } }>("/review/cases/:dealId/queue-ruling", async (req, reply) => {
    try {
      const { dealId } = req.params;
      await authReviewer(req, dealId);
      if (!deps.hub) return reply.code(503).send({ error: "Deployment not configured" });
      const body = (req.body ?? {}) as { rulingDigest?: string };
      const drafts = getAwardDrafts(dealId);
      if (drafts.length === 0) return reply.code(404).send({ error: "No draft award for this case" });
      const draft =
        (typeof body.rulingDigest === "string" ? findAwardDraft(dealId, body.rulingDigest) : null) ??
        drafts[drafts.length - 1]!;
      if (!quorumComplete(dealId, draft.rulingDigest)) {
        const progress = getApprovalProgress(dealId, draft.rulingDigest);
        return reply.code(409).send({
          error: "Quorum not reached",
          have: progress?.have ?? 0,
          need: progress?.need ?? quorumNeed(await readChainDeal(deps, dealId), draft.origin),
          signers: progress?.signers ?? [],
        });
      }
      // Recused-filtered active signatures only.
      const { getApprovalSignatures } = await import("./approvals.js");
      const signatures = getApprovalSignatures(dealId, draft.rulingDigest) as Hex[];
      const ruling = {
        origin: draft.origin,
        rulingNonce: draft.rulingNonce as Hex,
        sellerAward: BigInt(draft.sellerAward),
        buyerCost: BigInt(draft.buyerCost),
        sellerCost: BigInt(draft.sellerCost),
        evidenceCommitment: draft.evidenceCommitment as Hex,
        authEpoch: BigInt(draft.authEpoch),
        queueExpiry: BigInt(draft.queueExpiry),
        signatures,
      };
      // JSON-safe copy (exact decimal strings): raw bigints are encode-only.
      const rulingJson = {
        origin: draft.origin,
        rulingNonce: draft.rulingNonce,
        sellerAward: draft.sellerAward,
        buyerBondCost: draft.buyerCost,
        sellerBondCost: draft.sellerCost,
        evidenceCommitment: draft.evidenceCommitment,
        authEpoch: draft.authEpoch,
        queueExpiry: draft.queueExpiry,
        signatures,
      };
      const action = draft.origin === 1 ? "queueFallbackRuling" : "queuePrimaryRuling";
      const calldata = encodeFunctionData({
        abi: HUB_ABI,
        functionName: action,
        args: [draft.dealId as Hex, ruling],
      });
      const idempotencyKey = `ruling-${dealId.slice(2, 14)}-${draft.rulingDigest.slice(2, 14)}`;
      return {
        dealId,
        rulingDigest: draft.rulingDigest,
        origin: draft.origin,
        signatures,
        calldata,
        relayPayload: {
          idempotencyKey,
          action,
          params: {
            dealId,
            ruling: rulingJson,
            rulingDigest: draft.rulingDigest,
            calldata,
          },
        },
        note: "Quorum reached. This payload was NOT submitted; submit via POST /relay/submit.",
      };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // POST /review/cases/:dealId/veto — cancel-only veto payload + relay payload.
  app.post<{ Params: { dealId: string } }>("/review/cases/:dealId/veto", async (req, reply) => {
    try {
      const { dealId } = req.params;
      if (!BYTES32_RE.test(dealId)) throw httpError(400, "Invalid dealId");
      const wallet = await verifySignedRequest(req);
      if (!deps.hub || deps.chainId === null) {
        return reply.code(503).send({ error: "Deployment not configured" });
      }
      const body = (req.body ?? {}) as {
        rulingDigest?: unknown;
        origin?: unknown;
        vsigs?: unknown;
      };
      if (typeof body.rulingDigest !== "string" || !BYTES32_RE.test(body.rulingDigest)) {
        throw httpError(400, "Invalid rulingDigest");
      }
      const origin = body.origin === undefined ? 0 : Number(body.origin);
      if (origin !== 0 && origin !== 1) throw httpError(400, "origin must be 0 (primary) or 1 (fallback)");
      if (!Array.isArray(body.vsigs) || body.vsigs.length === 0) {
        throw httpError(400, "vsigs must be a non-empty array");
      }
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const verified: { authority: string; nonce: string; expiry: string; signature: string }[] = [];
      for (const [i, entry] of body.vsigs.entries()) {
        const vsig = entry as Record<string, unknown>;
        if (typeof vsig["authority"] !== "string" || !ADDRESS_RE.test(vsig["authority"])) {
          throw httpError(400, `Invalid authority in vsigs[${i}]`);
        }
        if (typeof vsig["nonce"] !== "string" || !BYTES32_RE.test(vsig["nonce"])) {
          throw httpError(400, `Invalid nonce in vsigs[${i}]`);
        }
        const expiryRaw = typeof vsig["expiry"] === "number" ? String(vsig["expiry"]) : vsig["expiry"];
        if (typeof expiryRaw !== "string" || !UNITS_RE.test(expiryRaw) || BigInt(expiryRaw) <= BigInt(nowSeconds)) {
          throw httpError(400, `Invalid expiry in vsigs[${i}]`);
        }
        if (typeof vsig["signature"] !== "string" || !HEX_RE.test(vsig["signature"])) {
          throw httpError(400, `Invalid signature in vsigs[${i}]`);
        }
        let recovered: Address;
        try {
          recovered = await recoverTypedDataAddress({
            domain: {
              name: "MidmanEscrow",
              version: "1",
              chainId: deps.chainId,
              verifyingContract: deps.hub,
            },
            types: VETO_TYPES,
            primaryType: "VetoRuling",
            // EIP-712 field name is `expiresAt` per VETO_TYPEHASH in
            // DealTypes.sol (canonical @midman/chain VetoRuling). The
            // transport/tuple field stays `expiry` to match the on-chain
            // VetoSig struct member and existing clients.
            message: {
              dealId: dealId as Hash,
              rulingDigest: body.rulingDigest as Hash,
              authority: vsig["authority"] as Address,
              nonce: vsig["nonce"] as Hash,
              expiresAt: BigInt(expiryRaw),
            },
            signature: vsig["signature"] as Hash,
          });
        } catch {
          throw httpError(400, `Unrecoverable veto signature in vsigs[${i}]`);
        }
        if (recovered.toLowerCase() !== (vsig["authority"] as string).toLowerCase()) {
          throw httpError(400, `Veto signature does not recover to authority in vsigs[${i}]`);
        }
        verified.push({
          authority: vsig["authority"] as string,
          nonce: vsig["nonce"] as string,
          expiry: BigInt(expiryRaw).toString(),
          signature: vsig["signature"] as string,
        });
      }
      const walletOk =
        isReviewer(wallet) ||
        verified.some((v) => v.authority.toLowerCase() === wallet.toLowerCase());
      if (!walletOk) throw httpError(403, "Wallet is not a veto authority or reviewer");
      const action = origin === 1 ? "vetoFallbackRuling" : "vetoPrimaryRuling";
      const calldata = encodeFunctionData({
        abi: HUB_ABI,
        functionName: action,
        args: [
          dealId as Hex,
          body.rulingDigest as Hex,
          verified.map((v) => ({
            authority: v.authority as Hex,
            nonce: v.nonce as Hex,
            expiry: BigInt(v.expiry),
            signature: v.signature as Hex,
          })),
        ],
      });
      const idempotencyKey = `veto-${dealId.slice(2, 14)}-${(body.rulingDigest as string).slice(2, 14)}`;
      return {
        dealId,
        rulingDigest: body.rulingDigest,
        origin,
        effect: "cancel-only",
        authorities: verified.map((v) => v.authority),
        vsigs: verified,
        calldata,
        relayPayload: {
          idempotencyKey,
          action,
          params: { dealId, rulingDigest: body.rulingDigest, vsigs: verified, calldata },
        },
        note: "Veto is cancel-only: it cancels the queued ruling and carries no replacement payout and no redirection. This payload was NOT submitted; submit via POST /relay/submit.",
      };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // GET /deals/:dealId/escalation — bond requirements + window countdowns.
  app.get<{ Params: { dealId: string } }>("/deals/:dealId/escalation", async (req, reply) => {
    try {
      const { dealId } = req.params;
      if (!BYTES32_RE.test(dealId)) throw httpError(400, "Invalid dealId");
      await verifySignedRequest(req);
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const chainDeal = await readChainDeal(deps, dealId);
      let claimantBond = MIN_BOND_UNITS.toString();
      let respondentBond = MIN_BOND_UNITS.toString();
      let source: "chain" | "estimated" = "estimated";
      const policies = policiesAddress();
      const withPolicy = deps.reader as unknown as {
        getBondPolicy?: (policies: Address, id: Hash) => Promise<{ claimantBond: bigint; respondentBond: bigint }>;
      } | null;
      if (chainDeal && deps.reader && policies && withPolicy && typeof withPolicy.getBondPolicy === "function") {
        const policyId = chainDeal["bondPolicyId"];
        if (typeof policyId === "string" && BYTES32_RE.test(policyId)) {
          try {
            const policy = await withPolicy.getBondPolicy(policies, policyId as Hash);
            claimantBond = policy.claimantBond.toString();
            respondentBond = policy.respondentBond.toString();
            source = "chain";
          } catch {
            source = "estimated";
          }
        }
      }
      const fundedAt = chainDeal ? num(chainDeal["fundedAt"]) : 0;
      const deliveredAt = chainDeal ? num(chainDeal["deliveredAt"]) : 0;
      const disputeOpenedAt = chainDeal ? num(chainDeal["disputeOpenedAt"]) : 0;
      const escalatedAt = chainDeal ? num(chainDeal["escalatedAt"]) : 0;
      const selfResolutionEnd = deliveredAt > 0 ? deliveredAt + SELF_RESOLUTION_SECONDS : null;
      const escalationEnd =
        disputeOpenedAt > 0 ? disputeOpenedAt + SELF_RESOLUTION_SECONDS + ESCALATION_WINDOW_SECONDS : null;
      return {
        dealId,
        claimantBond,
        respondentBond,
        source,
        estimated: source === "estimated",
        policyNote:
          source === "chain"
            ? "Exact amounts read from the chain bond policy."
            : "Chain bond policy unreadable; showing policy-minimum fallback (flagged estimated). Contract values govern.",
        windows: {
          now: String(nowSeconds),
          fundedAt: chainDeal ? String(fundedAt) : null,
          deliveredAt: chainDeal ? String(deliveredAt) : null,
          disputeOpenedAt: chainDeal ? String(disputeOpenedAt) : null,
          escalatedAt: chainDeal ? String(escalatedAt) : null,
          selfResolutionEnd: selfResolutionEnd !== null ? String(selfResolutionEnd) : null,
          escalationEnd: escalationEnd !== null ? String(escalationEnd) : null,
          deadlines: deadlineSummary(chainDeal, nowSeconds),
        },
      };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // POST /deals/:dealId/settlement-proposals (deal-party bounded mutual path).
  app.post<{ Params: { dealId: string } }>("/deals/:dealId/settlement-proposals", async (req, reply) => {
    try {
      const { dealId } = req.params;
      const { wallet } = await authParty(req, dealId, deps);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (
        typeof body["proposer"] === "string" &&
        (body["proposer"] as string).toLowerCase() !== wallet.toLowerCase()
      ) {
        throw httpError(403, "proposer must match the authenticated wallet");
      }
      const chainDeal = await readChainDeal(deps, dealId);
      const str = (key: string): string | undefined =>
        body[key] === undefined ? undefined : String(body[key]);
      const principalUnits = str("principalUnits");
      const claimantBondUnits = str("claimantBondUnits");
      const respondentBondUnits = str("respondentBondUnits");
      const agreementDigest = str("agreementDigest");
      const settlementNonce = str("settlementNonce");
      const buyer = str("buyer");
      const seller = str("seller");
      const proposerSignature = str("proposerSignature");
      const hub = str("hub");
      const proposal = proposeSettlement(
        dealId,
        {
          proposer: wallet,
          sellerAwardUnits: String(body["sellerAwardUnits"] ?? ""),
          buyerCostUnits: String(body["buyerCostUnits"] ?? ""),
          sellerCostUnits: String(body["sellerCostUnits"] ?? ""),
          expectedPhase: Number(body["expectedPhase"] ?? 4),
          ...(principalUnits !== undefined ? { principalUnits } : {}),
          ...(claimantBondUnits !== undefined ? { claimantBondUnits } : {}),
          ...(respondentBondUnits !== undefined ? { respondentBondUnits } : {}),
          ...(agreementDigest !== undefined ? { agreementDigest } : {}),
          ...(settlementNonce !== undefined ? { settlementNonce } : {}),
          ...(body["expiresAt"] === undefined
            ? {}
            : { expiresAt: body["expiresAt"] as string | number }),
          ...(buyer !== undefined ? { buyer } : {}),
          ...(seller !== undefined ? { seller } : {}),
          ...(proposerSignature !== undefined ? { proposerSignature } : {}),
          ...(body["chainId"] === undefined ? {} : { chainId: Number(body["chainId"]) }),
          ...(hub !== undefined ? { hub } : {}),
        },
        { chainDeal, chainId: deps.chainId, hub: deps.hub },
      );
      return proposal;
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // GET /deals/:dealId/settlement-proposals.
  app.get<{ Params: { dealId: string } }>("/deals/:dealId/settlement-proposals", async (req, reply) => {
    try {
      const { dealId } = req.params;
      await authPartyOrReviewer(req, dealId, deps);
      return { dealId, proposals: listProposals(dealId) };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // POST /settlement-proposals/:id/accept.
  app.post<{ Params: { id: string } }>("/settlement-proposals/:id/accept", async (req, reply) => {
    try {
      const proposal = getProposal(req.params.id);
      if (!proposal) return reply.code(404).send({ error: "Unknown settlement proposal" });
      const { wallet } = await authParty(req, proposal.dealId, deps);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (
        typeof body["counterparty"] === "string" &&
        (body["counterparty"] as string).toLowerCase() !== wallet.toLowerCase()
      ) {
        throw httpError(403, "counterparty must match the authenticated wallet");
      }
      const proposerSig = body["proposerSignature"];
      const result = await acceptProposal(req.params.id, {
        counterparty: wallet,
        signature: String(body["signature"] ?? ""),
        ...(proposerSig === undefined ? {} : { proposerSignature: String(proposerSig) }),
      });
      return result;
    } catch (error) {
      return replyError(reply, error);
    }
  });
}
