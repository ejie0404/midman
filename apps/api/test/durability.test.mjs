// Phase 3 durability tests (no database required).
//
// Exercises the durability boundary that lives in @midman/store:
//   * RegistryWriter surfaces a failed durable write to the caller and keeps
//     the queue usable afterwards.
//   * Optimistic concurrency (compare-and-set) detects conflicting updates and
//     never publishes a cache update before the write commits.
//   * Two registry instances over one shared backing store see each other's
//     committed writes (the API instance-B scenario).
//   * createStore() refuses to fall back to memory in production.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DurableCollection,
  MemoryRegistry,
  MemoryStore,
  RegistryWriter,
  createAuthPersistence,
  createRegistry,
  createStore,
  createStoreFromEnv,
  hasKvStore,
} from "../dist/db.js";
import { InMemoryMessageThreadRegistry } from "../dist/categories/registry.js";
import { GENESIS_PREVHASH, InMemoryManifestRegistry } from "../dist/evidence/registry.js";
import {
  createStoreAuthPersistence,
  setAuthPersistence,
} from "../dist/auth/persistence.js";
import {
  __resetSessionsForTests,
  isSessionNonceRevokedDurable,
  revokeSessionNonce,
} from "../dist/auth/session.js";

const SEP = "\u0000";

/** Shared JSONB-style kv backing used by two independent SqlRegistry instances. */
class SharedKv {
  constructor() {
    this.map = new Map();
  }
  key(ns, dealId, key) {
    return `${dealId.toLowerCase()}${SEP}${ns}${SEP}${key}`;
  }
  async kvGet(ns, dealId, key) {
    const raw = this.map.get(this.key(ns, dealId, key));
    return raw === undefined ? null : JSON.parse(raw);
  }
  async kvList(ns, dealId) {
    const prefix = `${dealId.toLowerCase()}${SEP}${ns}${SEP}`;
    const rows = [];
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) rows.push([k.slice(prefix.length), JSON.parse(v)]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return rows.map(([key, value]) => ({ key, value }));
  }
  async kvPut(ns, dealId, key, value) {
    this.map.set(this.key(ns, dealId, key), JSON.stringify(value));
  }
  async kvDelete(ns, dealId, key) {
    this.map.delete(this.key(ns, dealId, key));
  }
  async kvDeals(ns) {
    const deals = new Set();
    for (const k of this.map.keys()) {
      const [dealId, namespace] = k.split(SEP);
      if (namespace === ns) deals.add(dealId);
    }
    return [...deals];
  }
}

describe("RegistryWriter failure propagation", () => {
  it("rejects a failed durable write and keeps the queue usable", async () => {
    let calls = 0;
    const flaky = {
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async put() {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
      },
      async delete() {},
    };
    const writer = new RegistryWriter(flaky);
    await assert.rejects(() => writer.put("ns", "deal", "k", { a: 1 }), /disk full/);
    // The queue must not be poisoned by the rejection.
    await writer.put("ns", "deal", "k", { a: 2 });
    await writer.flush();
    assert.equal(calls, 2);
  });

  it("putSafe swallows failures instead of rejecting", async () => {
    const failing = {
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async put() {
        throw new Error("nope");
      },
      async delete() {},
    };
    const writer = new RegistryWriter(failing);
    await writer.putSafe("ns", "deal", "k", { a: 1 });
  });
});

describe("optimistic concurrency (compare-and-set)", () => {
  it("detects a conflicting update and keeps the committed value", async () => {
    const adapter = new MemoryRegistry();
    const writer = new RegistryWriter(adapter);
    const collection = new DurableCollection("ns", writer, (value) => value.id);

    const v1 = await collection.setAuthoritative("deal", "k", { id: "k", n: 1 }, 0);
    assert.equal(v1, 1);
    assert.equal(collection.get("deal", "k").n, 1);

    await assert.rejects(
      () => collection.setAuthoritative("deal", "k", { id: "k", n: 2 }, 0),
      /conflict/,
    );
    // Cache was not updated to the losing write.
    assert.equal(collection.get("deal", "k").n, 1);
    assert.equal((await collection.getAuthoritative("deal", "k")).n, 1);
  });

  it("refresh re-reads committed state from the backing adapter", async () => {
    const shared = new SharedKv();
    const a = new DurableCollection("ns", new RegistryWriter(createRegistry(shared)), (v) => v.id);
    const b = new DurableCollection("ns", new RegistryWriter(createRegistry(shared)), (v) => v.id);
    await a.set("deal", "k", { id: "k", n: 7 });
    await b.refresh("deal");
    assert.equal(b.get("deal", "k").n, 7);
  });
});

describe("cross-instance visibility", () => {
  it("two registry instances over a shared backing see each other's writes", async () => {
    const shared = new SharedKv();
    const instanceA = createRegistry(shared);
    const instanceB = createRegistry(shared);

    await instanceA.put("evidence.manifest", "0xdeal", "000000000001", { seq: 1, head: "h1" });
    assert.deepEqual(await instanceB.get("evidence.manifest", "0xdeal", "000000000001"), { seq: 1, head: "h1" });
    assert.deepEqual(await instanceB.list("evidence.manifest", "0xdeal"), [{ seq: 1, head: "h1" }]);
    assert.deepEqual(await instanceB.listDeals("evidence.manifest"), ["0xdeal"]);

    await instanceB.delete("evidence.manifest", "0xdeal", "000000000001");
    assert.equal(await instanceA.get("evidence.manifest", "0xdeal", "000000000001"), null);
  });
});

describe("store production guard", () => {
  const originalDb = process.env.DATABASE_URL;
  const originalEnv = process.env.NODE_ENV;
  const restore = () => {
    if (originalDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDb;
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  };

  it("createStore() throws in production without DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => createStore(), /DATABASE_URL required in production/);
      assert.throws(() => createStoreFromEnv(process.env), /DATABASE_URL required in production/);
    } finally {
      restore();
    }
  });

  it("createStore() uses memory in development without DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    delete process.env.NODE_ENV;
    try {
      assert.ok(createStore() instanceof MemoryStore);
    } finally {
      restore();
    }
  });
});

describe("AuthPersistence kv surface", () => {
  it("exposes a RegistryKvStore-compatible store and scoped auth state", async () => {
    const store = new MemoryStore();
    assert.equal(hasKvStore(store), true);

    await store.kvPut("auth.nonce", "0xdeal", "n1", { ok: true });
    assert.deepEqual(await store.kvGet("auth.nonce", "0xdeal", "n1"), { ok: true });
    await store.kvDel("auth.nonce", "0xdeal", "n1");
    assert.equal(await store.kvGet("auth.nonce", "0xdeal", "n1"), null);

    const auth = createAuthPersistence(store);
    await auth.put("auth.challenge", "ch1", { wallet: "0xw" }, new Date(Date.now() + 1000).toISOString());
    assert.deepEqual(await auth.get("auth.challenge", "ch1"), { wallet: "0xw" });
    assert.deepEqual((await auth.list("auth.challenge")).map((entry) => entry.key), ["ch1"]);
    await auth.delete("auth.challenge", "ch1");
    assert.equal(await auth.get("auth.challenge", "ch1"), null);
  });
});

// ---- A2: concurrent single-use consumption + durable revocation ----

describe("A2 atomic single-use consumption across instances", () => {
  const challenge = (nonce) => ({
    domain: "midman.local",
    chainId: 8453,
    wallet: "0xbuyer",
    nonce,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    purpose: "login",
    issuedAt: Math.floor(Date.now() / 1000),
    uri: "https://midman.local",
    consumed: false,
  });

  it("a login challenge is consumable by exactly one of two instances", async () => {
    const store = new MemoryStore();
    const a = createStoreAuthPersistence(store);
    const b = createStoreAuthPersistence(store);
    await a.putChallenge("0x" + "11".repeat(32), challenge("0x" + "11".repeat(32)));
    const results = await Promise.all([
      a.delConsumeChallenge("0x" + "11".repeat(32)),
      b.delConsumeChallenge("0x" + "11".repeat(32)),
    ]);
    assert.equal(results.filter((r) => r !== null).length, 1, "exactly one consume wins");
  });

  it("an invitation is redeemable by exactly one of two instances", async () => {
    const store = new MemoryStore();
    const a = createStoreAuthPersistence(store);
    const b = createStoreAuthPersistence(store);
    const nowIso = new Date().toISOString();
    const tokenHash = "0x" + "ab".repeat(32);
    await a.recordInvitation({
      draftId: "draft-1",
      dealId: "draft-1",
      tokenHash,
      intendedCounterparty: null,
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revoked: false,
      consumed: false,
      redeemedBy: null,
      redeemTx: null,
    });
    const input = { tokenHash, wallet: "0xbuyer", nowIso, redeemTx: null };
    const results = await Promise.all([
      a.redeemInvitation("draft-1", input),
      b.redeemInvitation("draft-1", input),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one redeem wins");
    const failed = results.find((r) => !r.ok);
    assert.equal(failed.reason, "consumed");
  });
});

describe("A3 durable metadata writes", () => {
  it("two registry instances over one adapter allocate distinct sequences", async () => {
    const shared = new MemoryRegistry();
    const a = new InMemoryMessageThreadRegistry();
    const b = new InMemoryMessageThreadRegistry();
    a.setAdapter(shared);
    b.setAdapter(shared);
    const [m1, m2] = await Promise.all([
      a.append("0xdeal", "0xbuyer", "one"),
      b.append("0xdeal", "0xseller", "two"),
    ]);
    assert.notEqual(m1.seq, m2.seq, "concurrent instances must not share a sequence");
    assert.deepEqual([m1.seq, m2.seq].sort((x, y) => x - y), [1, 2]);
  });

  it("a blocked durable write rejects instead of acknowledging", async () => {
    const failing = {
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async put() {
        throw new Error("persistence blocked");
      },
      async delete() {},
      async nextSeq() {
        return 1;
      },
    };
    const reg = new InMemoryMessageThreadRegistry();
    reg.setAdapter(failing);
    await assert.rejects(() => reg.append("0xdeal", "0xbuyer", "hi"), /persistence blocked/);
  });
});

describe("A4 evidence append + nonce atomicity", () => {
  const manifestInput = (fileHash) => ({
    uploader: "0xbuyer",
    kind: "delivery",
    description: "x",
    fileHash,
    prevHash: GENESIS_PREVHASH,
    scan: { status: "clean" },
  });

  it("two instances racing an append never share a sequence", async () => {
    const adapter = new MemoryRegistry();
    const a = new InMemoryManifestRegistry();
    const b = new InMemoryManifestRegistry();
    a.setAdapter(adapter);
    b.setAdapter(adapter);
    const results = await Promise.allSettled([
      a.appendManifestAtomic("0xdeal", manifestInput("0x" + "aa".repeat(32))),
      b.appendManifestAtomic("0xdeal", manifestInput("0x" + "bb".repeat(32))),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    assert.equal(won.length, 1, "exactly one append wins the slot");
    assert.equal(won[0].value.entry.seq, 0);
    // The loser must fail against the advanced head, not clobber seq 0.
    const stored = await adapter.list("evidence.manifest", "0xdeal");
    assert.equal(stored.length, 1, "the store retains exactly one entry");
  });

  it("a nonce is consumable by exactly one of two instances", async () => {
    const adapter = new MemoryRegistry();
    const a = new InMemoryManifestRegistry();
    const b = new InMemoryManifestRegistry();
    a.setAdapter(adapter);
    b.setAdapter(adapter);
    const nonce = "0x" + "12".repeat(32);
    const expiresAt = Math.floor(Date.now() / 1_000) + 300;
    const results = await Promise.all([
      a.consumeAuthNonce({ nonce, dealId: "0xdeal", expiresAt }),
      b.consumeAuthNonce({ nonce, dealId: "0xdeal", expiresAt }),
    ]);
    assert.equal(results.filter(Boolean).length, 1, "exactly one nonce consumption wins");
  });
});

describe("A2 durable session revocation", () => {
  it("revocation is awaited and observable by another instance", async () => {
    const store = new MemoryStore();
    setAuthPersistence(createStoreAuthPersistence(store));
    try {
      await revokeSessionNonce("nonce-xyz");
      // Emulate a fresh API instance: drop the process-local deny-list.
      __resetSessionsForTests();
      assert.equal(await isSessionNonceRevokedDurable("nonce-xyz"), true, "durable revocation observed");
    } finally {
      setAuthPersistence(null);
      __resetSessionsForTests();
    }
  });
});
