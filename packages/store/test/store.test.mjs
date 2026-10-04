import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../dist/store.js";
import { redact } from "../dist/audit.js";

describe("memory store", () => {
  it("dedupes events and relay keys", async () => {
    const store = new MemoryStore();
    const event = {
      txHash: "0xabc",
      logIndex: 0,
      blockNumber: 1n,
      blockHash: "0xb",
      contractAddress: "0xc",
      dealId: "0xd",
      eventName: "DealFunded",
      args: {},
      orphaned: false,
    };
    assert.equal(await store.putEvents([event, event]), 1);
    const first = await store.enqueueRelay({
      idempotencyKey: "k",
      queue: "relay",
      action: "openDispute",
      params: {},
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    assert.equal(first.inserted, true);
    const second = await store.enqueueRelay({
      idempotencyKey: "k",
      queue: "relay",
      action: "openDispute",
      params: {},
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    assert.equal(second.inserted, false);
    assert.ok(await store.claimRelay("k"));
    assert.equal(await store.claimRelay("k"), null);
  });

  it("redacts secrets from audit details", () => {
    assert.deepEqual(redact({ invitationToken: "secret", a: 1 }), { invitationToken: "[REDACTED]", a: 1 });
  });
});
