import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_BASE_USDC,
  aggregateReadiness,
  formatTable,
  isAddress,
  requiredFailures,
  validateEnv,
} from "./readiness.mjs";
import { formatDrillReport, runDrillsCli, summarizeDrillResults } from "./run-drills.mjs";

const ADDR = "0x" + "11".repeat(20);
const CANONICAL = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const VALID_ENV = {
  BASE_RPC_URLS: "https://mainnet.base.org,https://base.llamarpc.com",
  BASE_CHAIN_ID: "8453",
  HUB_ADDRESS: ADDR,
  USDC_ADDRESS: CANONICAL,
  GOVERNANCE_TIMELOCK_ADDRESS: ADDR,
  PAUSER_ADDRESS: ADDR,
  ADMISSION_SIGNER_ADDRESS: ADDR,
  VETO_MULTISIG_ADDRESS: ADDR,
  PLATFORM_FEE_RECIPIENT: ADDR,
  ARBITRATION_COST_RECIPIENT: ADDR,
  ALERT_WEBHOOK_URL: "https://hooks.example.invalid/alert",
};

function byId(checks, id) {
  return checks.find((entry) => entry.id === id);
}

describe("readiness.validateEnv", () => {
  it("accepts a fully configured launch environment", () => {
    const checks = validateEnv(VALID_ENV);
    assert.equal(requiredFailures(checks).length, 0);
    assert.equal(byId(checks, "rpc-urls").ok, true);
    assert.equal(byId(checks, "chain-id").ok, true);
    assert.equal(byId(checks, "hub-address").ok, true);
    assert.equal(byId(checks, "usdc-address").ok, true);
    assert.equal(byId(checks, "alert-webhook").ok, true);
    for (const [role] of [
      ["GOVERNANCE_TIMELOCK_ADDRESS"],
      ["PAUSER_ADDRESS"],
      ["ADMISSION_SIGNER_ADDRESS"],
      ["VETO_MULTISIG_ADDRESS"],
      ["PLATFORM_FEE_RECIPIENT"],
      ["ARBITRATION_COST_RECIPIENT"],
    ]) {
      assert.equal(byId(checks, `role:${role}`).ok, true, `${role} should pass`);
    }
  });

  it("fails required checks with reasons when RPC and hub are missing", () => {
    const checks = validateEnv({});
    const failures = requiredFailures(checks);
    const ids = failures.map((entry) => entry.id);
    assert.ok(ids.includes("rpc-urls"));
    assert.ok(ids.includes("hub-address"));
    assert.match(byId(checks, "rpc-urls").detail, /required/);
    assert.match(byId(checks, "hub-address").detail, /required/);
  });

  it("rejects malformed addresses and non-canonical USDC", () => {
    const checks = validateEnv({
      ...VALID_ENV,
      HUB_ADDRESS: "0x1234",
      USDC_ADDRESS: "0x0000000000000000000000000000000000000001",
      BASE_RPC_URLS: "not-a-url",
    });
    assert.equal(byId(checks, "hub-address").ok, false);
    assert.equal(byId(checks, "hub-address").required, true);
    assert.match(byId(checks, "hub-address").detail, /invalid/);
    assert.equal(byId(checks, "usdc-address").ok, false);
    assert.match(byId(checks, "usdc-address").detail, /non-canonical/);
    assert.equal(byId(checks, "rpc-urls").ok, false);
    assert.match(byId(checks, "rpc-urls").detail, /not http/);
    assert.equal(isAddress("0x" + "ab".repeat(20)), true);
    assert.equal(isAddress("0x1234"), false);
    assert.equal(isAddress(undefined), false);
  });

  it("honors role aliases and flags every missing role address", () => {
    const viaAliases = validateEnv({ ...VALID_ENV, GOVERNANCE_TIMELOCK_ADDRESS: "", GOVERNANCE: ADDR });
    assert.equal(byId(viaAliases, "role:GOVERNANCE_TIMELOCK_ADDRESS").ok, true);
    const missing = validateEnv({ BASE_RPC_URLS: VALID_ENV.BASE_RPC_URLS, USDC_ADDRESS: CANONICAL });
    for (const role of [
      "role:GOVERNANCE_TIMELOCK_ADDRESS",
      "role:PAUSER_ADDRESS",
      "role:ADMISSION_SIGNER_ADDRESS",
      "role:VETO_MULTISIG_ADDRESS",
      "role:PLATFORM_FEE_RECIPIENT",
      "role:ARBITRATION_COST_RECIPIENT",
    ]) {
      assert.equal(byId(missing, role).ok, false);
      assert.equal(byId(missing, role).required, true);
    }
  });

  it("treats ALERT_WEBHOOK_URL as optional (WARN, not FAIL)", () => {
    const env = { ...VALID_ENV };
    delete env.ALERT_WEBHOOK_URL;
    const checks = validateEnv(env);
    const webhook = byId(checks, "alert-webhook");
    assert.equal(webhook.ok, false);
    assert.equal(webhook.required, false);
    assert.equal(requiredFailures(checks).length, 0);
    assert.match(formatTable(checks), /WARN/);
  });
});

describe("readiness.aggregateReadiness", () => {
  const fakeIndex = {
    async runDrills() {
      return { ok: true, drills: [{ ok: true, steps: [{ name: "restore", ok: true, detail: "ok" }] }] };
    },
    async workerHealth() {
      return { degraded: true, capacity: { state: "green" } };
    },
  };

  const failingDrills = {
    async runAllDrills(ctx) {
      const restore = await ctx.restore();
      const outage = await ctx.outage();
      return { ok: restore.ok && outage.ok, drills: [restore, outage] };
    },
    async restoreDrillWithLocalStore() {
      return { ok: true, steps: [{ name: "restore", ok: true, detail: "ok" }], detail: "restore ok" };
    },
    async outageDrill() {
      return { ok: false, steps: [{ name: "outage", ok: false, detail: "sequencer down" }], detail: "outage failed" };
    },
    simulatedOutageDeps() {
      return {};
    },
  };

  it("imports the worker behind a dynamic import and runs offline drills", async () => {
    const result = await aggregateReadiness(VALID_ENV, { loadIndex: async () => fakeIndex });
    assert.equal(result.ok, true);
    assert.equal(byId(result.checks, "worker-dist").ok, true);
    assert.equal(byId(result.checks, "worker-drills").ok, true);
    assert.equal(byId(result.checks, "worker-health").ok, true);
    assert.equal(result.requiredFailures.length, 0);
  });

  it("falls back to the drills module when the worker index is missing", async () => {
    const result = await aggregateReadiness(VALID_ENV, {
      loadIndex: async () => {
        const error = new Error("missing");
        error.code = "ERR_MODULE_NOT_FOUND";
        throw error;
      },
      loadDrills: async () => failingDrills,
    });
    assert.equal(byId(result.checks, "worker-dist").ok, false);
    assert.equal(byId(result.checks, "worker-dist").required, false);
    assert.equal(byId(result.checks, "worker-drills").ok, false);
    assert.equal(byId(result.checks, "worker-drills").required, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.requiredFailures, ["worker-drills"]);
  });

  it("degrades gracefully when no dist is built at all", async () => {
    const result = await aggregateReadiness(VALID_ENV, {
      loadIndex: async () => {
        const error = new Error("missing");
        error.code = "ERR_MODULE_NOT_FOUND";
        throw error;
      },
      loadDrills: async () => {
        const error = new Error("missing");
        error.code = "ERR_MODULE_NOT_FOUND";
        throw error;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(byId(result.checks, "drills-dist").ok, false);
    assert.equal(byId(result.checks, "drills-dist").required, false);
    assert.match(byId(result.checks, "worker-dist").detail, /pnpm --filter/);
  });
});

describe("run-drills aggregation", () => {
  it("summarizes an all-ok drill result", () => {
    const summary = summarizeDrillResults({
      ok: true,
      drills: [
        { ok: true, steps: [{ name: "a", ok: true, detail: "x" }, { name: "b", ok: true, detail: "y" }] },
        { ok: true, steps: [{ name: "c", ok: true, detail: "z" }] },
      ],
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.drillCount, 2);
    assert.equal(summary.failedDrillCount, 0);
    assert.equal(summary.stepCount, 3);
    assert.equal(summary.failedStepCount, 0);
  });

  it("counts failed drills and steps for a mixed result", () => {
    const summary = summarizeDrillResults({
      ok: false,
      drills: [
        { ok: true, steps: [{ name: "a", ok: true, detail: "x" }] },
        { ok: false, steps: [{ name: "b", ok: false, detail: "boom" }, { name: "c", ok: true, detail: "z" }] },
      ],
    });
    assert.equal(summary.ok, false);
    assert.equal(summary.passedDrills, 1);
    assert.equal(summary.failedDrillCount, 1);
    assert.equal(summary.stepCount, 3);
    assert.equal(summary.failedStepCount, 1);
  });

  it("runs the drills module through an injected loader", async () => {
    const fake = {
      async runAllDrills(ctx) {
        const restore = await ctx.restore();
        const outage = await ctx.outage();
        return { ok: restore.ok && outage.ok, drills: [restore, outage] };
      },
      async restoreDrillWithLocalStore() {
        return { ok: true, steps: [{ name: "re-download-and-rehash", ok: true, detail: "sha256 match" }], detail: "restore ok" };
      },
      async outageDrill() {
        return {
          ok: true,
          steps: [
            { name: "sequencer-timeout-fails-closed", ok: true, detail: "ok" },
            { name: "token-liability-preserved", ok: true, detail: "ok" },
          ],
          detail: "outage ok",
        };
      },
      simulatedOutageDeps() {
        return {};
      },
    };
    const outcome = await runDrillsCli({ loadModule: async () => fake });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.summary.drillCount, 2);
    assert.equal(outcome.summary.failedStepCount, 0);
    const report = formatDrillReport(outcome);
    assert.match(report, /DRILLS: PASS/);
    assert.match(report, /re-download-and-rehash/);
  });

  it("returns a nonzero outcome when the module cannot be loaded", async () => {
    const outcome = await runDrillsCli({
      loadModule: async () => {
        const error = new Error("missing");
        error.code = "ERR_MODULE_NOT_FOUND";
        throw error;
      },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /worker dist not built/);
    assert.match(formatDrillReport(outcome), /DRILLS: FAIL/);
  });
});
