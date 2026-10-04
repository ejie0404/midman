// Postgres integration tests for @midman/store.
//
// Gated on DATABASE_URL: when it is unset the whole suite is skipped cleanly so
// `pnpm test` stays green without a database. When set, the suite migrates a
// throwaway schema, round-trips every Store capability, and verifies the
// Phase-3 durability primitives (CAS, transactions, leases, sequences, and
// deal discovery from chain events).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ConflictError,
  PgStore,
  createPgExecutor,
  defaultMigrations,
  listKnownDealIds,
  runMigrations,
} from "../dist/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;
const PREFIX = `itest_${Date.now()}_`;

const EV = (dealId, i, name = "DealFunded") => ({
  txHash: `${PREFIX}tx_${dealId}_${i}`,
  logIndex: i,
  blockNumber: BigInt(100 + i),
  blockHash: `${PREFIX}block_${i}`,
  contractAddress: `${PREFIX}hub`,
  dealId,
  eventName: name,
  args: { amount: String(1_000_000 + i) },
  orphaned: false,
});

describe("PgStore integration", { skip: !enabled }, () => {
  let executor;
  let store;

  before(async () => {
    executor = createPgExecutor(DATABASE_URL);
    await runMigrations(executor, defaultMigrations());
    store = new PgStore(executor);
  });

  after(async () => {
    if (!executor) return;
    const like = `${PREFIX}%`;
    const statements = [
      "DELETE FROM registry_kv WHERE deal_id LIKE $1",
      "DELETE FROM chain_events WHERE deal_id LIKE $1",
      "DELETE FROM drafts WHERE id LIKE $1 OR deal_id LIKE $1",
      "DELETE FROM relay_outbox WHERE idempotency_key LIKE $1",
      "DELETE FROM sponsor_ledger WHERE deal_id LIKE $1 OR tx_hash LIKE $1",
      "DELETE FROM auth_kv WHERE key LIKE $1",
      "DELETE FROM invitations WHERE token_hash LIKE $1",
      "DELETE FROM deals_meta WHERE deal_id LIKE $1",
      "DELETE FROM seq WHERE name LIKE $1",
    ];
    for (const sql of statements) {
      try {
        await executor.query(sql, [like]);
      } catch {
        // Best-effort cleanup; a missing column should not fail the suite.
      }
    }
    await store.close();
  });

  it("migrates on demand and is idempotent", async () => {
    const again = await runMigrations(executor, defaultMigrations());
    assert.deepEqual(again, []);
  });

  it("round-trips drafts, CAS and signature merges", async () => {
    const id = `${PREFIX}draft_0`;
    const dealId = `${PREFIX}deal_0`;
    await store.createDraft({
      id,
      dealId,
      creatorWallet: `${PREFIX}creator`,
      counterpartyHint: null,
      counterpartyAddress: null,
      terms: { buyer: `${PREFIX}buyer`, principalUnits: "1000" },
      signatures: {},
      admission: null,
      revocationNote: null,
      status: "draft",
    });

    const fetched = await store.getDraft(id);
    assert.equal(fetched.version, 0);
    assert.equal(fetched.dealId, dealId);
    assert.deepEqual(fetched.terms, { buyer: `${PREFIX}buyer`, principalUnits: "1000" });

    const byDeal = await store.getDraftByDeal(dealId.toUpperCase());
    assert.equal(byDeal.id, id);

    await store.updateDraft(id, { status: "accepted" });
    assert.equal((await store.getDraft(id)).version, 1);

    const merged = await store.updateDraftCas(id, 1, { status: "signed" });
    assert.equal(merged, 2);
    await assert.rejects(() => store.updateDraftCas(id, 1, { status: "invited" }), ConflictError);

    await store.mergeDraftSignature(id, "buyer", "0xbbbb");
    await store.mergeDraftSignature(id, "seller", "0xaaaa");
    const signed = await store.getDraft(id);
    assert.deepEqual(signed.signatures, { buyer: "0xbbbb", seller: "0xaaaa" });
    assert.equal(signed.status, "signed");
    assert.equal(signed.version, 4);
  });

  it("round-trips chain events, tips and deal discovery", async () => {
    const dealId = `${PREFIX}events_only`;
    await store.putEvents([EV(dealId, 0, "DealFunded")]);
    const events = await store.getEventsByDeal(dealId);
    assert.equal(events.length, 1);
    assert.equal(events[0].blockNumber, 100n);

    assert.ok((await store.listChainEventDealIds()).includes(dealId));
    const known = await listKnownDealIds(store);
    assert.ok(known.includes(dealId), "events-only deal must be discoverable");
    assert.ok((await store.listDealIds()).includes(dealId));

    assert.equal(await store.blockHashAt(`${PREFIX}hub`, 100n), `${PREFIX}block_0`);
    await store.setTip(`${PREFIX}hub`, { blockNumber: 123n, blockHash: `${PREFIX}tip` });
    const tip = await store.getTip(`${PREFIX}hub`.toUpperCase());
    assert.equal(tip.blockNumber, 123n);
    assert.equal(tip.blockHash, `${PREFIX}tip`);
    assert.equal(await store.markOrphanedFrom(`${PREFIX}hub`, 100n), 1);
    assert.equal(await store.getEventsByDeal(dealId).then((e) => e.length), 0);
    await store.clearContractData(`${PREFIX}hub`);
    assert.equal(await store.getTip(`${PREFIX}hub`), null);
  });

  it("round-trips relay outbox and leases", async () => {
    const key = `${PREFIX}relay_0`;
    await store.enqueueRelay({
      idempotencyKey: key,
      queue: "relay",
      action: "openDispute",
      params: { dealId: `${PREFIX}deal` },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    const dup = await store.enqueueRelay({
      idempotencyKey: key,
      queue: "relay",
      action: "openDispute",
      params: {},
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    assert.equal(dup.inserted, false);

    const queued = await store.listQueuedRelay("relay", 10);
    assert.ok(queued.some((job) => job.idempotencyKey === key));

    const claimed = await store.claimRelayLease(key, "worker-a", 60);
    assert.equal(claimed.status, "processing");
    assert.equal(claimed.leaseOwner, "worker-a");
    assert.equal(claimed.attempts, 1);
    assert.equal(await store.claimRelayLease(key, "worker-b", 60), null);
    assert.equal(await store.renewRelayLease(key, "worker-a", 120), true);
    assert.equal(await store.renewRelayLease(key, "worker-b", 120), false);

    await store.finishRelay(key, "sent", `${PREFIX}txhash`, { ok: true });
    const done = await store.getRelay(key);
    assert.equal(done.status, "sent");
    assert.equal(done.txHash, `${PREFIX}txhash`);

    // Expiry + reap: a zero-TTL lease is immediately stale.
    const expiring = `${PREFIX}relay_expire`;
    await store.enqueueRelay({
      idempotencyKey: expiring,
      queue: "relay",
      action: "escalate",
      params: {},
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    await store.claimRelayLease(expiring, "worker-a", 0);
    await store.reapExpiredRelayLeases();
    assert.equal((await store.getRelay(expiring)).status, "queued");
  });

  it("round-trips sponsor ledger and deal meta", async () => {
    await store.recordSponsor(`${PREFIX}sponsor_tx`, `${PREFIX}deal`, "openDispute");
    assert.equal(await store.countSponsorsSince("2000-01-01T00:00:00.000Z"), 1);
    await store.recordDealMeta(`${PREFIX}meta_deal`, "draft");
    assert.ok((await store.listDealIds()).includes(`${PREFIX}meta_deal`));
  });

  it("reserves sponsorship transactionally within a limit", async () => {
    const since = "2000-01-01T00:00:00.000Z";
    const baseline = await store.countSponsorsSince(since);
    const limit = baseline + 1;
    const first = await store.reserveSponsorship(`${PREFIX}reserve_1`, `${PREFIX}deal`, "fund", limit, since);
    assert.equal(first.granted, true);
    const second = await store.reserveSponsorship(`${PREFIX}reserve_2`, `${PREFIX}deal`, "fund", limit, since);
    assert.equal(second.granted, false);
  });

  it("round-trips registry kv including compare-and-set", async () => {
    const dealId = `${PREFIX}kv_deal`;
    const ns = "itest.ns";
    await store.kvPut(ns, dealId, "k1", { n: 1 });
    assert.deepEqual(await store.kvGet(ns, dealId, "k1"), { n: 1 });

    const versioned = await store.kvGetWithVersion(ns, dealId, "k1");
    assert.equal(versioned.version, 1);

    const next = await store.kvPutCas(ns, dealId, "k1", { n: 2 }, versioned.version);
    assert.equal(next, 2);
    await assert.rejects(() => store.kvPutCas(ns, dealId, "k1", { n: 3 }, versioned.version), ConflictError);

    await store.kvPut(ns, dealId, "k2", { n: 9 });
    const listed = await store.kvList(ns, dealId);
    assert.deepEqual(listed.map((entry) => entry.key), ["k1", "k2"]);
    assert.deepEqual(await store.kvDeals(ns), [dealId]);

    await store.kvDel(ns, dealId, "k2");
    assert.equal(await store.kvGet(ns, dealId, "k2"), null);
  });

  it("issues collision-safe sequence ids", async () => {
    const name = `${PREFIX}seq`;
    const first = await store.nextSeq(name);
    const second = await store.nextSeq(name);
    assert.equal(first, 1);
    assert.equal(second, 2);
  });

  it("round-trips auth state with expiry", async () => {
    const scope = `${PREFIX}auth`;
    await store.authPut(scope, "challenge-1", { wallet: `${PREFIX}w` });
    assert.deepEqual(await store.authGet(scope, "challenge-1"), { wallet: `${PREFIX}w` });
    await store.authPut(scope, "expired", { x: 1 }, "2000-01-01T00:00:00.000Z");
    assert.equal(await store.authGet(scope, "expired"), null);
    assert.deepEqual((await store.authList(scope)).map((entry) => entry.key), ["challenge-1"]);
    await store.authDelete(scope, "challenge-1");
    assert.equal(await store.authGet(scope, "challenge-1"), null);
  });

  it("redeems invitations and assigns the counterparty atomically", async () => {
    const draftId = `${PREFIX}invite_draft`;
    const tokenHash = `${PREFIX}token_hash`;
    await store.createDraft({
      id: draftId,
      dealId: `${PREFIX}invite_deal`,
      creatorWallet: `${PREFIX}creator`,
      counterpartyHint: null,
      counterpartyAddress: null,
      terms: {},
      signatures: {},
      admission: null,
      revocationNote: null,
      status: "invited",
    });
    await store.saveInvitation({
      tokenHash,
      dealId: draftId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revoked: false,
    });
    const saved = await store.getInvitation(tokenHash);
    assert.equal(saved.revoked, false);

    const result = await store.redeemInvitation({
      draftId,
      tokenHash,
      counterpartyAddress: `${PREFIX}counterparty`,
    });
    assert.equal(result.redeemed, true);
    assert.equal((await store.getDraft(draftId)).counterpartyAddress, `${PREFIX}counterparty`);
    const second = await store.redeemInvitation({ draftId, tokenHash, counterpartyAddress: `${PREFIX}other` });
    assert.equal(second.redeemed, false);

    const revokeHash = `${PREFIX}revoke_hash`;
    await store.saveInvitation({
      tokenHash: revokeHash,
      dealId: draftId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revoked: false,
    });
    await store.revokeInvitation(revokeHash);
    assert.equal((await store.getInvitation(revokeHash)).revoked, true);
  });

  it("rolls a transaction back on error and commits on success", async () => {
    const dealId = `${PREFIX}txn_deal`;
    const ns = "itest.txn";
    await assert.rejects(
      () =>
        store.withTransaction(async (tx) => {
          await tx.kvPut(ns, dealId, "rolled", { n: 1 });
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(await store.kvGet(ns, dealId, "rolled"), null);

    await store.withTransaction(async (tx) => {
      await tx.kvPut(ns, dealId, "committed", { n: 2 });
    });
    assert.deepEqual(await store.kvGet(ns, dealId, "committed"), { n: 2 });
  });
});
