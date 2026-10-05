// Audit finding #9 hardening: atomic per-deal key creation, durable-key
// production policy, KEK rotation with historical key preservation,
// content-bound upload signatures, least-privilege reviewer access, and
// malware-scan quarantine gating. Uses MemoryStore + a local temp dir only
// (no network; EVIDENCE_SCAN_FORCE stands in for ClamAV).
import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { registerEvidenceRoutes } from "../dist/evidence/routes.js";
import {
  LocalEncryptedStore,
  getSharedBlobStore,
  currentKekId,
  __resetBlobStoreForTests,
} from "../dist/evidence/store.js";
import { getSharedRegistry, __resetRegistryForTests } from "../dist/evidence/registry.js";
import { __resetReceiptSignerForTests } from "../dist/evidence/receipts.js";
import { assignReviewers, __resetReviewRegistryForTests } from "../dist/review/registry.js";
import { MemoryStore } from "../dist/db.js";
import {
  EVIDENCE_AUTH_APP,
  buildMetadataSignedMessage,
  evidenceAuthDomain,
} from "../dist/evidence/access.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KEK_A = "ab".repeat(32);
const KEK_B = "cd".repeat(32);
const RECEIPT_KEY = `0x${"ef".repeat(32)}`;

const buyer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"22".repeat(32)}`);
const third = privateKeyToAccount(`0x${"33".repeat(32)}`);
const revA = privateKeyToAccount(`0x${"44".repeat(32)}`);
const revB = privateKeyToAccount(`0x${"55".repeat(32)}`);
const revC = privateKeyToAccount(`0x${"66".repeat(32)}`);

const MANAGED_ENV = [
  "NODE_ENV",
  "EVIDENCE_KEK_HEX",
  "EVIDENCE_KEK_HISTORY",
  "EVIDENCE_DIR",
  "EVIDENCE_SCAN_FORCE",
  "EVIDENCE_SUPERVISOR",
  "EVIDENCE_REVIEWER_ALLOWLIST",
  "EVIDENCE_REQUIRE_CONTENT_BINDING",
  "REVIEWER_WALLETS",
  "RECEIPT_SIGNER_KEY",
  "CLAMAV_HOST",
  "CLAMAV_PORT",
];
const ORIGINAL_ENV = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));

let evidenceDir = "";
let draftCounter = 0;

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resetEnv() {
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env["EVIDENCE_KEK_HEX"] = KEK_A;
  process.env["EVIDENCE_DIR"] = evidenceDir;
  process.env["EVIDENCE_SCAN_FORCE"] = "deferred";
  process.env["RECEIPT_SIGNER_KEY"] = RECEIPT_KEY;
}

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "midman-evidence-hard-"));
  resetEnv();
  __resetBlobStoreForTests();
  __resetRegistryForTests();
  __resetReceiptSignerForTests();
  __resetReviewRegistryForTests();
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true }).catch(() => {});
});

after(() => {
  for (const key of MANAGED_ENV) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

async function signedHeaders(account, method, url, { bodyBytes = Buffer.alloc(0), contentSha } = {}) {
  const bodyHash = sha256hex(bodyBytes);
  const cs = contentSha ?? "";
  const expiry = String(Math.floor(Date.now() / 1_000) + 300);
  const message = `${method.toUpperCase()}\n${url}\n${bodyHash}\n${cs}\n${expiry}`;
  const signature = await account.signMessage({ message });
  const headers = {
    "x-wallet-address": account.address,
    "x-wallet-expiry": expiry,
    "x-wallet-signature": signature,
  };
  if (cs !== "") headers["x-content-sha256"] = cs;
  return headers;
}

/** Metadata-bound headers (required for evidence upload mutations). */
async function metaSignedHeaders(account, method, url, fields) {
  const { dealId, fileHash, filename, mime, size, bodyBytes = Buffer.alloc(0) } = fields;
  const expiry = String(Math.floor(Date.now() / 1_000) + 300);
  const nonce = randomBytes(16).toString("hex");
  const meta = {
    app: EVIDENCE_AUTH_APP,
    domain: evidenceAuthDomain(),
    method,
    path: url,
    dealId,
    action: "evidence.upload",
    fileHash,
    filename,
    mime,
    size: String(size),
    bodySha256: sha256hex(bodyBytes),
    nonce,
    expiry,
  };
  const signature = await account.signMessage({ message: buildMetadataSignedMessage(meta) });
  return {
    "x-wallet-address": account.address,
    "x-wallet-expiry": expiry,
    "x-wallet-signature": signature,
    "x-request-nonce": nonce,
    "x-request-action": "evidence.upload",
    "x-request-deal": dealId,
    "x-request-file": fileHash,
    "x-request-filename": filename,
    "x-request-mime": mime,
    "x-request-size": String(size),
  };
}

async function legacySignedHeaders(account, method, url, bodyBytes = Buffer.alloc(0)) {
  const bodyHash = sha256hex(bodyBytes);
  const expiry = String(Math.floor(Date.now() / 1_000) + 300);
  const message = `${method.toUpperCase()}\n${url}\n${bodyHash}\n${expiry}`;
  const signature = await account.signMessage({ message });
  return { "x-wallet-address": account.address, "x-wallet-expiry": expiry, "x-wallet-signature": signature };
}

function buildMultipartBody(boundary, fields, file) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  chunks.push(Buffer.from(file.bytes));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function makeApp() {
  const store = new MemoryStore();
  const app = Fastify({ logger: false });
  registerEvidenceRoutes(app, {
    store,
    reader: null,
    hub: null,
    usdc: USDC,
    chainId: 8453,
    rpcConfigured: false,
  });
  await app.ready();
  return { app, store };
}

async function seedDeal(store, dealId) {
  draftCounter += 1;
  await store.createDraft({
    id: `draft_${dealId.slice(2, 10)}_${draftCounter}`,
    dealId,
    creatorWallet: buyer.address,
    counterpartyHint: seller.address,
    counterpartyAddress: seller.address,
    terms: { buyer: buyer.address, seller: seller.address },
    signatures: {},
    admission: null,
    revocationNote: null,
    status: "accepted",
  });
}

async function upload(
  app,
  dealId,
  account,
  { bytes, filename, contentType, kind = "delivery", description = "delivery confirmation", contentSha, legacy = false },
) {
  const boundary = "----midman-hardening-boundary";
  const body = buildMultipartBody(boundary, { kind, description }, { filename, contentType, bytes });
  const url = `/deals/${dealId}/evidence`;
  let auth;
  if (legacy) {
    auth = await legacySignedHeaders(account, "POST", url, Buffer.alloc(0));
  } else if (contentSha !== undefined) {
    auth = await signedHeaders(account, "POST", url, { contentSha });
  } else {
    auth = await metaSignedHeaders(account, "POST", url, {
      dealId,
      fileHash: sha256hex(bytes),
      filename,
      mime: contentType || "application/octet-stream",
      size: bytes.length,
    });
  }
  return app.inject({
    method: "POST",
    url,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

describe("evidence hardening", () => {
  it("concurrent first uploads converge on a single per-deal DEK and both decrypt", async () => {
    const dealId = `0x${"aa".repeat(32)}`;
    const a = new LocalEncryptedStore(evidenceDir);
    const b = new LocalEncryptedStore(evidenceDir);
    const hashA = `0x${"0a".repeat(32)}`;
    const hashB = `0x${"0b".repeat(32)}`;
    const bytesA = Buffer.from("file A under concurrent key creation", "utf8");
    const bytesB = Buffer.from("file B under concurrent key creation", "utf8");
    await Promise.all([a.put(dealId, hashA, bytesA), b.put(dealId, hashB, bytesB)]);

    assert.deepEqual(await a.get(dealId, hashA), bytesA);
    assert.deepEqual(await b.get(dealId, hashB), bytesB);
    assert.deepEqual(await a.get(dealId, hashB), bytesB);
    assert.deepEqual(await b.get(dealId, hashA), bytesA);

    const keyFiles = (await readdir(evidenceDir)).filter((name) => name.endsWith(".dek.json"));
    assert.equal(keyFiles.length, 1, "exactly one canonical wrapped DEK is persisted");
  });

  it("getOrCreateDek is canonical and single-flight per deal", async () => {
    const store = new LocalEncryptedStore(evidenceDir);
    const dealId = `0x${"ab".repeat(32)}`;
    const [first, second] = await Promise.all([store.getOrCreateDek(dealId), store.getOrCreateDek(dealId)]);
    assert.equal(first.dekWrapped, second.dekWrapped);
    const third = await store.getOrCreateDek(dealId);
    assert.equal(third.dekWrapped, first.dekWrapped);
    assert.ok(first.kekId.startsWith("kek-"));
  });

  it("production refuses an ephemeral KEK (throws instead of silently generating)", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["EVIDENCE_KEK_HEX"];
    __resetBlobStoreForTests();
    assert.throws(() => currentKekId(), /durable KEK|EVIDENCE_KEK_HEX/);
  });

  it("production store operations reject when no durable KEK is configured", async () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["EVIDENCE_KEK_HEX"];
    __resetBlobStoreForTests();
    const store = new LocalEncryptedStore(evidenceDir);
    await assert.rejects(
      store.put(`0x${"ac".repeat(32)}`, `0x${"0c".repeat(32)}`, Buffer.from("x", "utf8")),
      /durable KEK|EVIDENCE_KEK_HEX/,
    );
  });

  it("rotateKek re-wraps DEKs and old blobs stay decryptable (historical keys preserved)", async () => {
    delete process.env["EVIDENCE_KEK_HEX"];
    __resetBlobStoreForTests();
    const store = new LocalEncryptedStore(evidenceDir);
    const dealId = `0x${"ad".repeat(32)}`;
    const bytes = Buffer.from("rotate me, still readable afterwards", "utf8");
    const hash = `0x${sha256hex(bytes)}`;
    await store.put(dealId, hash, bytes);
    const before = await store.exportBackup(dealId);

    const result = await store.rotateKek("kek-rotated-v2", Buffer.from(KEK_B, "hex"));
    assert.equal(result.kekId, "kek-rotated-v2");
    assert.ok(result.rotated.includes(dealId));

    const after = await store.exportBackup(dealId);
    assert.equal(after.kekId, "kek-rotated-v2");
    assert.notEqual(after.dekWrapped, before.dekWrapped);
    assert.deepEqual(await store.get(dealId, hash), bytes);

    // A historical envelope wrapped under the previous KEK still resolves.
    await store.importBackup(dealId, before);
    assert.deepEqual(await store.get(dealId, hash), bytes);
  });

  it("historical KEKs supplied via EVIDENCE_KEK_HISTORY resolve old envelopes after restart", async () => {
    __resetBlobStoreForTests();
    const dealId = `0x${"ae".repeat(32)}`;
    const bytes = Buffer.from("pre-rotation ciphertext", "utf8");
    const hash = `0x${sha256hex(bytes)}`;
    const writer = new LocalEncryptedStore(evidenceDir);
    await writer.put(dealId, hash, bytes);
    const backup = await writer.exportBackup(dealId);

    // Simulate a restart under a new active KEK, with the old one kept as history.
    process.env["EVIDENCE_KEK_HEX"] = KEK_B;
    process.env["EVIDENCE_KEK_HISTORY"] = KEK_A;
    __resetBlobStoreForTests();

    const reader = new LocalEncryptedStore(evidenceDir);
    await reader.importBackup(dealId, backup);
    assert.deepEqual(await reader.get(dealId, hash), bytes);
  });

  it("rotateKek rejects a key that is not 32 bytes", async () => {
    const store = new LocalEncryptedStore(evidenceDir);
    await assert.rejects(store.rotateKek("kek-bad", Buffer.alloc(16)), /32 bytes/);
  });

  it("rejects an upload whose signed file hash does not match the bytes", async () => {
    const { app, store } = await makeApp();
    const dealId = `0x${"31".repeat(32)}`;
    await seedDeal(store, dealId);
    const bytes = Buffer.from("real uploaded bytes", "utf8");
    const boundary = "----midman-hardening-boundary";
    const url = `/deals/${dealId}/evidence`;
    const res = await app.inject({
      method: "POST",
      url,
      headers: {
        ...(await metaSignedHeaders(buyer, "POST", url, {
          dealId,
          fileHash: sha256hex(Buffer.from("some other bytes", "utf8")),
          filename: "a.txt",
          mime: "text/plain",
          size: bytes.length,
        })),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary, { kind: "delivery", description: "x" }, {
        filename: "a.txt",
        contentType: "text/plain",
        bytes,
      }),
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /file hash/i);
  });

  it("blocks signature replay with different file content", async () => {
    const { app, store } = await makeApp();
    const dealId = `0x${"32".repeat(32)}`;
    await seedDeal(store, dealId);
    const url = `/deals/${dealId}/evidence`;
    const boundary = "----midman-hardening-boundary";
    const contentA = Buffer.from("original content for signature", "utf8");
    const contentB = Buffer.from("different replayed content!!!", "utf8");

    const headers = {
      ...(await metaSignedHeaders(buyer, "POST", url, {
        dealId,
        fileHash: sha256hex(contentA),
        filename: "r.txt",
        mime: "text/plain",
        size: contentA.length,
      })),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    };
    const first = await app.inject({
      method: "POST",
      url,
      headers,
      payload: buildMultipartBody(boundary, { kind: "delivery", description: "first" }, {
        filename: "r.txt",
        contentType: "text/plain",
        bytes: contentA,
      }),
    });
    assert.equal(first.statusCode, 200);

    // Same signature, different bytes -> the signed file hash no longer matches.
    const replay = await app.inject({
      method: "POST",
      url,
      headers,
      payload: buildMultipartBody(boundary, { kind: "delivery", description: "second" }, {
        filename: "r.txt",
        contentType: "text/plain",
        bytes: contentB,
      }),
    });
    assert.equal(replay.statusCode, 401);
  });

  it("accepts a metadata-bound upload and serves it back", async () => {
    const { app, store } = await makeApp();
    const dealId = `0x${"33".repeat(32)}`;
    await seedDeal(store, dealId);
    const bytes = Buffer.from("content-bound delivery note 7", "utf8");
    const res = await upload(app, dealId, buyer, { bytes, filename: "note.txt", contentType: "text/plain" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().fileHash, `0x${sha256hex(bytes)}`);

    const downloadPath = `/evidence/${res.json().fileHash}?dealId=${dealId}`;
    const downloaded = await app.inject({
      method: "GET",
      url: downloadPath,
      headers: await signedHeaders(buyer, "GET", downloadPath),
    });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(Buffer.from(downloaded.rawPayload), bytes);
  });

  it("rejects legacy 4-line upload signatures", async () => {
    const { app, store } = await makeApp();
    const dealId = `0x${"34".repeat(32)}`;
    await seedDeal(store, dealId);
    const res = await upload(app, dealId, buyer, {
      bytes: Buffer.from("legacy client upload", "utf8"),
      filename: "legacy.txt",
      contentType: "text/plain",
      legacy: true,
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /Metadata-bound signature required/);
  });

  it("rejects content-bound upload signatures (metadata binding is mandatory)", async () => {
    const { app, store } = await makeApp();
    const dealId = `0x${"35".repeat(32)}`;
    await seedDeal(store, dealId);
    const bytes = Buffer.from("no metadata", "utf8");
    const res = await upload(app, dealId, buyer, {
      bytes,
      filename: "n.txt",
      contentType: "text/plain",
      contentSha: sha256hex(bytes),
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /Metadata-bound signature required/);
  });

  it("accepts 5-line non-upload signatures and legacy 4-line signatures (backward compat)", async () => {
    const { app, store } = await makeApp();
    const dealId = `0x${"36".repeat(32)}`;
    await seedDeal(store, dealId);
    const path = `/deals/${dealId}/evidence`;

    const modern = await app.inject({ method: "GET", url: path, headers: await signedHeaders(buyer, "GET", path) });
    assert.equal(modern.statusCode, 200);

    const legacy = await app.inject({
      method: "GET",
      url: path,
      headers: await legacySignedHeaders(buyer, "GET", path),
    });
    assert.equal(legacy.statusCode, 200);
  });

  it("denies a globally-listed reviewer who is not assigned to the case (403)", async () => {
    process.env["REVIEWER_WALLETS"] = revC.address;
    const { app, store } = await makeApp();
    const dealId = `0x${"41".repeat(32)}`;
    await seedDeal(store, dealId);
    assignReviewers(dealId, { primary: [revA.address], fallback: [revB.address] });
    const path = `/deals/${dealId}/evidence`;

    const denied = await app.inject({
      method: "GET",
      url: path,
      headers: await signedHeaders(revC, "GET", path),
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await app.inject({
      method: "GET",
      url: path,
      headers: await signedHeaders(revA, "GET", path),
    });
    assert.equal(allowed.statusCode, 200);
  });

  it("allows the REVIEWER_WALLETS superuser fallback only with EVIDENCE_SUPERVISOR=1", async () => {
    process.env["REVIEWER_WALLETS"] = revC.address;
    process.env["EVIDENCE_SUPERVISOR"] = "1";
    const { app, store } = await makeApp();
    const dealId = `0x${"42".repeat(32)}`;
    await seedDeal(store, dealId);
    assignReviewers(dealId, { primary: [revA.address], fallback: [revB.address] });
    const path = `/deals/${dealId}/evidence`;

    const allowed = await app.inject({
      method: "GET",
      url: path,
      headers: await signedHeaders(revC, "GET", path),
    });
    assert.equal(allowed.statusCode, 200);
  });

  it("honours a per-deal reviewer allowlist and not other deals", async () => {
    const { app, store } = await makeApp();
    const dealId = `0x${"43".repeat(32)}`;
    const otherDealId = `0x${"44".repeat(32)}`;
    await seedDeal(store, dealId);
    await seedDeal(store, otherDealId);
    assignReviewers(dealId, { primary: [revA.address], fallback: [revB.address] });
    assignReviewers(otherDealId, { primary: [revA.address], fallback: [revB.address] });
    process.env["EVIDENCE_REVIEWER_ALLOWLIST"] = `${dealId}:${revC.address}`;

    const allowPath = `/deals/${dealId}/evidence`;
    const allowed = await app.inject({
      method: "GET",
      url: allowPath,
      headers: await signedHeaders(revC, "GET", allowPath),
    });
    assert.equal(allowed.statusCode, 200);

    const denyPath = `/deals/${otherDealId}/evidence`;
    const denied = await app.inject({
      method: "GET",
      url: denyPath,
      headers: await signedHeaders(revC, "GET", denyPath),
    });
    assert.equal(denied.statusCode, 403);
  });

  it("quarantines an infected upload: stored, listed as quarantined, download blocked (409)", async () => {
    process.env["EVIDENCE_SCAN_FORCE"] = "infected";
    const { app, store } = await makeApp();
    const dealId = `0x${"51".repeat(32)}`;
    await seedDeal(store, dealId);
    const bytes = Buffer.from("eicar-like marker payload", "utf8");
    const res = await upload(app, dealId, buyer, { bytes, filename: "bad.txt", contentType: "text/plain" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().scan.status, "infected");
    assert.equal(res.json().quarantined, true);

    const { fileHash } = res.json();
    // Stored, but never served.
    assert.deepEqual(await getSharedBlobStore().get(dealId, fileHash), bytes);

    const downloadPath = `/evidence/${fileHash}?dealId=${dealId}`;
    const blocked = await app.inject({
      method: "GET",
      url: downloadPath,
      headers: await signedHeaders(buyer, "GET", downloadPath),
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().status, "quarantined");

    const manifestPath = `/deals/${dealId}/evidence`;
    const manifest = await app.inject({
      method: "GET",
      url: manifestPath,
      headers: await signedHeaders(buyer, "GET", manifestPath),
    });
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.json().entries[0].quarantined, true);
    assert.equal(manifest.json().entries[0].scan.status, "infected");
  });

  it("records a deferred scan honestly and never labels it clean", async () => {
    process.env["EVIDENCE_SCAN_FORCE"] = "deferred";
    const { app, store } = await makeApp();
    const dealId = `0x${"52".repeat(32)}`;
    await seedDeal(store, dealId);
    const bytes = Buffer.from("unscanned but available", "utf8");
    const res = await upload(app, dealId, buyer, { bytes, filename: "u.txt", contentType: "text/plain" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().scan.status, "deferred");
    assert.notEqual(res.json().scan.status, "clean");
    assert.equal(res.json().quarantined, false);

    const downloadPath = `/evidence/${res.json().fileHash}?dealId=${dealId}`;
    const downloaded = await app.inject({
      method: "GET",
      url: downloadPath,
      headers: await signedHeaders(buyer, "GET", downloadPath),
    });
    assert.equal(downloaded.statusCode, 200);
  });
});
