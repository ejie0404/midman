#!/usr/bin/env node
// Phase 13 operator readiness CLI.
//
// Aggregates launch readiness WITHOUT touching a live chain:
//   - validates required environment variables (RPC, hub, token, role addresses)
//   - imports the built worker (`apps/worker/dist/index.js`) behind a dynamic
//     import with a graceful fallback when dist is absent
//   - runs the offline worker drills (`runDrills`) and a no-chain `workerHealth`
//   - prints a PASS/FAIL/WARN table, or JSON with `--json`
//
// Exit code is nonzero if any REQUIRED item fails, unless `--warn-only` is set.
// The CLI is importable: `validateEnv`, `aggregateReadiness`, `formatTable`,
// `requiredFailures` are exported and `main()` only runs under the main guard.
import { pathToFileURL } from "node:url";

export const CANONICAL_BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const BASE_CHAIN_ID = 8453;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Required operational role addresses; first entry is canonical, rest are accepted aliases. */
export const ADDRESS_ROLES = [
  ["GOVERNANCE_TIMELOCK_ADDRESS", ["GOVERNANCE"]],
  ["PAUSER_ADDRESS", ["PAUSER"]],
  ["ADMISSION_SIGNER_ADDRESS", ["ADMISSION_SIGNER"]],
  ["VETO_MULTISIG_ADDRESS", []],
  ["PLATFORM_FEE_RECIPIENT", []],
  ["ARBITRATION_COST_RECIPIENT", []],
];

export function isAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value.trim());
}

function firstValue(env, names) {
  for (const name of names) {
    const raw = env?.[name];
    if (raw !== undefined && String(raw).trim() !== "") {
      return { name, value: String(raw).trim() };
    }
  }
  return null;
}

function check(id, name, required, ok, detail) {
  return { id, name, required, ok, detail };
}

/**
 * Pure environment validation. Returns an array of checks:
 * `{ id, name, required, ok, detail }`. A missing/invalid optional item is a
 * WARN (`ok:false, required:false`), never a hard failure.
 */
export function validateEnv(env = process.env) {
  const checks = [];

  const rpc = env?.["BASE_RPC_URLS"];
  if (rpc === undefined || String(rpc).trim() === "") {
    checks.push(check("rpc-urls", "BASE_RPC_URLS", true, false, "missing (required)"));
  } else {
    const urls = String(rpc)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const invalid = urls.filter((url) => !/^(https?|wss?):\/\//i.test(url));
    checks.push(
      check(
        "rpc-urls",
        "BASE_RPC_URLS",
        true,
        urls.length > 0 && invalid.length === 0,
        urls.length === 0
          ? "present but empty after parsing"
          : invalid.length > 0
            ? `${invalid.length} URL(s) not http(s)/ws(s): ${invalid.join(", ")}`
            : `${urls.length} endpoint(s) configured`,
      ),
    );
  }

  const chainId = env?.["BASE_CHAIN_ID"];
  if (chainId === undefined || String(chainId).trim() === "") {
    checks.push(check("chain-id", "BASE_CHAIN_ID", false, false, `not set (expected ${BASE_CHAIN_ID})`));
  } else {
    const ok = String(chainId).trim() === String(BASE_CHAIN_ID);
    checks.push(
      check("chain-id", "BASE_CHAIN_ID", false, ok, ok ? `Base (${BASE_CHAIN_ID})` : `unexpected ${chainId}`),
    );
  }

  const hub = env?.["HUB_ADDRESS"];
  checks.push(
    check(
      "hub-address",
      "HUB_ADDRESS",
      true,
      isAddress(hub),
      isAddress(hub) ? "valid address" : hub ? "invalid address format" : "missing (required)",
    ),
  );

  const usdc = env?.["USDC_ADDRESS"];
  const usdcValid = isAddress(usdc);
  const usdcCanonical = usdcValid && usdc.trim().toLowerCase() === CANONICAL_BASE_USDC;
  checks.push(
    check(
      "usdc-address",
      "USDC_ADDRESS",
      true,
      usdcCanonical,
      !usdcValid
        ? usdc
          ? "invalid address format"
          : "missing (required)"
        : usdcCanonical
          ? "canonical native USDC on Base"
          : `non-canonical token ${usdc.trim()} (launch expects native USDC on Base)`,
    ),
  );

  for (const [canonical, aliases] of ADDRESS_ROLES) {
    const found = firstValue(env, [canonical, ...aliases]);
    const ok = found !== null && isAddress(found.value);
    checks.push(
      check(
        `role:${canonical}`,
        canonical,
        true,
        ok,
        found === null
          ? "missing (required)"
          : isAddress(found.value)
            ? `valid address (via ${found.name})`
            : "invalid address format",
      ),
    );
  }

  const webhook = firstValue(env, ["ALERT_WEBHOOK_URL"]);
  if (webhook === null) {
    checks.push(check("alert-webhook", "ALERT_WEBHOOK_URL", false, false, "not configured (alerts are log-only)"));
  } else {
    const ok = /^https?:\/\//i.test(webhook.value);
    checks.push(
      check("alert-webhook", "ALERT_WEBHOOK_URL", false, ok, ok ? "configured" : "must be an http(s) URL"),
    );
  }

  return checks;
}

export function requiredFailures(checks) {
  return checks.filter((entry) => entry.required && !entry.ok);
}

function workerIndexUrl() {
  return new URL("../apps/worker/dist/index.js", import.meta.url);
}

function workerDrillsUrl() {
  return new URL("../apps/worker/dist/drills/index.js", import.meta.url);
}

async function collectWorkerChecks(checks, env, now, deps) {
  const loadIndex = deps.loadIndex ?? (() => import(workerIndexUrl().href));
  const loadDrills = deps.loadDrills ?? (() => import(workerDrillsUrl().href));
  let drillsCollected = false;

  try {
    const mod = await loadIndex();
    checks.push(check("worker-dist", "worker dist import", false, true, "apps/worker/dist/index.js loaded"));

    if (typeof mod.runDrills === "function") {
      const result = await mod.runDrills(now);
      const drills = Array.isArray(result?.drills) ? result.drills : [];
      const failed = drills.filter((drill) => !drill?.ok).length;
      checks.push(
        check(
          "worker-drills",
          "offline worker drills",
          true,
          result?.ok === true,
          `${drills.length} drill(s), ${failed} failed`,
        ),
      );
      drillsCollected = true;
    }

    if (typeof mod.workerHealth === "function") {
      const envLike = {
        store: { listQueuedRelay: async () => [], listDealIds: async () => [] },
        reader: null,
        hub: null,
        usdc: env?.["USDC_ADDRESS"] ?? CANONICAL_BASE_USDC,
      };
      try {
        const health = await mod.workerHealth(envLike, now);
        checks.push(
          check(
            "worker-health",
            "workerHealth callable (no chain)",
            false,
            true,
            `capacity=${health?.capacity?.state ?? "?"} degraded=${health?.degraded}`,
          ),
        );
      } catch (error) {
        checks.push(
          check("worker-health", "workerHealth callable (no chain)", false, false, String(error?.message ?? error)),
        );
      }
    }
  } catch (error) {
    const detail = error?.code === "ERR_MODULE_NOT_FOUND" ? "dist not built" : String(error?.message ?? error);
    checks.push(
      check(
        "worker-dist",
        "worker dist import",
        false,
        false,
        `${detail}; run pnpm --filter @midman/worker build`,
      ),
    );
  }

  if (drillsCollected) return;

  try {
    const drills = await loadDrills();
    if (typeof drills.runAllDrills === "function") {
      const result = await drills.runAllDrills({
        restore: () => drills.restoreDrillWithLocalStore(),
        outage: () => drills.outageDrill(drills.simulatedOutageDeps()),
      });
      const list = Array.isArray(result?.drills) ? result.drills : [];
      const failed = list.filter((drill) => !drill?.ok).length;
      checks.push(
        check("worker-drills", "offline worker drills", true, result?.ok === true, `${list.length} drill(s), ${failed} failed`),
      );
    }
  } catch (error) {
    checks.push(
      check(
        "drills-dist",
        "drills dist import",
        false,
        false,
        error?.code === "ERR_MODULE_NOT_FOUND" ? "dist not built" : String(error?.message ?? error),
      ),
    );
  }
}

/**
 * Aggregate env + offline worker readiness. `deps.loadIndex` / `deps.loadDrills`
 * can be injected for tests so no build is required.
 */
export async function aggregateReadiness(env = process.env, deps = {}) {
  const now = Math.floor(Date.now() / 1_000);
  const checks = [...validateEnv(env)];
  await collectWorkerChecks(checks, env, now, deps);
  const failures = requiredFailures(checks);
  return { ok: failures.length === 0, checks, requiredFailures: failures.map((entry) => entry.id) };
}

/** Render a fixed-width PASS/FAIL/WARN table plus a one-line summary. */
export function formatTable(checks) {
  const rows = checks.map((entry) => {
    const status = entry.ok ? "PASS" : entry.required ? "FAIL" : "WARN";
    return { status, name: entry.name, detail: entry.detail };
  });
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const lines = [
    `${"STATUS".padEnd(6)} ${"ITEM".padEnd(nameWidth)} DETAIL`,
    `${"-".repeat(6)} ${"-".repeat(nameWidth)} ${"-".repeat(40)}`,
  ];
  for (const row of rows) {
    lines.push(`${row.status.padEnd(6)} ${row.name.padEnd(nameWidth)} ${row.detail}`);
  }
  const failures = rows.filter((row) => row.status === "FAIL").length;
  const warns = rows.filter((row) => row.status === "WARN").length;
  lines.push("");
  lines.push(
    `READINESS: ${failures === 0 ? "PASS" : "FAIL"} (${failures} required failure(s), ${warns} warning(s))`,
  );
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const warnOnly = argv.includes("--warn-only");
  const result = await aggregateReadiness(process.env);
  if (json) {
    console.log(JSON.stringify({ ...result, warnOnly }, null, 2));
  } else {
    console.log(formatTable(result.checks));
    if (warnOnly && !result.ok) console.log("(--warn-only: exiting 0 despite failures)");
    if (json) console.log(JSON.stringify(result, null, 2));
  }
  const exitCode = result.ok || warnOnly ? 0 : 1;
  return { result, exitCode };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
