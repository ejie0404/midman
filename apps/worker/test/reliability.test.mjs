import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcPool, createResilientReader } from "../dist/reliability/rpcPool.js";
import { estimateGasWithBuffer } from "../dist/reliability/gas.js";
import { SponsorshipBudget } from "../dist/reliability/budget.js";
import { AbuseControls, isHexData } from "../dist/reliability/abuse.js";
import { reliabilitySummaryFromEnv } from "../dist/reliability/index.js";

const TO = "0x00000000000000000000000000000000000000aa";
const TX = { to: TO, data: "0x" };

describe("rpcPool", () => {
  it("fails over to the next healthy URL and cools down the failed one", async () => {
    const now = 1_000;
    const tried = [];
    const pool = new RpcPool(["a", "b"], { cooldownSeconds: 60, now: () => now });
    const value = await pool.read(async (url) => {
      tried.push(url);
      if (url === "a") throw new Error("down");
      return `ok:${url}`;
    });
    assert.equal(value, "ok:b");
    assert.deepEqual(tried, ["a", "b"]);
    assert.deepEqual(pool.healthyUrls(), ["b"]);
    // Cooldown expiry restores preference order.
    assert.deepEqual(pool.healthyUrls(now + 61), ["a", "b"]);
  });

  it("healthCheck probes each URL and parks failures", async () => {
    const pool = new RpcPool(["a", "b"], {
      now: () => 5,
      probe: async (url) => {
        if (url === "a") throw new Error("boom");
        return 42n;
      },
    });
    const health = await pool.healthCheck();
    assert.equal(health[0].ok, false);
    assert.equal(health[0].error, "boom");
    assert.equal(health[1].ok, true);
    assert.equal(health[1].blockNumber, 42n);
    assert.deepEqual(pool.healthyUrls(), ["b"]);
  });

  it("throws only after every URL fails, and still forces a read when all are cooling", async () => {
    const pool = new RpcPool(["a", "b"], { now: () => 0 });
    await assert.rejects(
      pool.read(async () => {
        throw new Error("nope");
      }),
      /nope/,
    );
    assert.deepEqual(pool.healthyUrls(), []);
    // A total cooldown must not wedge reads: every URL is retried.
    assert.equal(await pool.read(async (url) => url), "a");
  });

  it("createResilientReader exposes the full ChainReader surface", () => {
    const reader = createResilientReader(["http://localhost:8545"], { now: () => 0 });
    for (const method of [
      "getLatestBlockNumber",
      "getBlock",
      "getBlockByTag",
      "getLogs",
      "getTransactionReceipt",
      "getDeal",
      "getClaim",
      "getLiabilities",
      "getTokenBalance",
      "isPanelMember",
      "getBondPolicy",
    ]) {
      assert.equal(typeof reader[method], "function", method);
    }
  });
});

describe("gas buffer", () => {
  it("applies the buffer in exact integer wei math", async () => {
    const client = {
      estimateGas: async () => 100_000n,
      getBlock: async () => ({ baseFeePerGas: null }),
      getGasPrice: async () => 5n,
    };
    const result = await estimateGasWithBuffer(client, TX, 2500);
    assert.equal(result.gasLimit, 125_000n);
    assert.equal(result.fallback, false);
    assert.equal(result.maxFeePerGas, 5n);
    assert.equal(result.maxPriorityFeePerGas, 5n);
  });

  it("returns the documented fallback with EIP-1559 fees when estimation fails", async () => {
    const client = {
      estimateGas: async () => {
        throw new Error("estimate failed");
      },
      getBlock: async () => ({ baseFeePerGas: 100n }),
      getGasPrice: async () => 150n,
    };
    const result = await estimateGasWithBuffer(client, TX, 2500);
    assert.equal(result.gasLimit, 400_000n);
    assert.equal(result.fallback, true);
    assert.equal(result.maxPriorityFeePerGas, 50n);
    assert.equal(result.maxFeePerGas, 250n);
  });
});

describe("sponsorship budget", () => {
  it("caps daily transaction count", () => {
    const budget = new SponsorshipBudget({ txCap: 2, weiCap: 100n, now: () => 1_000 });
    assert.equal(budget.canSpend(1, 0n), true);
    budget.record("t1", 10n, 1_000);
    budget.record("t2", 10n, 1_000);
    assert.equal(budget.canSpend(1, 0n), false);
    assert.deepEqual(budget.remaining(), { day: 0, tx: 0, wei: 80n });
  });

  it("caps daily wei spend with exact bigint math", () => {
    const budget = new SponsorshipBudget({ txCap: 10, weiCap: 100n, now: () => 1_000 });
    assert.equal(budget.canSpend(1, 100n), true);
    budget.record("t1", 100n, 1_000);
    assert.equal(budget.canSpend(1, 1n), false);
    assert.equal(budget.canSpend(0, 0n), true);
    assert.equal(budget.remaining().wei, 0n);
  });

  it("resets at the UTC day boundary", () => {
    let now = 1_000;
    const budget = new SponsorshipBudget({ txCap: 1, weiCap: 10n, now: () => now });
    budget.record("t1", 10n, 1_000);
    assert.equal(budget.canSpend(1, 1n), false);
    now = 1_000 + 86_400;
    assert.equal(budget.canSpend(1, 1n), true);
  });

  it("persists usage to the JSON file and reloads it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "mm-budget-")), "budget.json");
    const first = new SponsorshipBudget({ txCap: 5, weiCap: 100n, file, now: () => 1_000 });
    first.record("t1", 40n, 1_000);
    const second = new SponsorshipBudget({ txCap: 5, weiCap: 100n, file, now: () => 1_000 });
    assert.deepEqual(second.used(), { count: 1, wei: 40n });
    assert.deepEqual(second.remaining(), { day: 0, tx: 4, wei: 60n });
  });
});

describe("abuse controls", () => {
  it("rate-limits relay submissions per key", () => {
    const abuse = new AbuseControls({ relayRatePerMin: 2, now: () => 100 });
    assert.equal(abuse.checkRelay("k").allowed, true);
    assert.equal(abuse.checkRelay("k").allowed, true);
    const denied = abuse.checkRelay("k");
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, "rate-limited");
    assert.ok(denied.retryAfterSeconds > 0);
    // A different key has its own bucket.
    assert.equal(abuse.checkRelay("other").allowed, true);
  });

  it("rate-limits evidence uploads and rejects empty bodies", () => {
    const abuse = new AbuseControls({ evidenceRatePerMin: 1, now: () => 0 });
    assert.equal(abuse.checkUpload("k", 10).allowed, true);
    assert.equal(abuse.checkUpload("k", 10).allowed, false);
    const empty = abuse.checkUpload("k2", 0);
    assert.equal(empty.allowed, false);
    assert.equal(empty.reason, "bad-size");
  });

  it("detects duplicate content hashes inside the window", () => {
    const abuse = new AbuseControls({ duplicateWindowSeconds: 300, now: () => 0 });
    assert.equal(abuse.checkDuplicate("0xAB", 1_000).allowed, true);
    const duplicate = abuse.checkDuplicate("0xab", 1_100);
    assert.equal(duplicate.allowed, false);
    assert.equal(duplicate.reason, "duplicate");
    assert.equal(abuse.checkDuplicate("0xab", 1_400).allowed, true);
  });

  it("rejects oversize payloads and non-hex data", () => {
    const abuse = new AbuseControls({ relayMaxBytes: 10 });
    const oversize = abuse.checkPayload("x".repeat(11));
    assert.equal(oversize.allowed, false);
    assert.equal(oversize.reason, "oversize");
    const nonHex = abuse.checkPayload("{}", "0xzz");
    assert.equal(nonHex.allowed, false);
    assert.equal(nonHex.reason, "non-hex");
    assert.equal(abuse.checkPayload("{}", "0x1234").allowed, true);
    assert.equal(isHexData("0x1234"), true);
    assert.equal(isHexData("0x123"), false);
  });

  it("reports configured limits from the environment", () => {
    const summary = reliabilitySummaryFromEnv();
    assert.equal(summary.rpc.cooldownSeconds, 60);
    assert.equal(summary.gas.bufferBps, 2500);
    assert.equal(summary.gas.fallbackGasLimit, 400000);
    assert.equal(summary.sponsor.dailyTxCap, 50);
    assert.equal(summary.sponsor.dailyWeiCap, "20000000000000000");
    assert.equal(summary.abuse.relayRatePerMin, 30);
    assert.equal(summary.abuse.evidenceRatePerMin, 10);
    assert.equal(summary.abuse.duplicateWindowSeconds, 300);
    assert.equal(summary.abuse.relayMaxBytes, 20000);
  });
});
