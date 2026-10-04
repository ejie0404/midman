// Evidence HTTP surface: encrypted uploads, append-only manifests, signed
// receipts, reviewer access, exports, and restore checks (P-12/P-13).
//
// RouteDeps note: ../routes.ts owns the full RouteDeps type, but importing
// it here would pull its whole module graph (chain reader, journey) into
// this subsystem and risk cycles, so a minimal structural interface is
// defined locally. Any superset (including the real RouteDeps) is assignable.
import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart = require("@fastify/multipart");
import { createHash } from "node:crypto";
import type { Address } from "viem";
import {
  declaredContentSha256,
  dealParty,
  reviewerCanAccess,
  verifySignedRequest,
  type DealPartyReader,
  type DealPartyStore,
} from "./access.js";
import { getSharedBlobStore } from "./store.js";
import { GENESIS_PREVHASH, getSharedRegistry } from "./registry.js";
import { scanBytes, signReceipt } from "./receipts.js";
import { MAX_UPLOAD_BYTES, validateUpload } from "./uploadChecks.js";

export interface EvidenceRouteDeps {
  readonly store: DealPartyStore;
  readonly reader: DealPartyReader | null;
  readonly hub: Address | null;
  readonly usdc: Address;
  readonly chainId: number | null;
  readonly rpcConfigured: boolean;
}

type PartyRole = "buyer" | "seller";

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function replyError(reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown): unknown {
  const statusCode =
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? ((error as { statusCode: number }).statusCode as number)
      : 500;
  const findings = (error as { findings?: unknown }).findings;
  const message = error instanceof Error ? error.message : "Evidence request failed";
  // Never log tokens/file bytes; error surfaces carry codes only.
  if (Array.isArray(findings)) return reply.code(statusCode).send({ error: message, findings });
  return reply.code(statusCode).send({ error: message });
}

async function authParty(req: FastifyRequest, dealId: string, deps: EvidenceRouteDeps): Promise<{
  wallet: Address;
  role: PartyRole;
}> {
  const wallet = await verifySignedRequest(req);
  const role = await dealParty(deps.store, deps.reader, deps.hub, dealId, wallet);
  if (!role) throw httpError(403, "Wallet is not a party to this deal");
  return { wallet, role };
}

async function authPartyOrReviewer(
  req: FastifyRequest,
  dealId: string,
  deps: EvidenceRouteDeps,
): Promise<{ wallet: Address; role: PartyRole | "reviewer" }> {
  const wallet = await verifySignedRequest(req);
  const role = await dealParty(deps.store, deps.reader, deps.hub, dealId, wallet);
  if (role) return { wallet, role };
  // Least privilege: assigned panel / per-deal allowlist (or explicit
  // supervisor fallback) only -- never a global roster across every case.
  if (reviewerCanAccess(dealId, wallet)) return { wallet, role: "reviewer" };
  throw httpError(403, "Wallet is not a party to this deal");
}

/** Content binding required for uploads in production, or when env opts in. */
function requireContentBinding(): boolean {
  const raw = process.env["EVIDENCE_REQUIRE_CONTENT_BINDING"];
  if (raw === undefined) return process.env["NODE_ENV"] === "production";
  return raw === "1" || raw.toLowerCase() === "true";
}

/** True when a manifest entry must not be served (infected/quarantined). */
function isQuarantined(entry: { quarantined?: boolean; scan?: { status?: string } } | undefined): boolean {
  if (!entry) return false;
  return entry.quarantined === true || entry.scan?.status === "infected";
}

export function registerEvidenceRoutes(app: FastifyInstance, deps: EvidenceRouteDeps): void {
  void app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  // POST /deals/:dealId/evidence — multipart {file, kind, description}.
  app.post<{ Params: { dealId: string } }>("/deals/:dealId/evidence", async (req, reply) => {
    try {
      const dealId = req.params.dealId;
      const { wallet } = await authParty(req, dealId, deps);
      let fileBytes: Buffer | null = null;
      let filename = "";
      let mimetype = "";
      let kind = "";
      let description = "";
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (fileBytes) return reply.code(400).send({ error: "Only one file per upload" });
          filename = part.filename || "upload.bin";
          mimetype = part.mimetype || "application/octet-stream";
          fileBytes = await part.toBuffer();
        } else {
          const value = typeof part.value === "string" ? part.value : String(part.value ?? "");
          if (part.fieldname === "kind") kind = value;
          else if (part.fieldname === "description") description = value;
        }
      }
      if (!fileBytes) return reply.code(400).send({ error: "Missing file part" });
      if (kind !== "delivery" && kind !== "dispute") {
        return reply.code(400).send({ error: "kind must be delivery or dispute" });
      }
      // Content-bound signature: the signed message commits to the file's
      // sha256, so replaying a signature against different bytes fails here.
      const declaredContentSha = declaredContentSha256(req);
      const actualContentSha = createHash("sha256").update(fileBytes).digest("hex");
      if (declaredContentSha === "") {
        if (requireContentBinding()) {
          return reply.code(400).send({ error: "x-content-sha256 is required for uploads" });
        }
      } else if (declaredContentSha !== actualContentSha) {
        return reply.code(400).send({ error: "x-content-sha256 does not match uploaded bytes" });
      }
      let check;
      try {
        check = validateUpload({ bytes: fileBytes, filename, mimetype, description });
      } catch (validationError) {
        return replyError(reply, validationError);
      }
      const blobstore = getSharedBlobStore();
      const registry = getSharedRegistry();
      await blobstore.put(dealId, check.fileHash, fileBytes);
      // Malware hook: honestly recorded as deferred when ClamAV is unset.
      const scan = await scanBytes(fileBytes, filename);
      const quarantined = scan.status === "infected";
      const prevHash = registry.getHead(dealId);
      const entry = registry.appendManifest(dealId, {
        uploader: wallet,
        kind,
        description,
        fileHash: check.fileHash,
        prevHash,
        scan: { status: scan.status, detail: scan.detail },
        filename,
        mimetype,
        size: check.size,
        quarantined,
      });
      const receipt = await signReceipt({ dealId, seq: entry.seq, fileHash: check.fileHash });
      registry.attachReceipt(dealId, entry.seq, receipt);
      return {
        seq: entry.seq,
        fileHash: check.fileHash,
        commitment: entry.head,
        receipt,
        quarantined,
        scan: { status: scan.status, detail: scan.detail },
      };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // GET /deals/:dealId/evidence — full manifest + head (party or reviewer).
  app.get<{ Params: { dealId: string } }>("/deals/:dealId/evidence", async (req, reply) => {
    try {
      const dealId = req.params.dealId;
      await authPartyOrReviewer(req, dealId, deps);
      const registry = getSharedRegistry();
      return { dealId, head: registry.getHead(dealId), entries: registry.getManifest(dealId) };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // GET /evidence/:fileHash?dealId= — attachment download (party/reviewer).
  app.get<{ Params: { fileHash: string }; Querystring: { dealId?: string } }>(
    "/evidence/:fileHash",
    async (req, reply) => {
      try {
        const dealId = req.query.dealId ?? "";
        if (!dealId) return reply.code(400).send({ error: "Missing ?dealId=" });
        await authPartyOrReviewer(req, dealId, deps);
        const entry = getSharedRegistry()
          .getManifest(dealId)
          .find((candidate) => candidate.fileHash.toLowerCase() === req.params.fileHash.toLowerCase());
        if (isQuarantined(entry)) {
          return reply
            .code(409)
            .send({ error: "Evidence quarantined pending malware review", status: "quarantined" });
        }
        const bytes = await getSharedBlobStore().get(dealId, req.params.fileHash);
        if (!bytes) return reply.code(404).send({ error: "Unknown file" });
        reply.header("content-type", entry?.mimetype ?? "application/octet-stream");
        reply.header("content-disposition", `attachment; filename="${entry?.filename ?? "evidence.bin"}"`);
        return reply.send(bytes);
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );

  // GET /evidence/:fileHash/receipt?dealId= — receipt + signer for offline verify.
  app.get<{ Params: { fileHash: string }; Querystring: { dealId?: string } }>(
    "/evidence/:fileHash/receipt",
    async (req, reply) => {
      try {
        const dealId = req.query.dealId ?? "";
        if (!dealId) return reply.code(400).send({ error: "Missing ?dealId=" });
        await authPartyOrReviewer(req, dealId, deps);
        const registry = getSharedRegistry();
        const entry = registry
          .getManifest(dealId)
          .find((candidate) => candidate.fileHash.toLowerCase() === req.params.fileHash.toLowerCase());
        if (!entry) return reply.code(404).send({ error: "Unknown file" });
        if (entry.receipt) return { ...entry.receipt };
        const receipt = await signReceipt({ dealId, seq: entry.seq, fileHash: entry.fileHash });
        registry.attachReceipt(dealId, entry.seq, receipt);
        return { ...receipt };
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );

  // GET /deals/:dealId/export — JSON bundle (manifest + receipts + metadata, no bytes).
  app.get<{ Params: { dealId: string } }>("/deals/:dealId/export", async (req, reply) => {
    try {
      const dealId = req.params.dealId;
      await authPartyOrReviewer(req, dealId, deps);
      const registry = getSharedRegistry();
      const entries = registry.getManifest(dealId);
      return {
        dealId,
        exportedAt: new Date().toISOString(),
        head: registry.getHead(dealId),
        count: entries.length,
        entries,
        receipts: entries.map((entry) => entry.receipt ?? null),
        tombstones: registry.getTombstones(dealId),
        metadata: { genesis: GENESIS_PREVHASH, bytesIncluded: false },
      };
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // POST /deals/:dealId/evidence/restore-check {fileHash} — re-decrypt + rehash.
  app.post<{ Params: { dealId: string }; Body: { fileHash?: string } }>(
    "/deals/:dealId/evidence/restore-check",
    async (req, reply) => {
      try {
        const dealId = req.params.dealId;
        await authPartyOrReviewer(req, dealId, deps);
        const fileHash = (req.body as { fileHash?: unknown } | undefined)?.fileHash;
        if (typeof fileHash !== "string" || fileHash === "") {
          return reply.code(400).send({ error: "Missing fileHash" });
        }
        const entry = getSharedRegistry()
          .getManifest(dealId)
          .find((candidate) => candidate.fileHash.toLowerCase() === fileHash.toLowerCase());
        if (isQuarantined(entry)) {
          return reply
            .code(409)
            .send({ ok: false, status: "quarantined", error: "Evidence quarantined pending malware review" });
        }
        const bytes = await getSharedBlobStore().get(dealId, fileHash);
        if (!bytes) return reply.code(404).send({ ok: false, error: "Unknown file" });
        const recomputed = `0x${createHash("sha256").update(bytes).digest("hex")}`;
        return { ok: recomputed.toLowerCase() === fileHash.toLowerCase(), fileHash, recomputed };
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
}
