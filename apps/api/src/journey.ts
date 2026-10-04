// Journey endpoints: readable summaries, full-term exports, transaction
// confirmation levels, and fund-time readiness payloads. Contract state is
// authoritative; everything here is an off-chain view or signing payload.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Address, Hash } from "viem";
import { confirmationLevel, TYPES as EIP712_TYPES, type ChainReader } from "@midman/chain";
import type { RouteDeps } from "./routes.js";
import { acceptanceTypedData, type CanonicalTerms } from "./terms.js";
import { buildFullTerms, fullTermsDomain } from "./fullTerms.js";
import {
  AGREEMENT_WARNINGS,
  CATASTROPHIC_DAYS,
  CATASTROPHIC_FEES_COPY,
  CATASTROPHIC_SPLIT_COPY,
  ESCALATION_HOURS,
  EXECUTION_DELAYS_COPY,
  FEE_FORMULA_COPY,
  MIN_BOND_UNITS,
  NEGOTIATION_HOURS,
  QUORUM_TIERS_COPY,
} from "./policyCopy.js";

// Receipt lookup is part of the ChainReader contract (viem-backed readers
// implement it; absence yields 503, never a crash).

// Canonical @midman/chain ReadinessConsent definition (matches
// DealTypes.sol READINESS_TYPEHASH field order).
export const READINESS_TYPES = {
  ReadinessConsent: EIP712_TYPES.ReadinessConsent,
} as const;

// P-11: buyer readiness attestation is valid for 2h before funding.
export const READINESS_EXPIRY_SECONDS = 7_200;

export function registerJourneyRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const bad = (message: string): { error: string } => ({ error: message });

  app.get<{ Params: { id: string } }>("/drafts/:id/summary", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    try {
      const terms = draft.terms;
      const principal = BigInt(terms["principalUnits"]!);
      const quoted = BigInt(terms["quotedFeeUnits"]!);
      const effectiveFeeBps = ((quoted * 10_000n) / principal).toString();
      return {
        dealId: terms["dealId"],
        parties: {
          buyer: terms["buyer"],
          seller: terms["seller"],
          payouts: {
            sellerPayout: terms["sellerPayout"] ?? terms["seller"],
            buyerRefund: terms["buyerRefund"] ?? terms["buyer"],
            buyerBondRefund: terms["buyerBondRefund"] ?? terms["buyer"],
            sellerBondRefund: terms["sellerBondRefund"] ?? terms["seller"],
          },
        },
        amounts: {
          principalUnits: terms["principalUnits"],
          quotedFeeUnits: terms["quotedFeeUnits"],
          fundedUnits: terms["fundedUnits"],
          effectiveFeeBps,
        },
        schedule: {
          deliverySeconds: terms["deliverySeconds"],
          inspectionSeconds: terms["inspectionSeconds"],
          fundingDeadline: terms["fundingDeadline"],
        },
        feeFormula: FEE_FORMULA_COPY,
        dispute: {
          oneFreeDispute: true,
          negotiationHours: NEGOTIATION_HOURS,
          escalationHours: ESCALATION_HOURS,
          minBondUnits: MIN_BOND_UNITS,
          quorumTiers: QUORUM_TIERS_COPY,
          executionDelays: EXECUTION_DELAYS_COPY,
        },
        catastrophic: {
          days: CATASTROPHIC_DAYS,
          split: CATASTROPHIC_SPLIT_COPY,
          fees: CATASTROPHIC_FEES_COPY,
        },
        warnings: [...AGREEMENT_WARNINGS],
      };
    } catch (error) {
      return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid terms"));
    }
  });

  app.get<{ Params: { id: string } }>("/drafts/:id/download", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    try {
      const terms = draft.terms as CanonicalTerms;
      const hub = (deps.hub ?? terms["hub"]!) as Address;
      const { fullTerms, agreementDigest } = buildFullTerms(terms, hub);
      reply.header("content-disposition", `attachment; filename="midman-deal-${terms["dealId"]}.json"`);
      return {
        canonicalTerms: draft.terms,
        fullTerms,
        agreementDigest,
        signatures: draft.signatures,
        acceptanceTypedData: acceptanceTypedData(terms),
        exportedAt: new Date().toISOString(),
        note: "Off-chain export. Funding requires both acceptance signatures plus an on-chain fund call with these exact terms; verify agreementDigest on-chain before funding.",
      };
    } catch (error) {
      return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid terms"));
    }
  });

  app.get<{ Params: { hash: string } }>("/tx/:hash/status", async (request, reply) => {
    const txHash = request.params.hash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return reply.code(400).send(bad("Invalid transaction hash"));
    const reader = deps.reader;
    if (!reader) {
      return reply.code(503).send({ error: "Receipt lookup unavailable", reason: "no chain reader configured" });
    }
    try {
      const receipt = await reader.getTransactionReceipt(txHash as Hash);
      if (!receipt) {
        return {
          txHash,
          level: "pending",
          status: null,
          blockNumber: null,
          safeBlock: null,
          finalizedBlock: null,
        };
      }
      const [safe, finalized] = await Promise.all([reader.getBlockByTag("safe"), reader.getBlockByTag("finalized")]);
      return {
        txHash,
        level: confirmationLevel({
          txBlock: receipt.blockNumber,
          safeBlock: safe ? safe.number : null,
          finalizedBlock: finalized ? finalized.number : null,
        }),
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        safeBlock: safe ? safe.number.toString() : null,
        finalizedBlock: finalized ? finalized.number.toString() : null,
      };
    } catch {
      return reply.code(503).send(bad("Receipt lookup failed"));
    }
  });

  app.post<{ Params: { id: string } }>("/drafts/:id/readiness-payload", async (request, reply) => {
    const draft = await deps.store.getDraft(request.params.id);
    if (!draft) return reply.code(404).send(bad("Draft not found"));
    if (!deps.hub || deps.chainId === null) return reply.code(503).send(bad("Deployment not configured"));
    try {
      const terms = draft.terms as CanonicalTerms;
      const { agreementDigest } = buildFullTerms(terms, deps.hub);
      const now = Math.floor(Date.now() / 1_000);
      const nonce = `0x${randomBytes(32).toString("hex")}` as Hash;
      return {
        domain: fullTermsDomain(deps.chainId, deps.hub),
        types: READINESS_TYPES,
        primaryType: "ReadinessConsent",
        message: {
          dealId: terms["dealId"]!,
          agreementDigest,
          buyer: terms["buyer"]!,
          attestedAt: String(now),
          nonce,
          expiresAt: String(now + READINESS_EXPIRY_SECONDS),
        },
      };
    } catch (error) {
      return reply.code(400).send(bad(error instanceof Error ? error.message : "Invalid terms"));
    }
  });
}
