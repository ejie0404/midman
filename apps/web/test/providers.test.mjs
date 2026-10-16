import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetProvidersForTests,
  canResolveProvider,
  clearWalletSelection,
  getActiveProvider,
  listWalletOptions,
  selectWallet,
  startDiscovery,
} from "../lib/providers.ts";

function fakeWindow() {
  const target = new EventTarget();
  const store = new Map();
  globalThis.window = target;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return target;
}

function announce(target, rdns, name) {
  const provider = { request: async () => [], tag: rdns };
  target.addEventListener("eip6963:requestProvider", () => {
    const event = new Event("eip6963:announceProvider");
    event.detail = { info: { uuid: rdns, name, icon: "data:image/svg+xml,<svg/>", rdns }, provider };
    target.dispatchEvent(event);
  });
  return provider;
}

describe("wallet providers", () => {
  beforeEach(() => {
    __resetProvidersForTests();
  });

  it("lists every EIP-6963 wallet plus Coinbase, and selects the chosen one", async () => {
    const target = fakeWindow();
    announce(target, "io.metamask", "MetaMask");
    const rabby = announce(target, "io.rabby", "Rabby");
    startDiscovery();
    const ids = listWalletOptions().map((o) => o.id);
    assert.deepEqual(ids, ["io.metamask", "io.rabby", "coinbase"]);
    assert.equal(canResolveProvider(), false, "nothing picked and no window.ethereum");
    await selectWallet("io.rabby");
    assert.equal(getActiveProvider(), rabby);
  });

  it("restores a remembered wallet after reload and forgets it on sign-out", async () => {
    const target = fakeWindow();
    const metamask = announce(target, "io.metamask", "MetaMask");
    startDiscovery();
    await selectWallet("io.metamask");
    // Simulate a reload: module state cleared, storage kept.
    __resetProvidersForTests();
    startDiscovery();
    assert.equal(getActiveProvider(), metamask);
    await clearWalletSelection();
    assert.equal(canResolveProvider(), false);
  });

  it("offers WalletConnect only when a project id is configured", () => {
    fakeWindow();
    startDiscovery();
    assert.ok(!listWalletOptions().some((o) => o.id === "walletconnect"));
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project";
    try {
      assert.ok(listWalletOptions().some((o) => o.id === "walletconnect"));
    } finally {
      delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    }
  });
});
