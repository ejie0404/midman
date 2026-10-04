import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultMigrations, runMigrations } from "../dist/migrate.js";

/** Stateful fake that simulates the schema_migrations bookkeeping table. */
class MigrateFake {
  constructor({ failOn = null } = {}) {
    this.applied = new Set();
    this.calls = [];
    this.inTransaction = false;
    this.commits = 0;
    this.rollbacks = 0;
    this.failOn = failOn;
    this.failConsumed = false;
  }

  async query(text, params) {
    this.calls.push({ text, params });
    const normalized = text.trim().toUpperCase();
    if (normalized.startsWith("SELECT ID FROM SCHEMA_MIGRATIONS")) {
      return { rows: [...this.applied].map((id) => ({ id })) };
    }
    if (normalized.startsWith("INSERT INTO SCHEMA_MIGRATIONS")) {
      this.applied.add(params[0]);
      return { rows: [] };
    }
    if (normalized === "BEGIN") {
      this.inTransaction = true;
      return { rows: [] };
    }
    if (normalized === "COMMIT") {
      this.inTransaction = false;
      this.commits += 1;
      return { rows: [] };
    }
    if (normalized === "ROLLBACK") {
      this.inTransaction = false;
      this.rollbacks += 1;
      return { rows: [] };
    }
    if (this.failOn !== null && !this.failConsumed && text.includes(this.failOn)) {
      this.failConsumed = true;
      throw new Error(`simulated migration failure in ${this.failOn}`);
    }
    return { rows: [] };
  }
}

const MIGRATIONS = [
  { id: "0002_phase6", sql: "-- 0002" },
  { id: "0001_init", sql: "-- 0001" },
  { id: "0004_migrations", sql: "-- 0004" },
  { id: "0003_evidence", sql: "-- 0003" },
];

describe("defaultMigrations", () => {
  it("lists the ordered migration set including evidence", () => {
    const ids = defaultMigrations().map((migration) => migration.id);
    assert.deepEqual(ids, [
      "0001_init",
      "0002_phase6",
      "0003_evidence",
      "0004_migrations",
      "0005_durability",
    ]);
  });

  it("embeds non-empty SQL for every migration", () => {
    for (const migration of defaultMigrations()) {
      assert.ok(migration.sql.length > 0, `${migration.id} has empty SQL`);
    }
  });

  it("creates the registry_kv durable registry table", () => {
    const evidence = defaultMigrations().find((migration) => migration.id === "0003_evidence");
    assert.match(evidence.sql, /CREATE TABLE IF NOT EXISTS registry_kv/);
    assert.match(evidence.sql, /PRIMARY KEY \(deal_id, ns, key\)/);
  });
});

describe("runMigrations", () => {
  it("applies unapplied migrations in id order inside transactions", async () => {
    const db = new MigrateFake();
    const applied = await runMigrations(db, MIGRATIONS);
    assert.deepEqual(applied, ["0001_init", "0002_phase6", "0003_evidence", "0004_migrations"]);
    assert.equal(db.commits, 4);
    assert.equal(db.rollbacks, 0);
    assert.ok(db.calls.some((call) => call.text.trim() === "BEGIN"));

    const beginIndexes = db.calls
      .map((call, index) => (call.text.trim() === "BEGIN" ? index : -1))
      .filter((index) => index >= 0);
    assert.equal(beginIndexes.length, 4);
    // Each recorded id is inserted after its migration SQL and before COMMIT.
    for (const id of applied) {
      const insertIndex = db.calls.findIndex((call) => call.params?.[0] === id);
      const commitIndex = db.calls.findIndex((call, index) => index > insertIndex && call.text.trim() === "COMMIT");
      assert.ok(insertIndex > 0 && commitIndex > insertIndex, `bad transaction ordering for ${id}`);
    }
  });

  it("bootstraps schema_migrations before reading it", async () => {
    const db = new MigrateFake();
    await runMigrations(db, []);
    assert.match(db.calls[0].text, /CREATE TABLE IF NOT EXISTS schema_migrations/);
    assert.match(db.calls[1].text, /SELECT id FROM schema_migrations/);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const db = new MigrateFake();
    const first = await runMigrations(db, MIGRATIONS);
    assert.ok(first.length > 0);
    db.calls.length = 0;
    const second = await runMigrations(db, MIGRATIONS);
    assert.deepEqual(second, []);
    assert.ok(!db.calls.some((call) => call.text.trim() === "BEGIN"));
  });

  it("skips migrations already recorded in the bookkeeping table", async () => {
    const db = new MigrateFake();
    db.applied.add("0001_init");
    db.applied.add("0003_evidence");
    const applied = await runMigrations(db, MIGRATIONS);
    assert.deepEqual(applied, ["0002_phase6", "0004_migrations"]);
  });

  it("rolls back a failing migration and never records it", async () => {
    const db = new MigrateFake({ failOn: "-- 0002" });
    await assert.rejects(() => runMigrations(db, MIGRATIONS), /simulated migration failure/);
    assert.equal(db.rollbacks, 1);
    assert.ok(!db.applied.has("0002_phase6"));
    assert.ok(!db.applied.has("0003_evidence"));
    assert.ok(db.applied.has("0001_init"));
    assert.ok(!db.inTransaction);
  });

  it("accepts the embedded default set", async () => {
    const db = new MigrateFake();
    const applied = await runMigrations(db);
    assert.deepEqual(applied, [
      "0001_init",
      "0002_phase6",
      "0003_evidence",
      "0004_migrations",
      "0005_durability",
    ]);
  });

  it("optional integration: real Postgres when DATABASE_URL is set", { skip: !process.env.DATABASE_URL }, async () => {
    const { createPgExecutor } = await import("../dist/sql.js");
    const executor = createPgExecutor(process.env.DATABASE_URL);
    const first = await runMigrations(executor);
    const second = await runMigrations(executor);
    assert.ok(Array.isArray(first));
    assert.deepEqual(second, []);
  });
});
