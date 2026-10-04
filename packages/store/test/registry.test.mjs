// Durability boundary tests for @midman/store's registry layer.
//
// These exercise the storage-agnostic RegistryAdapter (MemoryRegistry and a
// JSONB-flavoured SqlRegistry over a FakeKvStore) plus the write-through /
// rehydration helpers the four metadata domains are built on:
//   evidence manifest, delivery forms, message threads, review cases,
//   quorum approvals and settlement proposals.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryRegistry,
  SqlRegistry,
  createRegistry,
  RegistryWriter,
  DurableCollection,
  hydrateNamespace,
  orderedKey,
} from "../dist/registry.js";

const SEP = "\u0000";

// A Store-like executor with the kv surface (parameter order ns, dealId, key)
// that JSON-serializes values exactly like a jsonb column would.
class FakeKvStore {
  constructor(backing = new Map()) {
    this.backing = backing;
  }
  _key(ns, dealId, key) {
    return `${dealId}${SEP}${ns}${SEP}${key}`;
  }
  async kvGet(ns, dealId, key) {
    const raw = this.backing.get(this._key(ns, dealId, key));
    return raw === undefined ? null : JSON.parse(raw);
  }
  async kvList(ns, dealId) {
    const prefix = `${dealId}${SEP}${ns}${SEP}`;
    const rows = [];
    for (const [k, v] of this.backing) {
      if (k.startsWith(prefix)) rows.push([k.slice(prefix.length), JSON.parse(v)]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return rows.map(([key, value]) => ({ key, value }));
  }
  async kvPut(ns, dealId, key, value) {
    this.backing.set(this._key(ns, dealId, key), JSON.stringify(value));
  }
  async kvDelete(ns, dealId, key) {
    this.backing.delete(this._key(ns, dealId, key));
  }
  async kvDeals(ns) {
    const deals = new Set();
    for (const k of this.backing.keys()) {
      const [dealId, namespace] = k.split(SEP);
      if (namespace === ns) deals.add(dealId);
    }
    return [...deals];
  }
}

const DEAL = "0x1111111111111111111111111111111111111111111111111111111111111111";

// A SqlRegistry over the fake JSONB backing (the durable adapter under test).
class FakeSqlRegistry extends SqlRegistry {
  constructor(backing = new Map()) {
    super(new FakeKvStore(backing));
  }
}

describe("MemoryRegistry (Map adapter)", () => {
  it("round-trips get/list/put/delete", async () => {
    const registry = new MemoryRegistry();
    assert.equal(await registry.get("ns", DEAL, "k"), null);
    await registry.put("ns", DEAL, "k", { a: 1 });
    assert.deepEqual(await registry.get("ns", DEAL, "k"), { a: 1 });
    await registry.put("ns", DEAL, "k2", { a: 2 });
    assert.deepEqual(await registry.list("ns", DEAL), [{ a: 1 }, { a: 2 }]);
    await registry.delete("ns", DEAL, "k");
    assert.equal(await registry.get("ns", DEAL, "k"), null);
    assert.deepEqual(await registry.list("ns", DEAL), [{ a: 2 }]);
  });

  it("enumerates deals per namespace and isolates namespaces", async () => {
    const registry = new MemoryRegistry();
    await registry.put("a", DEAL, "k", 1);
    await registry.put("a", "0xother", "k", 1);
    await registry.put("b", DEAL, "k", 1);
    assert.deepEqual((await registry.listDeals("a")).sort(), [DEAL, "0xother"].sort());
    assert.deepEqual(await registry.listDeals("b"), [DEAL]);
    assert.deepEqual(await registry.listDeals("missing"), []);
  });
});

describe("SqlRegistry (JSONB adapter)", () => {
  it("round-trips through a Store-like kv executor", async () => {
    const store = new FakeKvStore();
    const registry = new SqlRegistry(store);
    await registry.put("ns", DEAL, "k", { nested: { n: 7 } });
    assert.deepEqual(await registry.get("ns", DEAL, "k"), { nested: { n: 7 } });
  });

  it("FakeSqlRegistry round-trips a deal-scoped key/value", async () => {
    const registry = new FakeSqlRegistry();
    await registry.put("ns", DEAL, "k", { ok: true });
    assert.deepEqual(await registry.get("ns", DEAL, "k"), { ok: true });
    assert.equal(await registry.get("ns", "0xother", "k"), null);
  });

  it("lists values ordered by storage key", async () => {
    const registry = new FakeSqlRegistry();
    for (const seq of [2, 0, 1]) {
      await registry.put("seq", DEAL, orderedKey(seq), { seq });
    }
    assert.deepEqual((await registry.list("seq", DEAL)).map((v) => v.seq), [0, 1, 2]);
  });

  it("stores an immutable JSON snapshot (jsonb semantics)", async () => {
    const registry = new FakeSqlRegistry();
    const value = { count: 1, tags: ["x"] };
    await registry.put("ns", DEAL, "k", value);
    value.count = 99;
    value.tags.push("mutated");
    assert.deepEqual(await registry.get("ns", DEAL, "k"), { count: 1, tags: ["x"] });
  });

  it("deletes and enumerates deals via kvDeals", async () => {
    const registry = new FakeSqlRegistry();
    await registry.put("ns", DEAL, "k", 1);
    await registry.put("ns", "0xother", "k", 1);
    assert.deepEqual((await registry.listDeals("ns")).sort(), [DEAL, "0xother"].sort());
    await registry.delete("ns", DEAL, "k");
    assert.equal(await registry.get("ns", DEAL, "k"), null);
  });
});

describe("createRegistry selector", () => {
  it("picks SqlRegistry when the store exposes kv methods", () => {
    assert.ok(createRegistry(new FakeKvStore()) instanceof SqlRegistry);
  });

  it("falls back to MemoryRegistry for stores without kv methods", () => {
    assert.ok(createRegistry({}) instanceof MemoryRegistry);
    assert.ok(createRegistry(null) instanceof MemoryRegistry);
  });
});

describe("restart simulation", () => {
  it("MemoryRegistry over a shared backing retains state", async () => {
    const backing = new Map();
    const first = new MemoryRegistry(backing);
    await first.put("ns", DEAL, "k", { v: 1 });
    const restarted = new MemoryRegistry(backing);
    assert.deepEqual(await restarted.get("ns", DEAL, "k"), { v: 1 });
    assert.deepEqual(await restarted.listDeals("ns"), [DEAL]);
  });

  it("SqlRegistry over a shared backing store retains state", async () => {
    const store = new FakeKvStore();
    await new SqlRegistry(store).put("ns", DEAL, "k", { v: 1 });
    const restarted = new SqlRegistry(store);
    assert.deepEqual(await restarted.get("ns", DEAL, "k"), { v: 1 });
  });
});

describe("DurableCollection backward compatibility (no adapter)", () => {
  it("behaves as the original in-memory registry", async () => {
    const writer = new RegistryWriter();
    const collection = new DurableCollection("ns", writer, (v) => v.id);
    assert.equal(await collection.set("deal", "k", { id: "k", n: 1 }), undefined);
    await collection.set("deal", "k2", { id: "k2", n: 2 });
    assert.equal(collection.get("deal", "k").n, 1);
    assert.deepEqual(collection.list("deal").map((v) => v.id), ["k", "k2"]);
    await writer.flush();
    await collection.hydrate();
    assert.equal(collection.size("deal"), 2);
  });
});

describe("evidence manifest domain", () => {
  it("appends an ordered chain, persists it, and rehydrates the head", async () => {
    const adapter = new MemoryRegistry();
    const writer = new RegistryWriter(adapter);
    const manifest = new DurableCollection("evidence.manifest", writer, (entry) => orderedKey(entry.seq));
    void manifest.set(DEAL, orderedKey(0), { seq: 0, prevHash: "genesis", head: "h0" });
    void manifest.set(DEAL, orderedKey(1), { seq: 1, prevHash: "h0", head: "h1" });
    await writer.flush();
    assert.equal(manifest.list(DEAL).at(-1).head, "h1");

    const restarted = new DurableCollection("evidence.manifest", new RegistryWriter(adapter), (entry) =>
      orderedKey(entry.seq),
    );
    await restarted.hydrate();
    assert.deepEqual(restarted.list(DEAL).map((entry) => entry.head), ["h0", "h1"]);
    assert.equal(restarted.list(DEAL).at(-1).head, "h1");
  });
});

describe("delivery form domain", () => {
  it("versions resubmissions and rehydrates the active version", async () => {
    const adapter = new FakeSqlRegistry();
    const writer = new RegistryWriter(adapter);
    const forms = new DurableCollection("categories.delivery-form", writer, (record) => orderedKey(record.version));
    void forms.set(DEAL, orderedKey(1), { version: 1, category: "GAME_ITEM" });
    void forms.set(DEAL, orderedKey(2), { version: 2, category: "GAME_ITEM" });
    await writer.flush();

    const restarted = new DurableCollection("categories.delivery-form", new RegistryWriter(adapter), (record) =>
      orderedKey(record.version),
    );
    await restarted.hydrate([DEAL]);
    assert.deepEqual(restarted.list(DEAL).map((record) => record.version), [1, 2]);
    assert.equal(restarted.list(DEAL).at(-1).version, 2);
  });
});

describe("message thread domain", () => {
  it("keeps per-deal sequence numbers across a restart", async () => {
    const adapter = new MemoryRegistry();
    const writer = new RegistryWriter(adapter);
    const threads = new DurableCollection("categories.messages", writer, (message) => orderedKey(message.seq));
    void threads.set(DEAL, orderedKey(1), { seq: 1, author: "a", text: "one" });
    void threads.set(DEAL, orderedKey(2), { seq: 2, author: "b", text: "two" });
    void threads.set("0xother", orderedKey(1), { seq: 1, author: "a", text: "other" });
    await writer.flush();

    const restarted = new DurableCollection("categories.messages", new RegistryWriter(adapter), (message) =>
      orderedKey(message.seq),
    );
    await restarted.hydrate();
    assert.deepEqual(restarted.list(DEAL).map((message) => message.seq), [1, 2]);
    assert.equal(restarted.list("0xother").length, 1);
  });
});

describe("review case domain", () => {
  it("persists assignment and recusal updates and rehydrates them", async () => {
    const adapter = new FakeSqlRegistry();
    const writer = new RegistryWriter(adapter);
    const cases = new DurableCollection("review.cases", writer, (record) => record.dealId.toLowerCase());
    void cases.set(DEAL, DEAL, {
      dealId: DEAL,
      primary: ["0xaaaa"],
      fallback: ["0xbbbb"],
      recusals: [],
      createdAt: "t0",
      updatedAt: "t0",
    });
    const current = cases.get(DEAL, DEAL);
    current.recusals.push({ reviewer: "0xaaaa", reason: "coi", at: "t1" });
    void cases.set(DEAL, DEAL, current);
    await writer.flush();

    const restarted = new DurableCollection("review.cases", new RegistryWriter(adapter), (record) =>
      record.dealId.toLowerCase(),
    );
    await restarted.hydrate();
    const reloaded = restarted.get(DEAL, DEAL);
    assert.deepEqual(reloaded.primary, ["0xaaaa"]);
    assert.equal(reloaded.recusals.length, 1);
    assert.equal(reloaded.recusals[0].reason, "coi");
  });
});

describe("approvals domain", () => {
  it("dedupes signers, reaches quorum, and survives a restart", async () => {
    const adapter = new MemoryRegistry();
    const writer = new RegistryWriter(adapter);
    const slots = new DurableCollection("review.approvals", writer, (slot) => slot.digest);
    const digest = "0xabcd";
    const record = async (signer) => {
      const existing = slots.get(DEAL, digest);
      if (existing && existing.signers.includes(signer)) throw new Error("duplicate approval");
      const slot = existing ?? { digest, origin: 0, epoch: "1", need: 2, signers: [], signatures: [] };
      slot.signers.push(signer);
      slot.signatures.push(`sig-${signer}`);
      return slots.set(DEAL, digest, slot);
    };
    await record("0xaaaa");
    await assert.rejects(() => record("0xaaaa"), /duplicate/);
    await record("0xbbbb");
    await writer.flush();
    assert.equal(slots.get(DEAL, digest).signers.length >= slots.get(DEAL, digest).need, true);

    const restarted = new DurableCollection("review.approvals", new RegistryWriter(adapter), (slot) => slot.digest);
    await restarted.hydrate();
    const reloaded = restarted.get(DEAL, digest);
    assert.deepEqual(reloaded.signers, ["0xaaaa", "0xbbbb"]);
    assert.equal(reloaded.signers.length >= reloaded.need, true);
  });
});

describe("settlement proposals domain", () => {
  it("persists the open -> accepted lifecycle and rehydrates status", async () => {
    const adapter = new FakeSqlRegistry();
    const writer = new RegistryWriter(adapter);
    const proposals = new DurableCollection("review.proposals", writer, (proposal) => proposal.id);
    const id = "prop_0001";
    void proposals.set(DEAL, id, { id, dealId: DEAL, status: "open" });
    const open = proposals.get(DEAL, id);
    void proposals.set(DEAL, id, { ...open, status: "accepted" });
    await writer.flush();

    const restarted = new DurableCollection("review.proposals", new RegistryWriter(adapter), (proposal) => proposal.id);
    await restarted.hydrate();
    assert.equal(restarted.list(DEAL).length, 1);
    assert.equal(restarted.get(DEAL, id).status, "accepted");
  });
});

describe("hydrateNamespace", () => {
  it("applies nothing for an adapter without listDeals and no explicit dealIds", async () => {
    let applied = 0;
    await hydrateNamespace({}, "ns", undefined, () => {
      applied += 1;
    });
    assert.equal(applied, 0);
  });
});
