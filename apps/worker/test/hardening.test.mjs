// Hardening tests: calldata validation, atomic lease + crash recovery, bounded
// retries, sponsor nonce serialization, receipt reconciliation, sponsorship
// budget, and abuse rate limiting. Uses MemoryStore + injected transport/gas/
// receipt fakes so no network or real sponsor key is required.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { HUB_ABI } from "@midman/chain";
import { MemoryStore } from "@midman/store";
import {
  RelayProcessor,
  validateRelayJob,
  reconcileSubmitted,
  retryBackoffSeconds,
} from "../dist/reliability/hardening.js";
import { SponsorshipBudget } from "../dist/reliability/budget.js";
import { AbuseControls } from "../dist/reliability/abuse.js";

const HUB = "0x00000000000000000000000000000000000000aa";
const DEAL = "0x1111111111111111111111111111111111111111111111111111111111111111";
const TX_HASH = "0x" + "ab".repeat(32);
const SPONSOR = { key: "0x" + "11".repeat(32), rpcUrl: "http://localhost:8545", dailyCapTxs: 10_000 };

// ---- Build real calldata from the generated HUB_ABI (no hand-rolled hex) ----

function sample(type, components) {
  if (type.startsWith("tuple")) {
    const obj = {};
    for (const component of components ?? []) obj[component.name] = sample(component.type, component.components);
    return type.endsWith("[]") ? [obj] : obj;
  }
  if (type.endsWith("[]")) return [sample(type.slice(0, -2), components)];
  if (type === "address") return "0x0000000000000000000000000000000000000000";
  if (type === "bool") return false;
  if (type === "bytes32") return "0x" + "00".repeat(32);
  if (type === "bytes") return "0x";
  if (type === "string") return "";
  return 0;
}

function calldataFor(name) {
  const item = HUB_ABI.find((entry) => entry.type === "function" && entry.name === name);
  assert.ok(item, `missing ABI function ${name}`);
  return encodeFunctionData({
    abi: HUB_ABI,
    functionName: name,
    args: item.inputs.map((input) => sample(input.type, input.components)),
  });
}

// ---- Fakes ----

function gasClient({ estimate = 100_000n, baseFee = null, price = 0n } = {}) {
  return {
    async estimateGas() {
      return estimate;
    },
    async getBlock() {
      return { baseFeePerGas: baseFee };
    },
    async getGasPrice() {
      return price;
    },
  };
}

function fakeTransport({ start = 5, fail = false, hash = TX_HASH } = {}) {
  const nonces = [];
  return {
    nonces,
    async getNonce() {
      return start;
    },
    async send(tx) {
      nonces.push(tx.nonce);
      if (fail) throw new Error("send-boom");
      return hash;
    },
  };
}

function makeProcessor(store, options = {}) {
  let clock = options.clock ?? 1_000;
  const now = options.now ?? (() => clock);
  const processor = new RelayProcessor({
    store,
    hub: HUB,
    sponsor: options.sponsor ?? null,
    budget: options.budget ?? null,
    abuse: options.abuse ?? null,
    gasClient: options.gasClient ?? null,
    transport: options.transport ?? null,
    now,
    leaseTtlSeconds: options.ttl ?? 120,
    maxAttempts: options.maxAttempts ?? 5,
  });
  return {
    processor,
    advance(seconds) {
      clock += seconds;
    },
  };
}

async function enqueue(store, key, action = "finalizeAfterTimeout", overrides = {}) {
  await store.enqueueRelay({
    idempotencyKey: key,
    queue: "relay",
    action,
    params: { dealId: DEAL, data: calldataFor(action), ...overrides },
    status: "queued",
    attempts: 0,
    txHash: null,
    result: null,
  });
}

describe("validateRelayJob", () => {
  it("accepts calldata whose decoded function matches the action", () => {
    const data = calldataFor("finalizeAfterTimeout");
    const result = validateRelayJob({ action: "finalizeAfterTimeout", params: {} }, data);
    assert.equal(result.ok, true);
    assert.equal(result.functionName, "finalizeAfterTimeout");
    assert.equal(result.reason, "ok");
  });

  it("accepts the same calldata via job.params.data", () => {
    const data = calldataFor("refundForNonDelivery");
    const result = validateRelayJob({ action: "refundForNonDelivery", params: { data } });
    assert.equal(result.ok, true);
    assert.equal(result.functionName, "refundForNonDelivery");
  });

  it("rejects calldata whose function does not match the action", () => {
    const data = calldataFor("finalizeAfterTimeout");
    const result = validateRelayJob({ action: "executeRuling", params: {} }, data);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "action-calldata-mismatch");
    assert.equal(result.functionName, "finalizeAfterTimeout");
  });

  it("accepts fund calldata for the fund action", () => {
    const result = validateRelayJob({ action: "fund", params: { data: calldataFor("fund") } });
    assert.equal(result.ok, true);
    assert.equal(result.functionName, "fund");
  });

  it("rejects non-fund calldata for the fund action", () => {
    const result = validateRelayJob({ action: "fund", params: {} }, calldataFor("finalizeAfterTimeout"));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "action-calldata-mismatch");
  });

  it("rejects undecodable or empty calldata", () => {
    assert.equal(validateRelayJob({ action: "fund", params: {} }, "0xdeadbeef").reason, "undecodable-calldata");
    assert.equal(validateRelayJob({ action: "fund", params: {} }, "0x").reason, "no-calldata");
    assert.equal(validateRelayJob({ action: "fund", params: {} }, null).reason, "no-calldata");
  });
});

describe("RelayProcessor lease + crash recovery", () => {
  it("reclaims a stale 'processing' job whose leaseAt is missing", async () => {
    const store = new MemoryStore();
    await enqueue(store, "crash");
    await store.claimRelay("crash"); // status=processing, attempts=1, no lease
    const { processor } = makeProcessor(store);
    const result = await processor.process("crash");
    assert.equal(result.status, "unsigned");
    const job = await store.getRelay("crash");
    assert.equal(job.attempts, 2); // reclaimed => re-claimed
    assert.equal(job.status, "unsigned");
  });

  it("reclaims a processing job only after the lease TTL elapses", async () => {
    const store = new MemoryStore();
    await enqueue(store, "lease");
    await store.finishRelay("lease", "processing", null, { leaseAt: 1_000, leaseOwner: "other" });
    const fresh = makeProcessor(store, { now: () => 1_010, ttl: 120 });
    assert.equal((await fresh.processor.process("lease")).status, "already-handled");
    assert.equal((await store.getRelay("lease")).status, "processing");

    const stale = makeProcessor(store, { now: () => 1_500, ttl: 120 });
    assert.equal((await stale.processor.process("lease")).status, "unsigned");
    assert.equal((await store.getRelay("lease")).attempts, 1);
  });

  it("a non-owning worker never marks a leased job skipped", async () => {
    const store = new MemoryStore();
    await enqueue(store, "owned");
    await store.claimRelayLease("owned", "other-worker", 120);
    let checked = false;
    const processor = new RelayProcessor({
      store,
      hub: HUB,
      checkPreconditions: async () => {
        checked = true;
        return { ok: false, reason: "would-skip" };
      },
      now: () => Math.floor(Date.now() / 1_000),
      leaseTtlSeconds: 120,
    });
    const result = await processor.process("owned");
    assert.equal(result.status, "already-handled");
    assert.equal(checked, false, "preconditions must not run while another worker holds the lease");
    const job = await store.getRelay("owned");
    assert.equal(job.status, "processing", "the lease owner's job is untouched");
  });

  it("treats a terminal job as already-handled", async () => {
    const store = new MemoryStore();
    await enqueue(store, "done");
    await store.finishRelay("done", "confirmed", TX_HASH, null);
    const { processor } = makeProcessor(store);
    assert.equal((await processor.process("done")).status, "already-handled");
  });
});

describe("RelayProcessor bounded retries", () => {
  it("retries with backoff and marks failed at maxAttempts", async () => {
    const store = new MemoryStore();
    await enqueue(store, "retry");
    const transport = fakeTransport({ fail: true });
    const { processor, advance } = makeProcessor(store, {
      sponsor: SPONSOR,
      gasClient: gasClient(),
      transport,
      maxAttempts: 3,
    });
    assert.equal((await processor.process("retry")).status, "retrying");
    assert.equal((await store.getRelay("retry")).status, "queued");
    advance(1_000);
    assert.equal((await processor.process("retry")).status, "retrying");
    advance(1_000);
    assert.equal((await processor.process("retry")).status, "failed");
    const job = await store.getRelay("retry");
    assert.equal(job.status, "failed");
    assert.equal(job.attempts, 3);
    assert.match(job.result.reason, /send-boom/);
  });

  it("submits once and persists the receipt lifecycle status", async () => {
    const store = new MemoryStore();
    await enqueue(store, "submit");
    const transport = fakeTransport({ hash: TX_HASH });
    const { processor } = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport });
    const result = await processor.process("submit");
    assert.equal(result.status, "submitted");
    assert.equal(result.txHash, TX_HASH);
    const job = await store.getRelay("submit");
    assert.equal(job.status, "submitted");
    assert.equal(job.txHash, TX_HASH);
    assert.deepEqual(processor.submittedKeysList(), ["submit"]);
    // A submitted job is never auto-resubmitted.
    assert.equal((await processor.process("submit")).status, "already-handled");
    assert.equal(transport.nonces.length, 1);
  });

  it("backs off exponentially up to a cap", () => {
    assert.equal(retryBackoffSeconds(1, 5), 5);
    assert.equal(retryBackoffSeconds(2, 5), 10);
    assert.equal(retryBackoffSeconds(3, 5), 20);
    assert.equal(retryBackoffSeconds(30, 5), 300);
  });
});

describe("RelayProcessor sponsor nonce coordination", () => {
  it("serializes concurrent sends with strictly increasing nonces", async () => {
    const store = new MemoryStore();
    await enqueue(store, "n1");
    await enqueue(store, "n2");
    const transport = fakeTransport({ start: 5 });
    const { processor } = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport });
    const [first, second] = await Promise.all([processor.process("n1"), processor.process("n2")]);
    assert.equal(first.status, "submitted");
    assert.equal(second.status, "submitted");
    assert.deepEqual(transport.nonces, [5, 6]);
    assert.ok(transport.nonces[1] > transport.nonces[0]);
  });
});

describe("reconcileSubmitted", () => {
  it("flips submitted -> confirmed on a successful receipt", async () => {
    const store = new MemoryStore();
    await enqueue(store, "rc-ok");
    await store.finishRelay("rc-ok", "submitted", TX_HASH, { to: HUB, data: "0x" });
    const reader = {
      async getTransactionReceipt() {
        return { status: true, blockNumber: 7n };
      },
    };
    const outcomes = await reconcileSubmitted(store, reader, ["rc-ok"]);
    assert.equal(outcomes[0].status, "confirmed");
    const job = await store.getRelay("rc-ok");
    assert.equal(job.status, "confirmed");
    assert.equal(job.result.blockNumber, "7");
  });

  it("flips submitted -> reverted on a failed receipt", async () => {
    const store = new MemoryStore();
    await enqueue(store, "rc-bad");
    await store.finishRelay("rc-bad", "submitted", TX_HASH, { to: HUB, data: "0x" });
    const reader = {
      async getTransactionReceipt() {
        return { status: false, blockNumber: 9n };
      },
    };
    const outcomes = await reconcileSubmitted(store, reader, ["rc-bad"]);
    assert.equal(outcomes[0].status, "reverted");
    assert.equal((await store.getRelay("rc-bad")).status, "reverted");
  });

  it("leaves the job submitted when the receipt is not yet available", async () => {
    const store = new MemoryStore();
    await enqueue(store, "rc-pending");
    await store.finishRelay("rc-pending", "submitted", TX_HASH, { to: HUB, data: "0x" });
    const reader = {
      async getTransactionReceipt() {
        return null;
      },
    };
    const outcomes = await reconcileSubmitted(store, reader, ["rc-pending"]);
    assert.equal(outcomes[0].status, "pending");
    assert.equal((await store.getRelay("rc-pending")).status, "submitted");
  });

  it("does not orphan a confirmed job when the receipt RPC throws", async () => {
    const store = new MemoryStore();
    await enqueue(store, "rc-rpc");
    await store.finishRelay("rc-rpc", "confirmed", TX_HASH, { to: HUB, data: "0x" });
    const outcomes = await reconcileSubmitted(store, {
      async getTransactionReceipt() {
        throw new Error("rpc-503");
      },
    }, []);
    assert.equal(outcomes[0].status, "pending");
    assert.equal(outcomes[0].reason, "rpc-unavailable");
    assert.equal((await store.getRelay("rc-rpc")).status, "confirmed", "RPC failure is not proof of disappearance");
  });

  it("keeps a reverted receipt recoverable until finality", async () => {
    const store = new MemoryStore();
    await enqueue(store, "rc-rev");
    await store.finishRelay("rc-rev", "submitted", TX_HASH, { to: HUB, data: "0x" });
    // Above the finalized head -> not yet terminal.
    const tentative = await reconcileSubmitted(store, {
      async getTransactionReceipt() {
        return { status: false, blockNumber: 10n };
      },
      async getBlockByTag() {
        return { number: 5n };
      },
    }, []);
    assert.equal(tentative[0].status, "pending");
    assert.equal((await store.getRelay("rc-rev")).status, "submitted");
    // At/below the finalized head -> terminal.
    const terminal = await reconcileSubmitted(store, {
      async getTransactionReceipt() {
        return { status: false, blockNumber: 4n };
      },
      async getBlockByTag() {
        return { number: 5n };
      },
    }, []);
    assert.equal(terminal[0].status, "reverted");
    assert.equal((await store.getRelay("rc-rev")).status, "reverted");
  });
});

describe("sponsorship budget + abuse wiring", () => {
  it("prevents the send when the transaction cap is exhausted", async () => {
    const store = new MemoryStore();
    await enqueue(store, "b1");
    const budget = new SponsorshipBudget({ txCap: 0, weiCap: 10n ** 18n, now: () => 1_000 });
    const transport = fakeTransport();
    const { processor } = makeProcessor(store, { sponsor: SPONSOR, gasClient: gasClient(), transport, budget });
    const result = await processor.process("b1");
    assert.equal(result.status, "unsigned");
    assert.equal(result.reason, "budget-exhausted");
    assert.equal(transport.nonces.length, 0);
  });

  it("prevents the send when the estimated wei exceeds the wei cap", async () => {
    const store = new MemoryStore();
    await enqueue(store, "b2");
    const budget = new SponsorshipBudget({ txCap: 100, weiCap: 100n, now: () => 1_000 });
    const transport = fakeTransport();
    const { processor } = makeProcessor(store, {
      sponsor: SPONSOR,
      gasClient: gasClient({ estimate: 100_000n, price: 10n }),
      transport,
      budget,
    });
    const result = await processor.process("b2");
    assert.equal(result.status, "unsigned");
    assert.equal(result.reason, "budget-exhausted");
    assert.equal(transport.nonces.length, 0);
  });

  it("skips a rate-limited key and leaves the job queued", async () => {
    const store = new MemoryStore();
    await enqueue(store, "a1");
    await enqueue(store, "a2");
    const abuse = new AbuseControls({ relayRatePerMin: 1, now: () => 100 });
    const { processor } = makeProcessor(store, { abuse, now: () => 100 });
    assert.equal((await processor.process("a1")).status, "unsigned");
    const denied = await processor.process("a2");
    assert.equal(denied.status, "skipped");
    assert.match(denied.reason, /abuse\.rate-limited/);
    assert.equal((await store.getRelay("a2")).status, "queued");
  });

  it("falls back to unsigned calldata with no sponsor", async () => {
    const store = new MemoryStore();
    await enqueue(store, "nos");
    const { processor } = makeProcessor(store);
    const result = await processor.process("nos");
    assert.equal(result.status, "unsigned");
    const job = await store.getRelay("nos");
    assert.match(job.result.data, /^0x[0-9a-f]+$/);
  });
});
