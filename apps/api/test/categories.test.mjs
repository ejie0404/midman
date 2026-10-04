// Category delivery forms, deal messages, and evidence-commitment payloads.
// Registers ONLY the three category route groups on a fresh Fastify app
// (imports from dist; never server.ts or evidence routes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { toFunctionSelector } from "viem";
import { registerCategoryRoutes, registerMessageRoutes, registerCommitmentRoutes } from "../dist/categories/routes.js";
import { InMemoryDeliveryFormRegistry, InMemoryMessageThreadRegistry } from "../dist/categories/registry.js";
import { scanTextForSecrets } from "../dist/categories/secrets.js";
import { MemoryStore } from "../dist/db.js";

const HUB_ADDR = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const SELLER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";
const BUYER_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const REVIEWER_KEY = "0x3333333333333333333333333333333333333333333333333333333333333333";
const STRANGER_KEY = "0x4444444444444444444444444444444444444444444444444444444444444444";
const seller = privateKeyToAccount(SELLER_KEY);
const buyer = privateKeyToAccount(BUYER_KEY);
const reviewer = privateKeyToAccount(REVIEWER_KEY);
const stranger = privateKeyToAccount(STRANGER_KEY);

const EXPECTED_MANIFEST_ORDER = [
  "dealId",
  "agreementDigest",
  "uploader",
  "sequence",
  "prevCommitment",
  "fileHashes",
  "metadataCommitment",
  "nonce",
  "expiresAt",
];

const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const dealId = () => `0x${randomBytes(32).toString("hex")}`;
const bytes32 = (seed) => `0x${sha256hex(seed)}`;

// Signed-request client: EIP-191 personal_sign of
// `${METHOD}\n${path}\n${sha256hex(body)}\n${expiry}` (empty body = sha256('')).
async function signedInject(app, { method, url, payload, account, expirySkew = 300 }) {
  const bodyStr = payload === undefined ? "" : JSON.stringify(payload);
  const expiry = String(Math.floor(Date.now() / 1000) + expirySkew);
  const message = `${method}\n${url}\n${sha256hex(bodyStr)}\n${expiry}`;
  const signature = await account.signMessage({ message });
  const headers = {
    "x-wallet-address": account.address,
    "x-wallet-expiry": expiry,
    "x-wallet-signature": signature,
  };
  const opts = { method, url, headers };
  if (payload !== undefined) {
    opts.payload = bodyStr;
    opts.headers["content-type"] = "application/json";
  }
  return app.inject(opts);
}

function buildApp(store) {
  const app = Fastify({ logger: false });
  const deps = {
    store,
    reader: null,
    indexer: null,
    hub: HUB_ADDR,
    usdc: USDC,
    chainId: 8453,
    rpcConfigured: false,
  };
  const opts = {
    forms: new InMemoryDeliveryFormRegistry(),
    threads: new InMemoryMessageThreadRegistry(),
  };
  registerCategoryRoutes(app, deps, opts);
  registerMessageRoutes(app, deps, opts);
  registerCommitmentRoutes(app, deps);
  return app;
}

async function createDeal(store, { agreementDigest } = {}) {
  const id = dealId();
  const terms = { dealId: id, buyer: buyer.address, seller: seller.address };
  if (agreementDigest) terms.agreementDigest = agreementDigest;
  await store.createDraft({
    id: `draft_${id.slice(2, 14)}`,
    dealId: id,
    creatorWallet: seller.address,
    counterpartyHint: buyer.address,
    counterpartyAddress: buyer.address,
    terms,
    signatures: {},
    admission: null,
    revocationNote: null,
    status: "accepted",
  });
  return id;
}

const VALID_FORMS = {
  INSTANT_CODE: {
    redemptionMethod: "Email link",
    identifierLast4: "9f3a",
    notes: "Sent via account email",
  },
  GAME_ITEM: {
    itemName: "Dragon Blade",
    recipientId: "player-4821",
    tradeId: "trade-9917",
    transferNote: "Traded at the market stall",
  },
  GAME_CURRENCY: { amount: "5000000", recipientId: "player-4821", recordId: "rec-123" },
  DIGITAL_GOOD: { fileHash: `0x${"ab".repeat(32)}`, version: "1.4.2" },
  SERVICE: {
    milestone: "Level the garden wall",
    workHash: `0x${"cd".repeat(32)}`,
    completionNote: "Finished on Sunday",
  },
  GAME_ACCOUNT: {
    accountIdentifier: "player-4821",
    transferMethod: "Out-of-band handover at the meetup",
    noCredentialStorageAttestation: true,
    postSettlementNote: "Support channel only after settlement",
  },
};

const SECRET_VALUES = {
  PEM_BLOCK: "-----BEGIN PRIVATE KEY-----\nMIIBfakekeydata\n-----END PRIVATE KEY-----",
  SEED_PHRASE: `${"abandon ".repeat(11)}about`,
  PRIVATE_KEY_ASSIGN: "private_key: hunter2value",
  HEX_SECRET: `the secret is 0x${"0123456789abcdef".repeat(4)} do not share`,
  CLOUD_KEY: "AKIAIOSFODNN7EXAMPLE",
};

describe("secrets.ts export", () => {
  it("exports scanTextForSecrets with the frozen signature", () => {
    assert.equal(typeof scanTextForSecrets, "function");
    assert.equal(scanTextForSecrets.length, 1);
  });

  it("finds each code and passes benign text", () => {
    assert.deepEqual(scanTextForSecrets(SECRET_VALUES.PEM_BLOCK), ["PEM_BLOCK"]);
    assert.deepEqual(scanTextForSecrets(SECRET_VALUES.SEED_PHRASE), ["SEED_PHRASE"]);
    assert.ok(scanTextForSecrets(SECRET_VALUES.PRIVATE_KEY_ASSIGN).includes("PRIVATE_KEY_ASSIGN"));
    assert.ok(scanTextForSecrets(SECRET_VALUES.HEX_SECRET).includes("HEX_SECRET"));
    assert.deepEqual(scanTextForSecrets(SECRET_VALUES.CLOUD_KEY), ["CLOUD_KEY"]);
    assert.deepEqual(scanTextForSecrets("Item handed over in game lobby"), []);
    assert.deepEqual(scanTextForSecrets(`0x${"ab".repeat(32)}`), []);
  });
});

describe("GET /categories", () => {
  it("is public and reports schemas, minimums and criteria", async () => {
    const app = buildApp(new MemoryStore());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/categories" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(
      body.categories.map((c) => c.id),
      ["INSTANT_CODE", "GAME_ITEM", "GAME_CURRENCY", "DIGITAL_GOOD", "SERVICE", "GAME_ACCOUNT"],
    );
    const minimums = Object.fromEntries(body.categories.map((c) => [c.id, c.minInspection]));
    assert.deepEqual(minimums, {
      INSTANT_CODE: 3600,
      GAME_ITEM: 43200,
      GAME_CURRENCY: 43200,
      DIGITAL_GOOD: 43200,
      SERVICE: 43200,
      GAME_ACCOUNT: 86400,
    });
    for (const category of body.categories) {
      assert.ok(Array.isArray(category.fields) && category.fields.length > 0);
      assert.ok(typeof category.completionCriteria === "string" && category.completionCriteria.length > 0);
    }
    const instant = body.categories[0];
    assert.ok(instant.fields.some((f) => f.name === "identifierLast4" && f.required === true));
    const account = body.categories.find((c) => c.id === "GAME_ACCOUNT");
    assert.ok(
      account.fields.some((f) => f.name === "noCredentialStorageAttestation" && f.type === "boolean"),
    );
  });
});

describe("delivery forms", () => {
  it("accepts a valid vector per category and serves it back to both parties", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    for (const [category, data] of Object.entries(VALID_FORMS)) {
      const id = await createDeal(store);
      const posted = await signedInject(app, {
        method: "POST",
        url: `/deals/${id}/delivery-form`,
        payload: { category, data },
        account: seller,
      });
      assert.equal(posted.statusCode, 200, `${category}: ${posted.body}`);
      const created = posted.json();
      assert.equal(created.ok, true);
      assert.match(created.deliveryManifestHash, /^0x[0-9a-f]{64}$/);
      assert.equal(created.version, 1);
      const fetched = await signedInject(app, {
        method: "GET",
        url: `/deals/${id}/delivery-form`,
        account: buyer,
      });
      assert.equal(fetched.statusCode, 200);
      assert.equal(fetched.json().deliveryManifestHash, created.deliveryManifestHash);
    }
  });

  it("versions resubmissions", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    const payload = { category: "GAME_ITEM", data: VALID_FORMS.GAME_ITEM };
    assert.equal((await signedInject(app, { method: "POST", url: `/deals/${id}/delivery-form`, payload, account: seller })).json().version, 1);
    const second = await signedInject(app, { method: "POST", url: `/deals/${id}/delivery-form`, payload, account: seller });
    assert.equal(second.json().version, 2);
  });

  it("rejects invalid vectors with errors", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const cases = [
      [{ category: "NOPE", data: {} }, "Unknown category"],
      [{ category: "GAME_ITEM", data: { recipientId: "player-1" } }, "itemName"],
      [{ category: "GAME_CURRENCY", data: { amount: "abc", recipientId: "p" } }, "amount"],
      [{ category: "GAME_CURRENCY", data: { amount: "0", recipientId: "p" } }, "amount"],
      [{ category: "DIGITAL_GOOD", data: { fileHash: "zzzz", version: "1" } }, "fileHash"],
      [{ category: "INSTANT_CODE", data: { redemptionMethod: "x", identifierLast4: "123" } }, "identifierLast4"],
      [
        {
          category: "GAME_ACCOUNT",
          data: { accountIdentifier: "p", transferMethod: "t", noCredentialStorageAttestation: false },
        },
        "noCredentialStorageAttestation",
      ],
      [{ category: "GAME_ITEM", data: "not-an-object" }, "object"],
    ];
    for (const [payload, fragment] of cases) {
      const id = await createDeal(store);
      const res = await signedInject(app, {
        method: "POST",
        url: `/deals/${id}/delivery-form`,
        payload,
        account: seller,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().ok, false);
      assert.ok(
        res.json().errors.some((e) => e.includes(fragment)),
        `expected ${fragment} in ${JSON.stringify(res.json().errors)}`,
      );
    }
  });

  it("rejects secrets in every string field without echoing them", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const codes = Object.keys(SECRET_VALUES);
    for (const [category, base] of Object.entries(VALID_FORMS)) {
      const stringFields = Object.keys(base).filter((k) => typeof base[k] === "string");
      assert.ok(stringFields.length > 0);
      for (let i = 0; i < stringFields.length; i++) {
        const field = stringFields[i];
        const code = codes[i % codes.length];
        const secret = SECRET_VALUES[code];
        const id = await createDeal(store);
        const res = await signedInject(app, {
          method: "POST",
          url: `/deals/${id}/delivery-form`,
          payload: { category, data: { ...base, [field]: secret } },
          account: seller,
        });
        assert.equal(res.statusCode, 400, `${category}.${field} <- ${code}`);
        const errors = res.json().errors;
        assert.ok(
          errors.some((e) => e.includes(field) && e.includes("blocked content")),
          `${category}.${field}: ${JSON.stringify(errors)}`,
        );
        assert.ok(!res.body.includes(secret), `${category}.${field} echoed the secret`);
      }
    }
  });

  it("enforces seller-only writes, auth, and deal lookup", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    const payload = { category: "GAME_ITEM", data: VALID_FORMS.GAME_ITEM };

    const buyerWrite = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/delivery-form`,
      payload,
      account: buyer,
    });
    assert.equal(buyerWrite.statusCode, 403);

    const strangerWrite = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/delivery-form`,
      payload,
      account: stranger,
    });
    assert.equal(strangerWrite.statusCode, 403);

    const anon = await app.inject({ method: "POST", url: `/deals/${id}/delivery-form`, payload });
    assert.equal(anon.statusCode, 401);

    const expired = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/delivery-form`,
      payload,
      account: seller,
      expirySkew: -60,
    });
    assert.equal(expired.statusCode, 401);

    const farFuture = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/delivery-form`,
      payload,
      account: seller,
      expirySkew: 3600,
    });
    assert.equal(farFuture.statusCode, 401);

    const unknown = await signedInject(app, {
      method: "POST",
      url: `/deals/${dealId()}/delivery-form`,
      payload,
      account: seller,
    });
    assert.equal(unknown.statusCode, 404);

    const malformed = await signedInject(app, {
      method: "POST",
      url: "/deals/not-a-deal/delivery-form",
      payload,
      account: seller,
    });
    assert.equal(malformed.statusCode, 400);

    // No form yet for a fresh deal: buyer read 404s; stranger read 403s.
    const fresh = await createDeal(store);
    const emptyRead = await signedInject(app, { method: "GET", url: `/deals/${fresh}/delivery-form`, account: buyer });
    assert.equal(emptyRead.statusCode, 404);
    const strangerRead = await signedInject(app, {
      method: "GET",
      url: `/deals/${id}/delivery-form`,
      account: stranger,
    });
    assert.equal(strangerRead.statusCode, 403);
  });

  it("lets allowlisted reviewers read forms", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/delivery-form`,
      payload: { category: "GAME_ITEM", data: VALID_FORMS.GAME_ITEM },
      account: seller,
    });
    process.env.REVIEWER_WALLETS = reviewer.address;
    try {
      const res = await signedInject(app, { method: "GET", url: `/deals/${id}/delivery-form`, account: reviewer });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().category, "GAME_ITEM");
    } finally {
      delete process.env.REVIEWER_WALLETS;
    }
  });
});

describe("messages", () => {
  it("posts with per-deal sequences and lists in order", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    const first = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/messages`,
      payload: { text: "Item shipped, tracking soon" },
      account: seller,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().seq, 1);
    assert.equal(first.json().author, seller.address);
    const second = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/messages`,
      payload: { text: "Thanks, will inspect today" },
      account: buyer,
    });
    assert.equal(second.json().seq, 2);
    const listed = await signedInject(app, { method: "GET", url: `/deals/${id}/messages`, account: buyer });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      listed.json().messages.map((m) => [m.seq, m.text]),
      [
        [1, "Item shipped, tracking soon"],
        [2, "Thanks, will inspect today"],
      ],
    );
  });

  it("rejects secrets, overlong and empty text", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    for (const secret of Object.values(SECRET_VALUES)) {
      const res = await signedInject(app, {
        method: "POST",
        url: `/deals/${id}/messages`,
        payload: { text: `hello ${secret}` },
        account: seller,
      });
      assert.equal(res.statusCode, 400);
      assert.ok(!res.body.includes(secret));
    }
    const tooLong = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/messages`,
      payload: { text: "x".repeat(2001) },
      account: seller,
    });
    assert.equal(tooLong.statusCode, 400);
    const empty = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/messages`,
      payload: { text: "   " },
      account: seller,
    });
    assert.equal(empty.statusCode, 400);
    const boundary = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/messages`,
      payload: { text: "Aa1 ".repeat(500) },
      account: seller,
    });
    assert.equal(boundary.statusCode, 200);
    assert.equal(boundary.json().seq, 1);
  });

  it("restricts writes to parties and reads to parties + reviewers", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    const payload = { text: "ping" };
    assert.equal(
      (await signedInject(app, { method: "POST", url: `/deals/${id}/messages`, payload, account: stranger })).statusCode,
      403,
    );
    assert.equal((await app.inject({ method: "POST", url: `/deals/${id}/messages`, payload })).statusCode, 401);
    assert.equal(
      (await signedInject(app, { method: "GET", url: `/deals/${id}/messages`, account: stranger })).statusCode,
      403,
    );
    process.env.REVIEWER_WALLETS = `${reviewer.address}, ${stranger.address}`;
    try {
      assert.equal(
        (await signedInject(app, { method: "GET", url: `/deals/${id}/messages`, account: reviewer })).statusCode,
        200,
      );
      // Reviewers read but never post.
      assert.equal(
        (await signedInject(app, { method: "POST", url: `/deals/${id}/messages`, payload, account: reviewer }))
          .statusCode,
        403,
      );
    } finally {
      delete process.env.REVIEWER_WALLETS;
    }
  });
});

describe("evidence payload", () => {
  function commitmentBody(uploader) {
    return {
      uploader,
      sequence: 0,
      prevCommitment: bytes32("genesis"),
      fileHashes: [bytes32("file-a"), bytes32("file-b")],
      metadataCommitment: bytes32("meta"),
      nonce: bytes32("nonce-1"),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      agreementDigest: bytes32("agreement"),
    };
  }

  it("returns typed-data in threat-model order plus calldata and commitment", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    const res = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/evidence/payload`,
      payload: commitmentBody(seller.address),
      account: seller,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.dealId, id);
    assert.equal(body.primaryType, "EvidenceManifest");
    assert.deepEqual(
      body.types.EvidenceManifest.map((f) => f.name),
      EXPECTED_MANIFEST_ORDER,
    );
    assert.deepEqual(body.domain, {
      name: "MidmanEscrow",
      version: "1",
      chainId: 8453,
      verifyingContract: HUB_ADDR,
    });
    const selector = toFunctionSelector(
      "submitEvidenceCommitment(bytes32,address,uint32,bytes32,bytes32[],bytes32,bytes32,uint64,bytes)",
    );
    assert.ok(body.calldata.startsWith(selector), body.calldata.slice(0, 20));
    assert.match(body.commitment, /^0x[0-9a-f]{64}$/);
    assert.equal(body.message.uploader, seller.address);
  });

  it("lets either party build a payload but binds uploader to the signer", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    const buyerRes = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/evidence/payload`,
      payload: commitmentBody(buyer.address),
      account: buyer,
    });
    assert.equal(buyerRes.statusCode, 200);
    const mismatch = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/evidence/payload`,
      payload: commitmentBody(buyer.address),
      account: seller,
    });
    assert.equal(mismatch.statusCode, 403);
    const outsider = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/evidence/payload`,
      payload: commitmentBody(stranger.address),
      account: stranger,
    });
    assert.equal(outsider.statusCode, 403);
  });

  it("prefers the draft agreementDigest and requires a client one otherwise", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const digest = bytes32("draft-agreement");
    const id = await createDeal(store, { agreementDigest: digest });
    const { agreementDigest: _dropped, ...withoutDigest } = commitmentBody(seller.address);
    const res = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/evidence/payload`,
      payload: withoutDigest,
      account: seller,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().agreementDigest, digest);

    const bare = await createDeal(store);
    const missing = await signedInject(app, {
      method: "POST",
      url: `/deals/${bare}/evidence/payload`,
      payload: withoutDigest,
      account: seller,
    });
    assert.equal(missing.statusCode, 400);
    assert.ok(missing.json().errors.some((e) => e.includes("agreementDigest")));
  });

  it("validates hex and integer shapes", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await app.ready();
    const id = await createDeal(store);
    const malformed = {
      uploader: seller.address,
      sequence: 0,
      prevCommitment: "0x123",
      fileHashes: ["not-hex"],
      metadataCommitment: bytes32("meta"),
      nonce: bytes32("nonce-1"),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      agreementDigest: bytes32("agreement"),
    };
    const res = await signedInject(app, {
      method: "POST",
      url: `/deals/${id}/evidence/payload`,
      payload: malformed,
      account: seller,
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().errors.some((e) => e.includes("prevCommitment")));
    assert.ok(res.json().errors.some((e) => e.includes("fileHashes")));
  });
});
