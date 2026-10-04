import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  apiBase,
  rpcUrls,
  expectedChainId,
  requestTimeoutMs,
  CONFIG,
  describeConnectivity,
  ensureChainId,
  switchChainSafely,
  ChainMismatchError,
  UserRejectedError,
  connectWallet,
  disconnectWallet,
  getWalletState,
  subscribe,
  unsubscribe,
  resetWalletStore,
  createPoller,
  withRequestId,
  newRequestId,
} from "../lib/connectivity.ts";

const ENV_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_RPC_URLS",
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_REQUEST_TIMEOUT_MS",
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function clearConnectivityEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stubChainClient({ chainId = 8453, onRequest } = {}) {
  const calls = [];
  return {
    calls,
    async getChainId() {
      return chainId;
    },
    async request(args) {
      calls.push(args);
      if (onRequest) return onRequest(args, calls);
      return undefined;
    },
  };
}

function stubProvider({ accounts = ["0x1111111111111111111111111111111111111111"], chainId = "0x2105" } = {}) {
  let accts = [...accounts];
  let chain = chainId;
  const handlers = new Map();
  const p = {
    requested: [],
    setAccounts(next) {
      accts = [...next];
    },
    setChainId(next) {
      chain = next;
    },
    async request(args) {
      p.requested.push(args.method);
      if (args.method === "eth_requestAccounts") return [...accts];
      if (args.method === "eth_chainId") return chain;
      throw new Error(`unexpected method ${args.method}`);
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    removeListener(event, handler) {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    emit(event, ...args) {
      for (const h of [...(handlers.get(event) ?? [])]) h(...args);
    },
    listenerCount(event) {
      return (handlers.get(event) ?? []).length;
    },
  };
  return p;
}

describe("connectivity config", () => {
  let snap;
  beforeEach(() => {
    snap = snapshotEnv();
    clearConnectivityEnv();
  });
  afterEach(() => restoreEnv(snap));

  it("defaults to local API, Base mainnet RPC, chain 8453, 15s timeout", () => {
    assert.equal(apiBase(), "http://localhost:3001");
    assert.deepEqual(rpcUrls(), ["https://mainnet.base.org"]);
    assert.equal(expectedChainId(), 8453);
    assert.equal(requestTimeoutMs(), 15000);
  });

  it("strips trailing slashes from the API base", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com///";
    assert.equal(apiBase(), "https://api.example.com");
  });

  it("rejects non-http(s) API bases", () => {
    for (const bad of ["ftp://host/api", "javascript:alert(1)", "not-a-url", "ws://host"]) {
      process.env.NEXT_PUBLIC_API_URL = bad;
      assert.throws(() => apiBase(), Error);
    }
  });

  it("parses a comma-separated RPC list, trimming and dropping empties", () => {
    process.env.NEXT_PUBLIC_RPC_URLS = " https://a.example , ,https://b.example/ ";
    assert.deepEqual(rpcUrls(), ["https://a.example", "https://b.example"]);
  });

  it("rejects an empty or invalid RPC list", () => {
    process.env.NEXT_PUBLIC_RPC_URLS = " , , ";
    assert.throws(() => rpcUrls(), Error);
    process.env.NEXT_PUBLIC_RPC_URLS = "https://ok.example, gopher://bad.example";
    assert.throws(() => rpcUrls(), Error);
  });

  it("parses the expected chain id and rejects garbage", () => {
    process.env.NEXT_PUBLIC_CHAIN_ID = "84532";
    assert.equal(expectedChainId(), 84532);
    for (const bad of ["abc", "0", "-1", "8.5", "0x2105"]) {
      process.env.NEXT_PUBLIC_CHAIN_ID = bad;
      assert.throws(() => expectedChainId(), Error, bad);
    }
  });

  it("parses the request timeout and rejects garbage", () => {
    process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS = "3000";
    assert.equal(requestTimeoutMs(), 3000);
    for (const bad of ["fast", "0", "-5"]) {
      process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS = bad;
      assert.throws(() => requestTimeoutMs(), Error, bad);
    }
  });

  it("exposes a frozen CONFIG and matching diagnostics snapshot", () => {
    assert.equal(Object.isFrozen(CONFIG), true);
    assert.deepEqual(describeConnectivity(), {
      apiBase: apiBase(),
      rpcUrls: rpcUrls(),
      expectedChainId: expectedChainId(),
      requestTimeoutMs: requestTimeoutMs(),
    });
    assert.equal(Object.isFrozen(describeConnectivity()), true);
  });
});

describe("chain enforcement", () => {
  it("ensureChainId resolves when the wallet is on the expected chain", async () => {
    await ensureChainId(stubChainClient({ chainId: 8453 }), 8453);
  });

  it("ensureChainId throws ChainMismatchError{expected, actual} on mismatch", async () => {
    const err = await ensureChainId(stubChainClient({ chainId: 1 }), 8453).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof ChainMismatchError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ChainMismatchError");
    assert.equal(err.expected, 8453);
    assert.equal(err.actual, 1);
  });

  it("switchChainSafely requests wallet_switchEthereumChain with 0x2105", async () => {
    const client = stubChainClient();
    await switchChainSafely(client, 8453);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0], {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });
  });

  it("switchChainSafely falls back to wallet_addEthereumChain on 4902 with Base params", async () => {
    const client = stubChainClient({
      onRequest(args) {
        if (args.method === "wallet_switchEthereumChain") throw Object.assign(new Error("unknown chain"), { code: 4902 });
        return null;
      },
    });
    await switchChainSafely(client, 8453);
    assert.equal(client.calls.length, 2);
    const add = client.calls[1];
    assert.equal(add.method, "wallet_addEthereumChain");
    const params = add.params[0];
    assert.equal(params.chainId, "0x2105");
    assert.equal(params.chainName, "Base");
    assert.deepEqual(params.nativeCurrency, { name: "Ether", symbol: "ETH", decimals: 18 });
    assert.ok(params.rpcUrls.includes("https://mainnet.base.org"));
    assert.deepEqual(params.blockExplorerUrls, ["https://basescan.org"]);
  });

  it("switchChainSafely maps 4001 on switch to UserRejectedError", async () => {
    const client = stubChainClient({
      onRequest() {
        throw Object.assign(new Error("rejected"), { code: 4001 });
      },
    });
    await assert.rejects(() => switchChainSafely(client, 8453), UserRejectedError);
  });

  it("switchChainSafely maps 4001 on add to UserRejectedError", async () => {
    const client = stubChainClient({
      onRequest(args) {
        if (args.method === "wallet_switchEthereumChain") throw Object.assign(new Error("unknown"), { code: 4902 });
        throw Object.assign(new Error("rejected"), { code: 4001 });
      },
    });
    await assert.rejects(() => switchChainSafely(client, 8453), UserRejectedError);
  });

  it("switchChainSafely rethrows non-4902 errors unchanged", async () => {
    const boom = Object.assign(new Error("boom"), { code: -32603 });
    const client = stubChainClient({
      onRequest() {
        throw boom;
      },
    });
    await assert.rejects(() => switchChainSafely(client, 8453), (e) => e === boom);
    assert.equal(client.calls.length, 1);
  });
});

describe("wallet lifecycle", () => {
  beforeEach(() => resetWalletStore());
  afterEach(() => resetWalletStore());

  it("connectWallet snapshots address + chain id", async () => {
    const provider = stubProvider();
    const state = await connectWallet(provider);
    assert.equal(state.address, "0x1111111111111111111111111111111111111111");
    assert.equal(state.chainId, 8453);
    assert.deepEqual(getWalletState(), state);
    assert.deepEqual(provider.requested, ["eth_requestAccounts", "eth_chainId"]);
  });

  it("subscribe notifies listeners; returned fn and unsubscribe() both detach", async () => {
    const provider = stubProvider();
    await connectWallet(provider);
    const seen = [];
    const unsub = subscribe((s) => seen.push(s.address));
    provider.emit("accountsChanged", ["0x2222222222222222222222222222222222222222"]);
    assert.deepEqual(seen, ["0x2222222222222222222222222222222222222222"]);
    unsub();
    provider.emit("accountsChanged", ["0x3333333333333333333333333333333333333333"]);
    assert.deepEqual(seen, ["0x2222222222222222222222222222222222222222"]);

    const seen2 = [];
    const listener = (s) => seen2.push(s.address);
    subscribe(listener);
    provider.emit("accountsChanged", ["0x4444444444444444444444444444444444444444"]);
    unsubscribe(listener);
    provider.emit("accountsChanged", ["0x5555555555555555555555555555555555555555"]);
    assert.deepEqual(seen2, ["0x4444444444444444444444444444444444444444"]);
  });

  it("accountsChanged updates the address (empty list clears it)", async () => {
    const provider = stubProvider();
    await connectWallet(provider);
    provider.emit("accountsChanged", ["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]);
    assert.equal(getWalletState().address, "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    provider.emit("accountsChanged", []);
    assert.equal(getWalletState().address, null);
  });

  it("chainChanged parses hex and disconnect clears the store", async () => {
    const provider = stubProvider();
    await connectWallet(provider);
    provider.emit("chainChanged", "0x1");
    assert.equal(getWalletState().chainId, 1);
    provider.emit("chainChanged", 8453);
    assert.equal(getWalletState().chainId, 8453);
    provider.emit("disconnect");
    assert.deepEqual(getWalletState(), { address: null, chainId: null });
  });

  it("disconnectWallet clears state and detaches provider listeners", async () => {
    const provider = stubProvider();
    await connectWallet(provider);
    assert.equal(provider.listenerCount("accountsChanged"), 1);
    disconnectWallet();
    assert.deepEqual(getWalletState(), { address: null, chainId: null });
    assert.equal(provider.listenerCount("accountsChanged"), 0);
    provider.emit("accountsChanged", ["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]);
    assert.equal(getWalletState().address, null);
  });

  it("connectWallet rejects when no provider is available", async () => {
    await assert.rejects(() => connectWallet(), /No browser wallet/);
  });
});

describe("poller", () => {
  it("runs at the interval and stops on demand", async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
    }, { intervalMs: 15 });
    assert.equal(poller.isRunning(), false);
    poller.start();
    assert.equal(poller.isRunning(), true);
    // Wait for the condition with a generous deadline instead of a fixed
    // sleep: timer delivery is not guaranteed within a tight window under load.
    const deadline = Date.now() + 3_000;
    while (calls < 3 && Date.now() < deadline) await sleep(10);
    poller.stop();
    assert.equal(poller.isRunning(), false);
    assert.ok(calls >= 3, `expected >=3 calls, got ${calls}`);
    const frozen = calls;
    await sleep(60);
    assert.equal(calls, frozen);
  });

  it("pollNow triggers an immediate run without start()", async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
    }, { intervalMs: 60_000 });
    poller.pollNow();
    await sleep(40);
    assert.equal(calls, 1);
    poller.stop();
    await sleep(40);
    assert.equal(calls, 1);
  });

  it("never overlaps invocations (slow fn, fast interval)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(80);
      concurrent -= 1;
    }, { intervalMs: 10 });
    poller.start();
    await sleep(250);
    poller.stop();
    assert.equal(maxConcurrent, 1);
    assert.ok(calls >= 2, `expected >=2 calls, got ${calls}`);
  });

  it("backs off after failures instead of retrying at the interval", async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      throw new Error("flaky");
    }, { intervalMs: 10 });
    poller.start();
    await sleep(350);
    poller.stop();
    // Without backoff (base 1000ms) there would be ~35 calls; backoff keeps it at 1.
    assert.ok(calls <= 2, `expected backoff to suppress retries, got ${calls} calls`);
    assert.ok(calls >= 1);
  });

  it("stop() aborts the in-flight request and timeoutMs ends the poller", async () => {
    let observed = null;
    let calls = 0;
    const gate = createPoller(async (signal) => {
      calls += 1;
      observed = signal;
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }, { intervalMs: 10 });
    gate.start();
    await sleep(30);
    gate.stop();
    assert.ok(observed !== null && observed.aborted, "expected the in-flight signal to be aborted");
    assert.equal(gate.isRunning(), false);

    let ticks = 0;
    const timed = createPoller(async () => {
      ticks += 1;
    }, { intervalMs: 10, timeoutMs: 60 });
    timed.start();
    await sleep(150);
    assert.equal(timed.isRunning(), false);
    const frozen = ticks;
    await sleep(60);
    assert.equal(ticks, frozen);
    assert.ok(frozen >= 1);
  });
});

describe("request tracing", () => {
  it("withRequestId adds an x-request-id UUID", () => {
    const headers = withRequestId({ "content-type": "application/json" });
    assert.equal(headers["content-type"], "application/json");
    assert.match(
      headers["x-request-id"],
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    assert.match(newRequestId(), /^[0-9a-f-]{36}$/i);
  });

  it("withRequestId keeps a caller-provided id (any casing) and is unique per call", () => {
    const kept = withRequestId({ "X-Request-Id": "keep-me" });
    assert.equal(kept["X-Request-Id"], "keep-me");
    assert.equal(withRequestId()["x-request-id"] === withRequestId()["x-request-id"], false);
  });

  it("withRequestId accepts Headers and tuple-array inputs", () => {
    const fromHeaders = withRequestId(new Headers({ "content-type": "application/json" }));
    assert.equal(fromHeaders["content-type"], "application/json");
    assert.ok(typeof fromHeaders["x-request-id"] === "string");
    const fromTuples = withRequestId([["content-type", "application/json"]]);
    assert.equal(fromTuples["content-type"], "application/json");
    assert.ok(typeof fromTuples["x-request-id"] === "string");
  });
});
