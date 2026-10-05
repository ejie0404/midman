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
  canExportOriginal,
  declaredContentSha256,
  dealParty,
  reviewerCanAccess,
  verifySignedRequest,
  type DealPartyReader,
  type DealPartyStore,
} from "./access.js";
import { getSharedBlobStore } from "./store.js";
import {
  GENESIS_PREVHASH,
  getSharedRegistry,
  isBlockedScanState,
  type ManifestEntry,
} from "./registry.js";
import { assertReceiptSignerConfigured, scanBytes, signReceipt, type SignedReceipt } from "./receipts.js";
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

/**
 * Normalized scan state. infected/quarantined/pending/error are not servable;
 * clean/deferred are servable (deferred is NEVER relabeled clean).
 */
export function scanStateOf(entry: ManifestEntry | undefined): string {
  if (!entry) return "missing";
  if (entry.quarantined === true) return "quarantined";
  return entry.scan.status;
}

function receiptRef(signed: SignedReceipt): {
  payload: string;
  signature: string;
  signer: string;
  keyId: string;
  version: number;
} {
  return {
    payload: signed.payload,
    signature: signed.signature,
    signer: signed.signer,
    keyId: signed.keyId,
    version: signed.version,
  };
}

export function registerEvidenceRoutes(app: FastifyInstance, deps: EvidenceRouteDeps): void {
  // Fail fast in production: a durable receipt signer must be configured.
  assertReceiptSignerConfigured();
  void app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  // POST /deals/:dealId/evidence — multipart {file, kind, description}.
  app.post<{ Params: { dealId: string } }>("/deals/:dealId/evidence", async (req, reply) => {
    try {
      const dealId = req.params.dealId;
      // Parse first so the signed metadata can be compared against the ACTUAL
      // uploaded fields (filename/mime/size/content hash).
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
      const actualContentSha = createHash("sha256").update(fileBytes).digest("hex");
      // Evidence MUTATIONS require the metadata-bound signature, bound to the
      // parsed upload values (a legacy/content-bound signature is rejected, and
      // the nonce is consumed durably so it cannot be replayed).
      const wallet = await verifySignedRequest(req, {
        requireMetadata: true,
        expected: { filename, mime: mimetype, size: String(fileBytes.length), fileHash: actualContentSha },
      });
      const role = await dealParty(deps.store, deps.reader, deps.hub, dealId, wallet);
      if (!role) throw httpError(403, "Wallet is not a party to this deal");
      const declaredContentSha = declaredContentSha256(req);
      if (declaredContentSha !== "" && declaredContentSha !== actualContentSha) {
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
      // Object storage first (idempotent by content hash), then commit exactly
      // one manifest entry, then issue the receipt. A retry of the same bytes
      // converges on the existing entry instead of duplicating it.
      await blobstore.put(dealId, check.fileHash, fileBytes);

      const existing = registry.getByFileHash(dealId, check.fileHash);
      if (existing) {
        let entry = existing;
        if (!entry.receipt) {
          const signed = await signReceipt({ dealId, seq: entry.seq, fileHash: check.fileHash });
          entry = await registry.attachReceiptAtomic(dealId, entry.seq, receiptRef(signed));
        }
        return {
          seq: entry.seq,
          fileHash: check.fileHash,
          commitment: entry.head,
          receipt: entry.receipt ?? null,
          duplicated: true,
          quarantined: entry.quarantined,
          scan: { status: entry.scan.status, detail: entry.scan.detail },
        };
      }

      // Malware hook: honestly recorded as deferred when ClamAV is unset.
      const scan = await scanBytes(fileBytes, filename);
      const quarantined = scan.status === "infected";
      const prevHash = registry.getHead(dealId);
      const { entry } = await registry.appendManifestAtomic(dealId, {
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
      const signed = await signReceipt({ dealId, seq: entry.seq, fileHash: check.fileHash });
      await registry.attachReceiptAtomic(dealId, entry.seq, receiptRef(signed));
      return {
        seq: entry.seq,
        fileHash: check.fileHash,
        commitment: entry.head,
        receipt: receiptRef(signed),
        duplicated: false,
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
  // `?exportOriginal=1&reason=` is the exceptional audited original export.
  app.get<{
    Params: { fileHash: string };
    Querystring: { dealId?: string; exportOriginal?: string; reason?: string };
  }>("/evidence/:fileHash", async (req, reply) => {
    try {
      const dealId = req.query.dealId ?? "";
      if (!dealId) return reply.code(400).send({ error: "Missing ?dealId=" });
      const { wallet } = await authPartyOrReviewer(req, dealId, deps);
      const registry = getSharedRegistry();
      // Object access REQUIRES a committed manifest entry.
      const entry = registry.getByFileHash(dealId, req.params.fileHash) ?? undefined;
      if (!entry) return reply.code(404).send({ error: "Unknown evidence object" });
      if (registry.isBlobPurged(dealId, entry.fileHash)) {
        return reply.code(404).send({ error: "Evidence blob was purged under retention policy" });
      }
      const stream = req.query.exportOriginal;
      const wantsOriginal = stream === "1" || stream?.toLowerCase() === "true";
      if (wantsOriginal) {
        if (!canExportOriginal(wallet)) {
          return reply.code(403).send({ error: "Wallet lacks the exceptional original-export permission" });
        }
        const reason = (req.query.reason ?? "").trim();
        if (reason === "") {
          return reply.code(400).send({ error: "?reason= is required for an audited original export" });
        }
        registry.recordAudit({
          actor: wallet,
          action: "evidence.export-original",
          dealId,
          target: entry.fileHash,
          reason,
          detail: `scan=${scanStateOf(entry)}`,
        });
      } else {
        const state = scanStateOf(entry);
        if (isBlockedScanState(state)) {
          return reply
            .code(409)
            .send({ error: "Evidence unavailable pending malware review", status: state });
        }
      }
      const bytes = await getSharedBlobStore().get(dealId, entry.fileHash);
      if (!bytes) return reply.code(404).send({ error: "Unknown file" });
      reply.header("content-type", entry.mimetype ?? "application/octet-stream");
      reply.header(
        "content-disposition",
        `attachment; filename="${entry.filename ?? "evidence.bin"}"`,
      );
      if (wantsOriginal) reply.header("x-evidence-original-export", "audited");
      return reply.send(bytes);
    } catch (error) {
      return replyError(reply, error);
    }
  });

  // GET /evidence/:fileHash/receipt?dealId= — receipt + signer for offline verify.
  app.get<{ Params: { fileHash: string }; Querystring: { dealId?: string } }>(
    "/evidence/:fileHash/receipt",
    async (req, reply) => {
      try {
        const dealId = req.query.dealId ?? "";
        if (!dealId) return reply.code(400).send({ error: "Missing ?dealId=" });
        await authPartyOrReviewer(req, dealId, deps);
        const registry = getSharedRegistry();
        const entry = registry.getByFileHash(dealId, req.params.fileHash);
        if (!entry) return reply.code(404).send({ error: "Unknown file" });
        if (entry.receipt) return { ...entry.receipt };
        const signed = await signReceipt({ dealId, seq: entry.seq, fileHash: entry.fileHash });
        await registry.attachReceiptAtomic(dealId, entry.seq, receiptRef(signed));
        return { ...receiptRef(signed) };
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
        const registry = getSharedRegistry();
        const entry = registry.getByFileHash(dealId, fileHash) ?? undefined;
        if (!entry) return reply.code(404).send({ ok: false, error: "Unknown evidence object" });
        if (registry.isBlobPurged(dealId, entry.fileHash)) {
          return reply.code(404).send({ ok: false, error: "Evidence blob was purged under retention policy" });
        }
        const state = scanStateOf(entry);
        if (isBlockedScanState(state)) {
          return reply
            .code(409)
            .send({ ok: false, status: state, error: "Evidence unavailable pending malware review" });
        }
        const bytes = await getSharedBlobStore().get(dealId, entry.fileHash);
        if (!bytes) return reply.code(404).send({ ok: false, error: "Unknown file" });
        const recomputed = `0x${createHash("sha256").update(bytes).digest("hex")}`;
        return { ok: recomputed.toLowerCase() === entry.fileHash.toLowerCase(), fileHash: entry.fileHash, recomputed };
      } catch (error) {
        return replyError(reply, error);
      }
    },
  );
}
