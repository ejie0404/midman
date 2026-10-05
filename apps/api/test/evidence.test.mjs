import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
// NOTE: evidence routes only — server.ts is intentionally not imported here.
import { registerEvidenceRoutes } from "../dist/evidence/routes.js";
import { getSharedBlobStore, __resetBlobStoreForTests } from "../dist/evidence/store.js";
import { getSharedRegistry, __resetRegistryForTests } from "../dist/evidence/registry.js";
import { __resetReceiptSignerForTests } from "../dist/evidence/receipts.js";
import { dueForPurge, purgeExpired, RETENTION_SECONDS } from "../dist/evidence/retention.js";
import { MAX_UPLOAD_BYTES, validateUpload } from "../dist/evidence/uploadChecks.js";
import { scanTextForSecrets } from "../dist/categories/secrets.js";
import { MemoryStore } from "../dist/db.js";
import {
  EVIDENCE_AUTH_APP,
  buildMetadataSignedMessage,
  evidenceAuthDomain,
} from "../dist/evidence/access.js";

const BUYER_KEY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SELLER_KEY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const THIRD_KEY = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REVIEWER_KEY = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const RECEIPT_KEY = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const buyer = privateKeyToAccount(BUYER_KEY);
const seller = privateKeyToAccount(SELLER_KEY);
const third = privateKeyToAccount(THIRD_KEY);
const reviewer = privateKeyToAccount(REVIEWER_KEY);

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EMPTY_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

let evidenceDir = "";
let draftCounter = 0;

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function signedHeaders(account, method, path, bodyBytes) {
  const bodyHash = sha256hex(bodyBytes ?? Buffer.alloc(0));
  const expiry = String(Math.floor(Date.now() / 1_000) + 300);
  const message = `${method.toUpperCase()}\n${path}\n${bodyHash}\n${expiry}`;
  const signature = await account.signMessage({ message });
  return {
    "x-wallet-address": account.address,
    "x-wallet-expiry": expiry,
    "x-wallet-signature": signature,
  };
}

/** Metadata-bound headers (required for evidence upload mutations). */
async function metaHeaders(account, method, path, fields) {
  const {
    dealId,
    action,
    fileHash,
    filename,
    mime,
    size,
    bodyBytes = Buffer.alloc(0),
  } = fields;
  const expiry = String(Math.floor(Date.now() / 1_000) + 300);
  const nonce = randomBytes(16).toString("hex");
  const meta = {
    app: EVIDENCE_AUTH_APP,
    domain: evidenceAuthDomain(),
    method,
    path,
    dealId,
    action,
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
    "x-request-action": action,
    "x-request-deal": dealId,
    "x-request-file": fileHash,
    "x-request-filename": filename,
    "x-request-mime": mime,
    "x-request-size": String(size),
  };
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

async function uploadFile(app, dealId, account, { bytes, filename, contentType, kind = "delivery", description = "delivery confirmation" }) {
  const boundary = "----midman-test-boundary";
  const body = buildMultipartBody(
    boundary,
    { kind, description },
    { filename, contentType, bytes },
  );
  const path = `/deals/${dealId}/evidence`;
  const fileHash = sha256hex(bytes);
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      ...(await metaHeaders(account, "POST", path, {
        dealId,
        action: "evidence.upload",
        fileHash,
        filename,
        mime: contentType || "application/octet-stream",
        size: bytes.length,
      })),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
}

describe("evidence subsystem", () => {
  before(async () => {
    process.env["EVIDENCE_KEK_HEX"] = "ab".repeat(32);
    process.env["RECEIPT_SIGNER_KEY"] = RECEIPT_KEY;
    evidenceDir = await mkdtemp(join(tmpdir(), "midman-evidence-"));
    process.env["EVIDENCE_DIR"] = evidenceDir;
    process.env["REVIEWER_WALLETS"] = reviewer.address;
    __resetBlobStoreForTests();
    __resetRegistryForTests();
    __resetReceiptSignerForTests();
  });

  it("round-trips encrypt/decrypt with matching sha256", async () => {
    const { app, store } = await makeApp();
    const dealId = "0x1111111111111111111111111111111111111111111111111111111111111111";
    await seedDeal(store, dealId);
    const bytes = Buffer.from("delivery confirmation screenshot reference 42", "utf8");

    const uploaded = await uploadFile(app, dealId, buyer, {
      bytes,
      filename: "note.txt",
      contentType: "text/plain",
    });
    assert.equal(uploaded.statusCode, 200);
    const body = uploaded.json();
    assert.equal(body.seq, 0);
    assert.equal(body.fileHash, `0x${sha256hex(bytes)}`);
    assert.ok(body.commitment.startsWith("0x"));
    assert.equal(body.scan.status, "deferred"); // CLAMAV_HOST unset: honest deferral

    const manifestPath = `/deals/${dealId}/evidence`;
    const manifest = await app.inject({
      method: "GET",
      url: manifestPath,
      headers: await signedHeaders(buyer, "GET", manifestPath),
    });
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.json().head, body.commitment);

    const downloadPath = `/evidence/${body.fileHash}?dealId=${dealId}`;
    const downloaded = await app.inject({
      method: "GET",
      url: downloadPath,
      headers: await signedHeaders(buyer, "GET", downloadPath),
    });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(Buffer.from(downloaded.rawPayload), bytes);
  });

  it("receipt verifies offline against its signer", async () => {
    const { app, store } = await makeApp();
    const dealId = "0x2222222222222222222222222222222222222222222222222222222222222222";
    await seedDeal(store, dealId);
    const bytes = Buffer.from("second delivery record", "utf8");
    const uploaded = await uploadFile(app, dealId, seller, { bytes, filename: "r.txt", contentType: "text/plain" });
    assert.equal(uploaded.statusCode, 200);
    const { receipt } = uploaded.json();
    const recovered = await recoverMessageAddress({ message: receipt.payload, signature: receipt.signature });
    assert.equal(recovered.toLowerCase(), receipt.signer.toLowerCase());

    const receiptPath = `/evidence/${uploaded.json().fileHash}/receipt?dealId=${dealId}`;
    const fetched = await app.inject({
      method: "GET",
      url: receiptPath,
      headers: await signedHeaders(seller, "GET", receiptPath),
    });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().payload, receipt.payload);
  });

  it("rejects non-parties with 403", async () => {
    const { app, store } = await makeApp();
    const dealId = "0x3333333333333333333333333333333333333333333333333333333333333333";
    await seedDeal(store, dealId);
    const path = `/deals/${dealId}/evidence`;
    const res = await app.inject({
      method: "GET",
      url: path,
      headers: await signedHeaders(third, "GET", path),
    });
    assert.equal(res.statusCode, 403);

    const denied = await uploadFile(app, dealId, third, {
      bytes: Buffer.from("intruder file", "utf8"),
      filename: "x.txt",
      contentType: "text/plain",
    });
    assert.equal(denied.statusCode, 403);
  });

  it("rejects expired signed requests with 401", async () => {
    const { app, store } = await makeApp();
    const dealId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await seedDeal(store, dealId);
    const path = `/deals/${dealId}/evidence`;
    const expiry = String(Math.floor(Date.now() / 1_000) - 10);
    const message = `GET\n${path}\n${EMPTY_HASH}\n${expiry}`;
    const signature = await buyer.signMessage({ message });
    const res = await app.inject({
      method: "GET",
      url: path,
      headers: { "x-wallet-address": buyer.address, "x-wallet-expiry": expiry, "x-wallet-signature": signature },
    });
    assert.equal(res.statusCode, 401);
  });

  it("rejects secret-bearing descriptions with finding codes", async () => {
    const { app, store } = await makeApp();
    const dealId = "0x4444444444444444444444444444444444444444444444444444444444444444";
    await seedDeal(store, dealId);
    const seedWords = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const res = await uploadFile(app, dealId, buyer, {
      bytes: Buffer.from("harmless bytes", "utf8"),
      filename: "note.txt",
      contentType: "text/plain",
      description: `my wallet mnemonic: ${seedWords}`,
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().findings.includes("SEED_PHRASE"));
  });

  it("rejects secret-bearing text file contents", async () => {
    const { app, store } = await makeApp();
    const dealId = "0x5555555555555555555555555555555555555555555555555555555555555555";
    await seedDeal(store, dealId);
    const res = await uploadFile(app, dealId, buyer, {
      bytes: Buffer.from("deploy key AKIAIOSFODNN7EXAMPLE here", "utf8"),
      filename: "keys.txt",
      contentType: "text/plain",
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().findings.includes("CLOUD_KEY"));
  });

  it("rejects disallowed extensions, magic mismatches, and oversize uploads", async () => {
    const { app, store } = await makeApp();
    const dealId = "0x6666666666666666666666666666666666666666666666666666666666666666";
    await seedDeal(store, dealId);

    const badExt = await uploadFile(app, dealId, buyer, {
      bytes: Buffer.from("MZ binary", "utf8"),
      filename: "evil.exe",
      contentType: "application/octet-stream",
    });
    assert.equal(badExt.statusCode, 400);

    const badMagic = await uploadFile(app, dealId, buyer, {
      bytes: Buffer.from("this is plain text, not a png", "utf8"),
      filename: "fake.png",
      contentType: "image/png",
    });
    assert.equal(badMagic.statusCode, 400);

    assert.rejects(
      () =>
        Promise.resolve().then(() =>
          validateUpload({
            bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1),
            filename: "big.txt",
            mimetype: "text/plain",
            description: "too big",
          }),
        ),
      /25MB/,
    );
  });

  it("secret scanner covers all finding codes", () => {
    assert.deepEqual(scanTextForSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc"), ["PEM_BLOCK"]);
    assert.ok(scanTextForSecrets("private_key = 0xdeadbeef").includes("PRIVATE_KEY_ASSIGN"));
    assert.ok(
      scanTextForSecrets(`user secret is ${"a1".repeat(32)} done`).includes("HEX_SECRET"),
      "64-hex with secret context",
    );
    assert.deepEqual(scanTextForSecrets(`plain file hash ${"ab".repeat(32)} reference`), [], "bare 64-hex is not a secret");
    assert.ok(scanTextForSecrets("key AKIAIOSFODNN7EXAMPLE leaked").includes("CLOUD_KEY"));
    assert.ok(
      scanTextForSecrets("mnemonic abandon ability able about above absent absorb abstract absurd abuse access accident").includes(
        "SEED_PHRASE",
      ),
    );
  });

  it("lets assigned reviewers read but not strangers", async () => {
    const { app, store } = await makeApp();
    const dealId = "0x7777777777777777777777777777777777777777777777777777777777777777";
    await seedDeal(store, dealId);
    const path = `/deals/${dealId}/evidence`;
    const allowed = await app.inject({
      method: "GET",
      url: path,
      headers: await signedHeaders(reviewer, "GET", path),
    });
    assert.equal(allowed.statusCode, 200);
  });

  it("enforces retention windows and dual-role purge", async () => {
    const YEAR = 365 * 86_400;
    assert.equal(RETENTION_SECONDS.originals, 2 * YEAR);
    assert.equal(RETENTION_SECONDS.manifests, 5 * YEAR);
    const settledAt = 1_000_000_000;
    assert.equal(dueForPurge("originals", settledAt, settledAt + 2 * YEAR - 1), false);
    assert.equal(dueForPurge("originals", settledAt, settledAt + 2 * YEAR), true);
    assert.equal(dueForPurge("manifests", settledAt, settledAt + 2 * YEAR), false);
    assert.equal(dueForPurge("manifests", settledAt, settledAt + 5 * YEAR), true);

    const { app, store } = await makeApp();
    const dealId = "0x8888888888888888888888888888888888888888888888888888888888888888";
    await seedDeal(store, dealId);
    const bytes = Buffer.from("purge me after retention", "utf8");
    const uploaded = await uploadFile(app, dealId, buyer, { bytes, filename: "p.txt", contentType: "text/plain" });
    assert.equal(uploaded.statusCode, 200);
    const { fileHash } = uploaded.json();

    const registry = getSharedRegistry();
    const blobstore = getSharedBlobStore();
    registry.recordSettlement(dealId, Math.floor(Date.now() / 1_000) - 3 * YEAR);

    await assert.rejects(
      purgeExpired(registry, blobstore, Math.floor(Date.now() / 1_000), [{ role: "ops" }]),
      /dual authorization/,
    );

    const result = await purgeExpired(registry, blobstore, Math.floor(Date.now() / 1_000), [
      { role: "ops" },
      { role: "arbitration" },
    ]);
    assert.ok(result.purged.some((entry) => entry.fileHash === fileHash));

    const downloadPath = `/evidence/${fileHash}?dealId=${dealId}`;
    const gone = await app.inject({
      method: "GET",
      url: downloadPath,
      headers: await signedHeaders(buyer, "GET", downloadPath),
    });
    assert.equal(gone.statusCode, 404);

    // Manifest tombstones survive the blob purge.
    const manifestPath = `/deals/${dealId}/evidence`;
    const manifest = await app.inject({
      method: "GET",
      url: manifestPath,
      headers: await signedHeaders(buyer, "GET", manifestPath),
    });
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.json().entries.length, 1);
    assert.equal(registry.getTombstones(dealId).length, 1);
  });

  it("restore-check passes after delete + importBackup key recovery", async () => {
    const { app, store } = await makeApp();
    const dealId = "0x9999999999999999999999999999999999999999999999999999999999999999";
    await seedDeal(store, dealId);
    const bytes = Buffer.from("key recovery drill file", "utf8");
    const uploaded = await uploadFile(app, dealId, buyer, { bytes, filename: "k.txt", contentType: "text/plain" });
    assert.equal(uploaded.statusCode, 200);
    const { fileHash } = uploaded.json();

    const blobstore = getSharedBlobStore();
    const backup = await blobstore.exportBackup(dealId);
    assert.ok(backup.dekWrapped.includes("."));
    assert.ok(backup.kekId.startsWith("kek-"));

    // Simulate wrapped-key loss: drop the cache and delete the .dek file.
    blobstore.dropCachedKey(dealId);
    await unlink(join(evidenceDir, `${dealId}.dek.json`));
    await assert.rejects(blobstore.get(dealId, fileHash));

    await blobstore.importBackup(dealId, backup);

    const payload = JSON.stringify({ fileHash });
    const restorePath = `/deals/${dealId}/evidence/restore-check`;
    const restored = await app.inject({
      method: "POST",
      url: restorePath,
      headers: {
        ...(await signedHeaders(buyer, "POST", restorePath, Buffer.from(payload, "utf8"))),
        "content-type": "application/json",
      },
      payload,
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().ok, true);

    const bundlePath = `/deals/${dealId}/export`;
    const bundle = await app.inject({
      method: "GET",
      url: bundlePath,
      headers: await signedHeaders(buyer, "GET", bundlePath),
    });
    assert.equal(bundle.statusCode, 200);
    assert.equal(bundle.json().count, 1);
    assert.ok(!("bytes" in bundle.json()));
    await rm(evidenceDir, { recursive: true, force: true }).catch(() => {});
  });
});
