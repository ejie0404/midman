// Round-2 Phase 6 evidence tests.
//
// Covers: content-bound browser upload signatures, metadata-bound signed
// requests with durable nonce replay protection, atomic/idempotent upload
// finalization, scan-state (quarantine/pending/error) enforcement, audited
// exceptional original export, durable receipt signer identity + key history,
// persisted-KID key rotation that survives a simulated restart, the restore
// drill (pre- + post-rotation), and signed retention approvals bound to
// specific objects.
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { registerEvidenceRoutes } from "../dist/evidence/routes.js";
import {
  LocalEncryptedStore,
  getSharedBlobStore,
  __resetBlobStoreForTests,
} from "../dist/evidence/store.js";
import {
  GENESIS_PREVHASH,
  getSharedRegistry,
  __resetRegistryForTests,
} from "../dist/evidence/registry.js";
import {
  assertReceiptSignerConfigured,
  signReceipt,
  verifyReceiptWithHistory,
  __resetReceiptSignerForTests,
} from "../dist/evidence/receipts.js";
import {
  EVIDENCE_AUTH_APP,
  evidenceAuthDomain,
  buildMetadataSignedMessage,
} from "../dist/evidence/access.js";
import { purgeApprovalMessage, purgeExpired } from "../dist/evidence/retention.js";
import { runEvidenceRestoreDrill } from "../dist/evidence/restore.js";
import { assignReviewers, __resetReviewRegistryForTests } from "../dist/review/registry.js";
import { MemoryStore } from "../dist/db.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KEK_A = "ab".repeat(32);
const KEK_B = "cd".repeat(32);
const KEK_C = "ef".repeat(32);
const RECEIPT_KEY = `0x${"ef".repeat(32)}`;
const RECEIPT_KEY_V1 = `0x${"01".repeat(32)}`;

const buyer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"22".repeat(32)}`);
const third = privateKeyToAccount(`0x${"33".repeat(32)}`);
const reviewer = privateKeyToAccount(`0x${"44".repeat(32)}`);
const ops = privateKeyToAccount(`0x${"55".repeat(32)}`);
const arb = privateKeyToAccount(`0x${"66".repeat(32)}`);

const MANAGED_ENV = [
  "NODE_ENV",
  "EVIDENCE_KEK_HEX",
  "EVIDENCE_KEK_HISTORY",
  "EVIDENCE_DIR",
  "EVIDENCE_SCAN_FORCE",
  "EVIDENCE_REQUIRE_CONTENT_BINDING",
  "EVIDENCE_SUPERVISOR",
  "EVIDENCE_REVIEWER_ALLOWLIST",
  "EVIDENCE_ORIGINAL_EXPORT_WALLETS",
  "EVIDENCE_AUTH_DOMAIN",
  "REVIEWER_WALLETS",
  "RECEIPT_SIGNER_KEY",
  "RECEIPT_SIGNER_KEY_HISTORY",
  "RETENTION_OPS_WALLETS",
  "RETENTION_ARBITRATION_WALLETS",
  "CLAMAV_HOST",
  "CLAMAV_PORT",
];
const ORIGINAL_ENV = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));

let evidenceDir = "";
let draftCounter = 0;

const NOW = () => Math.floor(Date.now() / 1_000);

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resetEnv() {
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env["EVIDENCE_KEK_HEX"] = KEK_A;
  process.env["EVIDENCE_DIR"] = evidenceDir;
  process.env["EVIDENCE_SCAN_FORCE"] = "deferred";
  process.env["RECEIPT_SIGNER_KEY"] = RECEIPT_KEY;
  process.env["REVIEWER_WALLETS"] = reviewer.address;
}

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "midman-phase6-"));
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

function legacyHeaders(account, method, url, bodyBytes = Buffer.alloc(0), expiry = NOW() + 300) {
  const message = `${method.toUpperCase()}\n${url}\n${sha256hex(bodyBytes)}\n${expiry}`;
  return account.signMessage({ message }).then((signature) => ({
    "x-wallet-address": account.address,
    "x-wallet-expiry": String(expiry),
    "x-wallet-signature": signature,
  }));
}

async function contentHeaders(account, method, url, contentSha256, expiry = NOW() + 300) {
  const empty = sha256hex(Buffer.alloc(0));
  const message = `${method.toUpperCase()}\n${url}\n${empty}\n${contentSha256}\n${expiry}`;
  const signature = await account.signMessage({ message });
  const headers = {
    "x-wallet-address": account.address,
    "x-wallet-expiry": String(expiry),
    "x-wallet-signature": signature,
  };
  if (contentSha256 !== "") headers["x-content-sha256"] = contentSha256;
  return headers;
}

async function metaHeaders(account, method, url, opts) {
  const {
    dealId = "",
    action = "evidence.upload",
    fileHash = "",
    filename = "",
    mime = "",
    size = "",
    bodyBytes = Buffer.alloc(0),
    contentSha = "",
    nonce = randomBytes(16).toString("hex"),
    expiry = String(NOW() + 300),
  } = opts;
  const meta = {
    app: EVIDENCE_AUTH_APP,
    domain: evidenceAuthDomain(),
    method,
    path: url,
    dealId,
    action,
    fileHash,
    filename,
    mime,
    size,
    bodySha256: sha256hex(bodyBytes),
    nonce,
    expiry,
  };
  const signature = await account.signMessage({ message: buildMetadataSignedMessage(meta) });
  const headers = {
    "x-wallet-address": account.address,
    "x-wallet-expiry": expiry,
    "x-wallet-signature": signature,
    "x-request-nonce": nonce,
    "x-request-action": action,
    "x-request-deal": dealId,
  };
  if (fileHash) headers["x-request-file"] = fileHash;
  if (filename) headers["x-request-filename"] = filename;
  if (mime) headers["x-request-mime"] = mime;
  if (size !== "") headers["x-request-size"] = String(size);
  if (contentSha) headers["x-content-sha256"] = contentSha;
  return { headers, nonce };
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

const BOUNDARY = "----phase6-boundary";

async function uploadWithHeaders(app, dealId, headers, { bytes, filename = "note.txt", contentType = "text/plain", kind = "delivery", description = "delivery confirmation" }) {
  const url = `/deals/${dealId}/evidence`;
  return app.inject({
    method: "POST",
    url,
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: buildMultipartBody(BOUNDARY, { kind, description }, { filename, contentType, bytes }),
  });
}

async function uploadContentBound(app, dealId, account, opts) {
  const { bytes, contentSha = sha256hex(bytes), ...rest } = opts;
  const url = `/deals/${dealId}/evidence`;
  return uploadWithHeaders(app, dealId, await contentHeaders(account, "POST", url, contentSha), { bytes, ...rest });
}

async function uploadMetadataBound(app, dealId, account, opts) {
  const { bytes, ...rest } = opts;
  const url = `/deals/${dealId}/evidence`;
  const cs = sha256hex(bytes);
  const { headers } = await metaHeaders(account, "POST", url, {
    dealId,
    action: "evidence.upload",
    fileHash: cs,
    filename: rest.filename ?? "note.txt",
    mime: rest.contentType ?? "text/plain",
    size: bytes.length,
    contentSha: cs,
  });
  return uploadWithHeaders(app, dealId, headers, { bytes, ...rest });
}

async function signedGet(account, url) {
  return account.signMessage({ message: `GET\n${url}\n${sha256hex(Buffer.alloc(0))}\n${NOW() + 300}` }).then((signature) => ({
    "x-wallet-address": account.address,
    "x-wallet-expiry": String(NOW() + 300),
    "x-wallet-signature": signature,
  }));
}

function dealIdOf(seed) {
  return `0x${seed.repeat(32)}`;
}

// ---------------------------------------------------------------------------

describe("Phase 6 · content-bound upload signing", () => {
  it("requires x-content-sha256 for uploads when EVIDENCE_REQUIRE_CONTENT_BINDING=1", async () => {
    process.env["EVIDENCE_REQUIRE_CONTENT_BINDING"] = "1";
    const { app, store } = await makeApp();
    const dealId = dealIdOf("31");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("no content header bytes", "utf8");
    const url = `/deals/${dealId}/evidence`;
    const res = await uploadWithHeaders(app, dealId, await legacyHeaders(buyer, "POST", url), { bytes });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /x-content-sha256 is required/);
  });

  it("rejects an upload whose declared content hash does not match the bytes", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("32");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("the actual bytes", "utf8");
    const res = await uploadContentBound(app, dealId, buyer, { bytes, contentSha: sha256hex(Buffer.from("other bytes", "utf8")) });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /does not match/);
  });

  it("accepts the 5-line content-bound signature and stores the exact file hash", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("33");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("content bound delivery document", "utf8");
    const res = await uploadContentBound(app, dealId, buyer, { bytes });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.equal(res.json().fileHash, `0x${sha256hex(bytes)}`);
  });

  it("accepts a metadata-bound signed upload (nonce + action + deal + file + content hash)", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("34");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("metadata bound delivery bytes", "utf8");
    const res = await uploadMetadataBound(app, dealId, buyer, { bytes });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.equal(res.json().fileHash, `0x${sha256hex(bytes)}`);
  });
});

describe("Phase 6 · metadata-bound authorization + replay protection", () => {
  it("rejects a replayed metadata-bound signature (durable nonce)", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("35");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("replay me once only", "utf8");
    const url = `/deals/${dealId}/evidence`;
    const cs = sha256hex(bytes);
    const { headers } = await metaHeaders(buyer, "POST", url, {
      dealId,
      action: "evidence.upload",
      fileHash: cs,
      filename: "r.txt",
      mime: "text/plain",
      size: bytes.length,
      contentSha: cs,
    });
    const first = await uploadWithHeaders(app, dealId, headers, { bytes });
    assert.equal(first.statusCode, 200, JSON.stringify(first.json()));
    // Same signature + nonce, different description -> replay must be refused.
    const replay = await uploadWithHeaders(app, dealId, headers, {
      bytes: Buffer.from("replay me once only", "utf8"),
      description: "second",
    });
    assert.equal(replay.statusCode, 401);
    assert.match(replay.json().error, /nonce already used/i);
  });

  it("rejects a metadata signature bound to a different deal (cross-deal replay)", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("36");
    const otherDeal = dealIdOf("37");
    await seedDeal(store, dealId);
    await seedDeal(store, otherDeal);
    const bytes = Buffer.from("cross deal binding", "utf8");
    const cs = sha256hex(bytes);
    // Sign for the request PATH of `otherDeal` but bind the metadata `deal` to
    // `dealId`: the binding check (not the path) must reject it.
    const { headers } = await metaHeaders(buyer, "POST", `/deals/${otherDeal}/evidence`, {
      dealId,
      action: "evidence.upload",
      fileHash: cs,
      contentSha: cs,
    });
    const res = await uploadWithHeaders(app, otherDeal, headers, { bytes });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /deal does not match/);
  });
});

describe("Phase 6 · atomic upload finalization", () => {
  it("does not duplicate the manifest when the same content is retried", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("38");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("idempotent retry payload", "utf8");
    const first = await uploadContentBound(app, dealId, buyer, { bytes });
    assert.equal(first.statusCode, 200);
    const second = await uploadContentBound(app, dealId, seller, { bytes });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().duplicated, true);
    assert.equal(second.json().seq, first.json().seq);
    assert.equal(getSharedRegistry().getManifest(dealId).length, 1, "retry must not append a second entry");
  });

  it("requires a committed manifest entry for object access (unknown hash -> 404)", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("39");
    await seedDeal(store, dealId);
    const unknown = `0x${"9a".repeat(32)}`;
    const url = `/evidence/${unknown}?dealId=${dealId}`;
    const res = await app.inject({ method: "GET", url, headers: await signedGet(buyer, url) });
    assert.equal(res.statusCode, 404);
  });

  it("does not append a manifest entry when the upload is rejected", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("3a");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("rejected upload bytes", "utf8");
    const bad = await uploadContentBound(app, dealId, buyer, { bytes, contentSha: sha256hex(Buffer.from("nope", "utf8")) });
    assert.equal(bad.statusCode, 400);
    assert.equal(getSharedRegistry().getManifest(dealId).length, 0);
  });
});

describe("Phase 6 · scan-state enforcement", () => {
  it("blocks download of a quarantined (infected) object with 409", async () => {
    process.env["EVIDENCE_SCAN_FORCE"] = "infected";
    const { app, store } = await makeApp();
    const dealId = dealIdOf("51");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("malware-ish payload", "utf8");
    const res = await uploadContentBound(app, dealId, buyer, { bytes });
    assert.equal(res.statusCode, 200);
    const { fileHash } = res.json();
    assert.equal(res.json().quarantined, true);
    const url = `/evidence/${fileHash}?dealId=${dealId}`;
    const blocked = await app.inject({ method: "GET", url, headers: await signedGet(buyer, url) });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().status, "quarantined");
  });

  it("serves deferred content but never labels it clean", async () => {
    process.env["EVIDENCE_SCAN_FORCE"] = "deferred";
    const { app, store } = await makeApp();
    const dealId = dealIdOf("52");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("deferred scan document", "utf8");
    const res = await uploadContentBound(app, dealId, buyer, { bytes });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().scan.status, "deferred");
    assert.notEqual(res.json().scan.status, "clean");
    const url = `/evidence/${res.json().fileHash}?dealId=${dealId}`;
    const downloaded = await app.inject({ method: "GET", url, headers: await signedGet(buyer, url) });
    assert.equal(downloaded.statusCode, 200);
  });

  it("blocks download of an error-state object with 409", async () => {
    process.env["EVIDENCE_SCAN_FORCE"] = "error";
    const { app, store } = await makeApp();
    const dealId = dealIdOf("53");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("scan errored document", "utf8");
    const res = await uploadContentBound(app, dealId, buyer, { bytes });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().scan.status, "error");
    const url = `/evidence/${res.json().fileHash}?dealId=${dealId}`;
    const blocked = await app.inject({ method: "GET", url, headers: await signedGet(buyer, url) });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().status, "error");
  });

  it("blocks download of a pending-state object committed directly to the manifest", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("54");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("pending scan document", "utf8");
    const fileHash = `0x${sha256hex(bytes)}`;
    await getSharedBlobStore().put(dealId, fileHash, bytes);
    await getSharedRegistry().appendManifestAtomic(dealId, {
      uploader: buyer.address,
      kind: "delivery",
      description: "pending",
      fileHash,
      prevHash: GENESIS_PREVHASH,
      scan: { status: "pending", detail: "awaiting scanner" },
    });
    const url = `/evidence/${fileHash}?dealId=${dealId}`;
    const blocked = await app.inject({ method: "GET", url, headers: await signedGet(buyer, url) });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().status, "pending");
  });
});

describe("Phase 6 · exceptional original export (audited)", () => {
  it("denies an unauthorized original export with 403", async () => {
    process.env["EVIDENCE_SCAN_FORCE"] = "infected";
    const { app, store } = await makeApp();
    const dealId = dealIdOf("61");
    await seedDeal(store, dealId);
    const res = await uploadContentBound(app, dealId, buyer, { bytes: Buffer.from("export target", "utf8") });
    const url = `/evidence/${res.json().fileHash}?dealId=${dealId}&exportOriginal=1&reason=incident`;
    const denied = await app.inject({ method: "GET", url, headers: await signedGet(buyer, url) });
    assert.equal(denied.statusCode, 403);
  });

  it("allows an allowlisted, audited original export and records the audit", async () => {
    process.env["EVIDENCE_SCAN_FORCE"] = "infected";
    process.env["EVIDENCE_ORIGINAL_EXPORT_WALLETS"] = buyer.address;
    const { app, store } = await makeApp();
    const dealId = dealIdOf("62");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("forensic original bytes", "utf8");
    const res = await uploadContentBound(app, dealId, buyer, { bytes });
    const { fileHash } = res.json();

    const missingReason = `/evidence/${fileHash}?dealId=${dealId}&exportOriginal=1`;
    const noReason = await app.inject({ method: "GET", url: missingReason, headers: await signedGet(buyer, missingReason) });
    assert.equal(noReason.statusCode, 400);

    const url = `/evidence/${fileHash}?dealId=${dealId}&exportOriginal=1&reason=forensic-hold`;
    const exported = await app.inject({ method: "GET", url, headers: await signedGet(buyer, url) });
    assert.equal(exported.statusCode, 200);
    assert.deepEqual(Buffer.from(exported.rawPayload), bytes);
    const audit = getSharedRegistry().getAudit(dealId);
    assert.ok(audit.some((entry) => entry.action === "evidence.export-original" && entry.target === fileHash));
  });
});

describe("Phase 6 · durable receipt signing", () => {
  it("throws in production when no durable receipt signer is configured", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["RECEIPT_SIGNER_KEY"];
    __resetReceiptSignerForTests();
    assert.throws(() => assertReceiptSignerConfigured(), /RECEIPT_SIGNER_KEY|production/);
  });

  it("embeds signer key id/version and verifies against the key history", async () => {
    const receipt = await signReceipt({ dealId: dealIdOf("71"), seq: 0, fileHash: `0x${"7a".repeat(32)}` });
    assert.ok(receipt.keyId.startsWith("receipt-"));
    assert.equal(receipt.version, 2);
    const stable = await verifyReceiptWithHistory(receipt);
    assert.equal(stable.valid, true);
    // After a key rotation the historical signer is supplied explicitly.
    const legacy = { ...receipt, keyId: undefined };
    const historical = await verifyReceiptWithHistory(legacy, [receipt.signer]);
    assert.equal(historical.valid, true);
  });

  it("verifies a receipt issued under a historical key after the active key changes", async () => {
    const receipt = await signReceipt({ dealId: dealIdOf("72"), seq: 1, fileHash: `0x${"7b".repeat(32)}` });
    // Rotate the configured signer: the old receipt must still verify via history.
    process.env["RECEIPT_SIGNER_KEY"] = RECEIPT_KEY_V1;
    const historicalVerifier = privateKeyToAccount(RECEIPT_KEY_V1);
    const result = await verifyReceiptWithHistory(receipt, [historicalVerifier.address]);
    assert.equal(result.valid, true);
    assert.equal(result.recovered.toLowerCase(), receipt.signer.toLowerCase());
  });
});

describe("Phase 6 · key rotation + restore drill", () => {
  it("decrypts after rotation in a fresh process using the persisted KID history", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("81");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("rotation survives a restart", "utf8");
    const res = await uploadContentBound(app, dealId, buyer, { bytes });
    const { fileHash } = res.json();

    const blobstore = getSharedBlobStore();
    const pre = await blobstore.exportBackup(dealId);
    await blobstore.rotateKek("kek-phase6-rotated", Buffer.from(KEK_B, "hex"));
    const rotated = await blobstore.exportBackup(dealId);
    assert.equal(rotated.kekId, "kek-phase6-rotated");
    assert.notEqual(rotated.dekWrapped, pre.dekWrapped);

    // Simulate a fresh process: only the new active KEK from env, no keyring.
    process.env["EVIDENCE_KEK_HEX"] = KEK_B;
    delete process.env["EVIDENCE_KEK_HISTORY"];
    __resetBlobStoreForTests();
    const fresh = new LocalEncryptedStore(evidenceDir);
    assert.deepEqual(await fresh.get(dealId, fileHash), bytes, "persisted keyring must resolve the rotated KID");
    assert.ok((await fresh.enumerateDealIds()).some((id) => id.toLowerCase() === dealId.toLowerCase()));
  });

  it("records rotation progress and completes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "midman-rotation-"));
    try {
      const store = new LocalEncryptedStore(dir);
      const dealId = dealIdOf("82");
      await store.put(dealId, `0x${"8a".repeat(32)}`, Buffer.from("progress payload", "utf8"));
      await store.rotateKek("kek-phase6-progress", Buffer.from(KEK_B, "hex"));
      const progress = await store.getRotationProgress();
      assert.ok(progress);
      assert.equal(progress.complete, true);
      assert.equal(progress.newKekId, "kek-phase6-progress");
      assert.ok(progress.rotated.includes(dealId));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("restore drill passes with pre- and post-rotation key envelopes", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("83");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("restore drill content", "utf8");
    const res = await uploadContentBound(app, dealId, buyer, { bytes });
    const { fileHash } = res.json();

    const blobstore = getSharedBlobStore();
    const pre = await blobstore.exportBackup(dealId);
    await blobstore.rotateKek("kek-phase6-drill", Buffer.from(KEK_B, "hex"));
    const post = await blobstore.exportBackup(dealId);

    process.env["EVIDENCE_KEK_HEX"] = KEK_B;
    __resetBlobStoreForTests();
    const clean = new LocalEncryptedStore(evidenceDir);

    const drill = await runEvidenceRestoreDrill({
      blobStore: clean,
      registry: getSharedRegistry(),
      keyHistory: [pre, post],
      dealId,
    });
    assert.equal(drill.ok, true, JSON.stringify(drill));
    assert.ok(drill.objects.some((object) => object.fileHash === fileHash && object.status === "ok"));
    assert.equal(drill.undecryptable.length, 0);
  });

  it("restore drill reports undecryptable objects when the key context is wrong", async () => {
    const { app, store } = await makeApp();
    const dealId = dealIdOf("84");
    await seedDeal(store, dealId);
    const bytes = Buffer.from("unrecoverable without the key", "utf8");
    await uploadContentBound(app, dealId, buyer, { bytes });

    // Fresh process with an unrelated active KEK: neither the envelope nor the
    // keyring can be unwrapped.
    process.env["EVIDENCE_KEK_HEX"] = KEK_C;
    delete process.env["EVIDENCE_KEK_HISTORY"];
    __resetBlobStoreForTests();
    const clean = new LocalEncryptedStore(evidenceDir);
    const drill = await runEvidenceRestoreDrill({
      blobStore: clean,
      registry: getSharedRegistry(),
      dealId,
    });
    assert.equal(drill.ok, false);
    assert.ok(drill.undecryptable.length >= 1);
  });
});

describe("Phase 6 · signed retention approvals", () => {
  function stubBlobStore(deleted) {
    return {
      async delete(dealId, fileHash) {
        deleted.push({ dealId, fileHash });
      },
    };
  }

  async function signApproval(account, fields) {
    const message = purgeApprovalMessage({ ...fields, approver: account.address });
    const signature = await account.signMessage({ message });
    return { ...fields, approver: account.address, signature };
  }

  async function seedPurgeable(dealId, hashes) {
    process.env["RETENTION_OPS_WALLETS"] = ops.address;
    process.env["RETENTION_ARBITRATION_WALLETS"] = arb.address;
    const registry = getSharedRegistry();
    for (const fileHash of hashes) {
      await registry.appendManifestAtomic(dealId, {
        uploader: buyer.address,
        kind: "delivery",
        description: "retention",
        fileHash,
        prevHash: registry.getHead(dealId),
        scan: { status: "clean", detail: "forced" },
      });
    }
    registry.recordSettlement(dealId, NOW() - 3 * 365 * 86_400);
    return registry;
  }

  it("purges only objects covered by distinct signed ops + arbitration approvals", async () => {
    const dealId = dealIdOf("91");
    const hashA = `0x${"9a".repeat(32)}`;
    const hashB = `0x${"9b".repeat(32)}`;
    const registry = await seedPurgeable(dealId, [hashA, hashB]);
    const common = { role: "ops", dealId, policy: "originals", issuedAt: NOW(), expiry: NOW() + 3_600, fileHash: hashA };
    const opsApproval = await signApproval(ops, common);
    const arbApproval = await signApproval(arb, { ...common, role: "arbitration" });
    const deleted = [];
    const result = await purgeExpired(registry, stubBlobStore(deleted), NOW(), [opsApproval, arbApproval], {
      requireSigned: true,
    });
    assert.deepEqual(result.purged.map((entry) => entry.fileHash.toLowerCase()), [hashA.toLowerCase()]);
    assert.equal(deleted.length, 1);
    assert.ok(result.outcomes.some((outcome) => outcome.fileHash === hashB && outcome.outcome === "skipped"));
    assert.equal(registry.getTombstones(dealId).length, 1);
    assert.equal(registry.getManifest(dealId).length, 2, "tombstones never delete manifest entries");
  });

  it("does not purge when an approval signature is forged", async () => {
    const dealId = dealIdOf("92");
    const hashA = `0x${"9c".repeat(32)}`;
    const registry = await seedPurgeable(dealId, [hashA]);
    const common = { role: "ops", dealId, policy: "originals", issuedAt: NOW(), expiry: NOW() + 3_600, fileHash: hashA };
    const opsApproval = await signApproval(ops, common);
    // Forged arbitration approval: valid signature but approver not allowlisted.
    const forged = await signApproval(third, { ...common, role: "arbitration" });
    const deleted = [];
    const result = await purgeExpired(registry, stubBlobStore(deleted), NOW(), [opsApproval, forged], {
      requireSigned: true,
    });
    assert.equal(result.purged.length, 0);
    assert.equal(deleted.length, 0);
  });

  it("rejects legacy role-only approvals when signed approvals are required", async () => {
    const dealId = dealIdOf("93");
    const registry = await seedPurgeable(dealId, [`0x${"9d".repeat(32)}`]);
    await assert.rejects(
      purgeExpired(registry, stubBlobStore([]), NOW(), [{ role: "ops" }, { role: "arbitration" }], {
        requireSigned: true,
      }),
      /valid signed/,
    );
  });

  it("keeps legacy dual-role purge behavior working for unsigned callers", async () => {
    const dealId = dealIdOf("94");
    const registry = await seedPurgeable(dealId, [`0x${"9e".repeat(32)}`]);
    const result = await purgeExpired(registry, stubBlobStore([]), NOW(), [
      { role: "ops" },
      { role: "arbitration" },
    ]);
    assert.equal(result.purged.length, 1);
  });
});

// Keep a reviewer assignment helper import meaningful for future cases.
void assignReviewers;
void reviewer;
