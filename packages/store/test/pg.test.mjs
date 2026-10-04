import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgStore, createPgStore } from "../dist/pg.js";
import { MemoryStore, createStore } from "../dist/store.js";
import { PgExecutor, executorFromPool } from "../dist/sql.js";

const DRAFT = {
  id: "draft_abc",
  dealId: "0xdeal",
  creatorWallet: "0xcreator",
  counterpartyHint: null,
  counterpartyAddress: null,
  terms: { buyer: "0xbuyer", principalUnits: "1000000" },
  signatures: {},
  admission: null,
  revocationNote: null,
  status: "draft",
};

const EVENT = {
  txHash: "0xtx",
  logIndex: 0,
  blockNumber: 12n,
  blockHash: "0xblock",
  contractAddress: "0xhub",
  dealId: "0xdeal",
  eventName: "DealFunded",
  args: { amount: "1000000" },
  orphaned: false,
};

const RELAY = {
  idempotencyKey: "idem-1",
  queue: "relay",
  action: "openDispute",
  params: { dealId: "0xdeal" },
  status: "queued",
  attempts: 0,
  txHash: null,
  result: null,
};

const RELAY_ROW = {
  idempotency_key: "idem-1",
  queue: "relay",
  action: "openDispute",
  params: { dealId: "0xdeal" },
  status: "queued",
  attempts: 0,
  tx_hash: null,
  result: null,
};

class FakeExecutor {
  constructor(...responses) {
    this.calls = [];
    this.responses = responses;
    this.index = 0;
  }
  async query(text, params) {
    this.calls.push({ text, params });
    if (this.index < this.responses.length) {
      const next = this.responses[this.index++];
      if (typeof next === "function") return next(text, params);
      return next;
    }
    return { rows: [] };
  }
  get last() {
    return this.calls[this.calls.length - 1];
  }
}

const STORE_METHODS = [
  "createDraft",
  "getDraft",
  "getDraftByDeal",
  "updateDraft",
  "putEvents",
  "getEventsByDeal",
  "blockHashAt",
  "markOrphanedFrom",
  "getTip",
  "setTip",
  "clearContractData",
  "enqueueRelay",
  "getRelay",
  "claimRelay",
  "finishRelay",
  "listQueuedRelay",
  "recordSponsor",
  "countSponsorsSince",
  "listDealIds",
];

describe("PgStore drafts", () => {
  it("createDraft parameterizes every value and upserts", async () => {
    const db = new FakeExecutor();
    await new PgStore(db).createDraft(DRAFT);
    assert.match(db.last.text, /INSERT INTO drafts/);
    assert.match(db.last.text, /\$10/);
    assert.match(db.last.text, /ON CONFLICT \(id\) DO UPDATE/);
    assert.equal(db.last.params[0], "draft_abc");
    assert.equal(db.last.params[5], JSON.stringify(DRAFT.terms));
    assert.ok(!db.last.text.includes("draft_abc"));
  });

  it("getDraft maps a row and returns null when absent", async () => {
    const db = new FakeExecutor({ rows: [{ ...draftRow() }] });
    const draft = await new PgStore(db).getDraft("draft_abc");
    assert.equal(draft.dealId, "0xdeal");
    assert.deepEqual(draft.terms, DRAFT.terms);

    const empty = new FakeExecutor();
    assert.equal(await new PgStore(empty).getDraft("missing"), null);
  });

  it("getDraftByDeal is case-insensitive SQL with a bound parameter", async () => {
    const db = new FakeExecutor({ rows: [draftRow()] });
    await new PgStore(db).getDraftByDeal("0xDEAL");
    assert.match(db.last.text, /lower\(deal_id\) = lower\(\$1\)/);
    assert.deepEqual(db.last.params, ["0xDEAL"]);
  });

  it("updateDraft only parameterizes allowlisted columns", async () => {
    const db = new FakeExecutor();
    await new PgStore(db).updateDraft("draft_abc", {
      status: "signed",
      terms: { a: "1" },
      evil: "drop table drafts; --",
    });
    assert.match(db.last.text, /status = \$2/);
    assert.match(db.last.text, /terms = \$3/);
    assert.match(db.last.text, /updated_at = now\(\)/);
    assert.ok(!db.last.text.includes("evil"));
    assert.ok(!db.last.text.includes("drop table"));
    assert.equal(db.last.params[2], JSON.stringify({ a: "1" }));
  });

  it("updateDraft with no known fields emits no query", async () => {
    const db = new FakeExecutor();
    await new PgStore(db).updateDraft("draft_abc", {});
    assert.equal(db.calls.length, 0);
  });
});

describe("PgStore chain events", () => {
  it("putEvents dedupes via ON CONFLICT and returns inserted count", async () => {
    const db = new FakeExecutor({ rows: [{ inserted: 1 }] });
    const inserted = await new PgStore(db).putEvents([EVENT, EVENT]);
    assert.equal(inserted, 1);
    assert.match(db.last.text, /ON CONFLICT \(tx_hash, log_index\) DO NOTHING/);
    assert.match(db.last.text, /RETURNING 1 AS inserted/);
    assert.equal(db.last.params.length, 18);
    assert.equal(db.last.params[2], "12");
    assert.ok(!db.last.text.includes("0xtx"));
  });

  it("putEvents returns 0 with no query for an empty batch", async () => {
    const db = new FakeExecutor();
    assert.equal(await new PgStore(db).putEvents([]), 0);
    assert.equal(db.calls.length, 0);
  });

  it("getEventsByDeal filters non-orphaned rows ordered by block", async () => {
    const db = new FakeExecutor({
      rows: [
        {
          tx_hash: "0xtx",
          log_index: 2,
          block_number: "12",
          block_hash: "0xblock",
          contract_address: "0xhub",
          deal_id: "0xdeal",
          event_name: "DealFunded",
          args: { amount: "1000000" },
          orphaned: false,
        },
      ],
    });
    const events = await new PgStore(db).getEventsByDeal("0xdeal");
    assert.match(db.last.text, /orphaned = false/);
    assert.match(db.last.text, /ORDER BY block_number ASC, log_index ASC/);
    assert.equal(events[0].blockNumber, 12n);
    assert.equal(events[0].logIndex, 2);
  });

  it("blockHashAt returns hash or null and binds a decimal string", async () => {
    const hit = new FakeExecutor({ rows: [{ block_hash: "0xblock" }] });
    assert.equal(await new PgStore(hit).blockHashAt("0xHUB", 12n), "0xblock");
    assert.deepEqual(hit.last.params, ["0xHUB", "12"]);

    const miss = new FakeExecutor();
    assert.equal(await new PgStore(miss).blockHashAt("0xHUB", 12n), null);
  });

  it("markOrphanedFrom returns the updated row count", async () => {
    const db = new FakeExecutor({ rows: [{ updated: 1 }, { updated: 1 }] });
    const count = await new PgStore(db).markOrphanedFrom("0xhub", 5n);
    assert.equal(count, 2);
    assert.match(db.last.text, /SET orphaned = true/);
    assert.match(db.last.text, /block_number >= \$2/);
  });
});

describe("PgStore indexer tip", () => {
  it("setTip upserts and lowercases the contract key", async () => {
    const db = new FakeExecutor();
    await new PgStore(db).setTip("0xHUB", { blockNumber: 9n, blockHash: "0xblock" });
    assert.match(db.last.text, /ON CONFLICT \(contract_address\) DO UPDATE/);
    assert.deepEqual(db.last.params, ["0xhub", "9", "0xblock"]);
  });

  it("getTip maps bigint and returns null when absent", async () => {
    const hit = new FakeExecutor({ rows: [{ block_number: "9", block_hash: "0xblock" }] });
    const tip = await new PgStore(hit).getTip("0xHUB");
    assert.equal(tip.blockNumber, 9n);
    assert.equal(tip.blockHash, "0xblock");

    const miss = new FakeExecutor();
    assert.equal(await new PgStore(miss).getTip("0xhub"), null);
  });

  it("clearContractData deletes events then tip", async () => {
    const db = new FakeExecutor();
    await new PgStore(db).clearContractData("0xHUB");
    assert.equal(db.calls.length, 2);
    assert.match(db.calls[0].text, /DELETE FROM chain_events/);
    assert.match(db.calls[1].text, /DELETE FROM indexer_tip/);
    assert.deepEqual(db.calls[1].params, ["0xhub"]);
  });
});

describe("PgStore relay outbox", () => {
  it("enqueueRelay reports inserted on a fresh key", async () => {
    const db = new FakeExecutor({ rows: [{ idempotency_key: "idem-1" }] });
    const result = await new PgStore(db).enqueueRelay(RELAY);
    assert.deepEqual(result, { inserted: true, existing: null });
    assert.match(db.last.text, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
    assert.equal(db.last.params[0], "idem-1");
  });

  it("enqueueRelay returns the existing job on conflict", async () => {
    const db = new FakeExecutor({ rows: [] }, { rows: [{ ...RELAY_ROW, status: "processing" }] });
    const result = await new PgStore(db).enqueueRelay(RELAY);
    assert.equal(result.inserted, false);
    assert.equal(result.existing.status, "processing");
    assert.match(db.calls[1].text, /SELECT \* FROM relay_outbox WHERE idempotency_key = \$1/);
  });

  it("claimRelay performs an atomic queued->processing transition", async () => {
    const db = new FakeExecutor({ rows: [{ ...RELAY_ROW, status: "processing", attempts: 1 }] });
    const claimed = await new PgStore(db).claimRelay("idem-1");
    assert.equal(claimed.status, "processing");
    assert.equal(claimed.attempts, 1);
    assert.match(db.last.text, /WHERE idempotency_key = \$1 AND status = 'queued'/);
    assert.match(db.last.text, /RETURNING \*/);

    const empty = new FakeExecutor();
    assert.equal(await new PgStore(empty).claimRelay("idem-1"), null);
  });

  it("finishRelay parameterizes status, tx hash and result", async () => {
    const db = new FakeExecutor();
    await new PgStore(db).finishRelay("idem-1", "sent", "0xhash", { ok: true });
    assert.match(db.last.text, /SET status = \$2, tx_hash = \$3, result = \$4/);
    assert.equal(db.last.params[2], "0xhash");
    assert.equal(db.last.params[3], JSON.stringify({ ok: true }));
  });

  it("listQueuedRelay parameterizes queue and limit", async () => {
    const db = new FakeExecutor({ rows: [RELAY_ROW] });
    const jobs = await new PgStore(db).listQueuedRelay("relay", 25);
    assert.equal(jobs.length, 1);
    assert.match(db.last.text, /status = 'queued'/);
    assert.match(db.last.text, /LIMIT \$2/);
    assert.deepEqual(db.last.params, ["relay", 25]);
  });
});

describe("PgStore sponsor + deals", () => {
  it("recordSponsor inserts a parameterized ledger row", async () => {
    const db = new FakeExecutor();
    await new PgStore(db).recordSponsor("0xtx", "0xdeal", "openDispute");
    assert.match(db.last.text, /INSERT INTO sponsor_ledger/);
    assert.deepEqual(db.last.params, ["0xtx", "0xdeal", "openDispute"]);
  });

  it("countSponsorsSince casts the count to int", async () => {
    const db = new FakeExecutor({ rows: [{ n: 3 }] });
    assert.equal(await new PgStore(db).countSponsorsSince("2020-01-01T00:00:00.000Z"), 3);
    assert.match(db.last.text, /COUNT\(\*\)::int AS n/);
    assert.deepEqual(db.last.params, ["2020-01-01T00:00:00.000Z"]);
  });

  it("listDealIds returns distinct draft deal ids", async () => {
    const db = new FakeExecutor({ rows: [{ deal_id: "0xa" }, { deal_id: "0xb" }] });
    assert.deepEqual(await new PgStore(db).listDealIds(), ["0xa", "0xb"]);
    assert.match(db.last.text, /SELECT DISTINCT deal_id FROM drafts/);
  });
});

describe("PgStore safety", () => {
  it("never interpolates injected values into any method's SQL", async () => {
    const sentinel = "sentinel'; drop table drafts; --";
    const db = new FakeExecutor();
    const store = new PgStore(db);

    const invocations = [
      () => store.createDraft({ ...DRAFT, id: sentinel, dealId: sentinel }),
      () => store.getDraft(sentinel),
      () => store.getDraftByDeal(sentinel),
      () => store.updateDraft(sentinel, { status: sentinel }),
      () => store.putEvents([{ ...EVENT, txHash: sentinel, contractAddress: sentinel, dealId: sentinel }]),
      () => store.getEventsByDeal(sentinel),
      () => store.blockHashAt(sentinel, 1n),
      () => store.markOrphanedFrom(sentinel, 1n),
      () => store.getTip(sentinel),
      () => store.setTip(sentinel, { blockNumber: 1n, blockHash: sentinel }),
      () => store.clearContractData(sentinel),
      () => store.enqueueRelay({ ...RELAY, idempotencyKey: sentinel, queue: sentinel }),
      () => store.getRelay(sentinel),
      () => store.claimRelay(sentinel),
      () => store.finishRelay(sentinel, sentinel, sentinel, null),
      () => store.listQueuedRelay(sentinel, 1),
      () => store.recordSponsor(sentinel, sentinel, sentinel),
      () => store.countSponsorsSince(sentinel),
    ];

    for (const invoke of invocations) {
      const start = db.calls.length;
      await invoke();
      const emitted = db.calls.slice(start);
      assert.ok(emitted.length >= 1);
      for (const call of emitted) {
        assert.ok(!call.text.includes(sentinel), `SQL interpolated a value: ${call.text}`);
        assert.match(call.text, /\$\d+/);
        assert.ok(
          (call.params ?? []).some((param) => JSON.stringify(param).includes(sentinel)),
          "expected the sentinel to reach the bound parameters",
        );
      }
    }
  });

  it("exposes every Store method", () => {
    const store = new PgStore(new FakeExecutor());
    for (const method of STORE_METHODS) {
      assert.equal(typeof store[method], "function", `missing method: ${method}`);
    }
  });

  it("createPgStore builds a PgStore from an injected executor", () => {
    assert.ok(createPgStore(new FakeExecutor()) instanceof PgStore);
  });
});

describe("SqlExecutor", () => {
  it("executorFromPool forwards text and params to the pool", async () => {
    const seen = [];
    const executor = executorFromPool({
      async query(text, params) {
        seen.push({ text, params });
        return { rows: [{ ok: 1 }] };
      },
    });
    const result = await executor.query("SELECT $1", ["x"]);
    assert.deepEqual(result.rows, [{ ok: 1 }]);
    assert.deepEqual(seen, [{ text: "SELECT $1", params: ["x"] }]);
  });

  it("PgExecutor accepts a connection string without loading pg until query", () => {
    const executor = new PgExecutor("postgres://unused.invalid/db");
    assert.ok(executor instanceof PgExecutor);
  });
});

describe("createStore selection", () => {
  const originalDb = process.env.DATABASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  const restore = () => {
    if (originalDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDb;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  };

  it("returns MemoryStore in dev without DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    delete process.env.NODE_ENV;
    try {
      assert.ok(createStore() instanceof MemoryStore);
    } finally {
      restore();
    }
  });

  it("refuses the in-memory store in production without DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => createStore(), /DATABASE_URL required in production/);
    } finally {
      restore();
    }
  });

  it("returns a PgStore-like object when DATABASE_URL is set", () => {
    process.env.DATABASE_URL = "postgres://unused.invalid/db";
    process.env.NODE_ENV = "production";
    try {
      const store = createStore();
      assert.ok(store instanceof PgStore);
      assert.ok(!(store instanceof MemoryStore));
      for (const method of STORE_METHODS) assert.equal(typeof store[method], "function");
    } finally {
      restore();
    }
  });

  it("returns PgStore for an injected executor regardless of env", () => {
    process.env.NODE_ENV = "production";
    try {
      assert.ok(createStore(new FakeExecutor()) instanceof PgStore);
    } finally {
      restore();
    }
  });
});

function draftRow() {
  return {
    id: DRAFT.id,
    deal_id: DRAFT.dealId,
    creator_wallet: DRAFT.creatorWallet,
    counterparty_hint: null,
    counterparty_address: null,
    terms: DRAFT.terms,
    signatures: {},
    admission: null,
    revocation_note: null,
    status: "draft",
  };
}
