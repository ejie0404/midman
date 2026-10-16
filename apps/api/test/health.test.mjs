// Liveness vs readiness probes: /health + /health/live always answer when the
// process runs; /health/ready is 200 only when every critical dependency is
// configured, otherwise 503 with the missing list.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildServer, checkReadiness } from "../dist/server.js";

const MANAGED = [
  "BASE_CHAIN_ID",
  "BASE_RPC_URLS",
  "HUB_ADDRESS",
  "CLAMAV_HOST",
  "EVIDENCE_ALLOW_DEFERRED",
  "NODE_ENV",
  "DATABASE_URL",
];
const SAVED = Object.fromEntries(MANAGED.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of MANAGED) delete process.env[key];
});

afterEach(() => {
  for (const key of MANAGED) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

function configuredEnv() {
  process.env["BASE_CHAIN_ID"] = "31337";
  process.env["BASE_RPC_URLS"] = "http://localhost:8545";
  process.env["HUB_ADDRESS"] = "0x00000000000000000000000000000000000000aa";
  process.env["EVIDENCE_ALLOW_DEFERRED"] = "1";
}

describe("health probes", () => {
  it("/health and /health/live answer 200 while degraded", async () => {
    const app = buildServer();
    await app.ready();
    for (const url of ["/health", "/health/live"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().ok, true);
    }
    await app.close();
  });

  it("/health/ready is 200 when chain, hub and scanner are configured", async () => {
    configuredEnv();
    const app = buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ready, true);
    assert.deepEqual(res.json().missing, []);
    await app.close();
  });

  it("/health/ready is 503 with the missing list when degraded", async () => {
    const app = buildServer();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().ready, false);
    for (const missing of ["chainId", "rpc", "hub", "scanner"]) {
      assert.ok(res.json().missing.includes(missing), `missing should list ${missing}`);
    }
    await app.close();
  });

  it("checkReadiness requires a database in production only", () => {
    process.env["NODE_ENV"] = "production";
    const withoutDb = checkReadiness(
      { hub: "0x00000000000000000000000000000000000000aa" },
      { databaseUrl: null, chainId: 8453, rpcUrls: ["https://mainnet.base.org"] },
    );
    assert.equal(withoutDb.ready, false);
    assert.ok(withoutDb.missing.includes("database"));
    const withDb = checkReadiness(
      { hub: "0x00000000000000000000000000000000000000aa" },
      { databaseUrl: "postgres://localhost/db", chainId: 8453, rpcUrls: ["https://mainnet.base.org"] },
    );
    assert.ok(!withDb.missing.includes("database"));
  });

  it("checkReadiness requires a scanner or the explicit dev opt-in", () => {
    const base = { hub: "0x00000000000000000000000000000000000000aa" };
    const cfg = { databaseUrl: null, chainId: 8453, rpcUrls: ["https://mainnet.base.org"] };
    assert.ok(checkReadiness(base, cfg).missing.includes("scanner"));
    process.env["CLAMAV_HOST"] = "clamav";
    assert.ok(!checkReadiness(base, cfg).missing.includes("scanner"));
    delete process.env["CLAMAV_HOST"];
    process.env["EVIDENCE_ALLOW_DEFERRED"] = "1";
    assert.ok(!checkReadiness(base, cfg).missing.includes("scanner"));
  });
});
