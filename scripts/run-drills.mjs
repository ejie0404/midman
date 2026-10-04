#!/usr/bin/env node
// Phase 13 offline drill runner.
//
// Runs the framework-agnostic recovery drills from the built worker
// (`apps/worker/dist/drills/index.js`): `runAllDrills` with
// `restoreDrillWithLocalStore()` and `outageDrill(simulatedOutageDeps())`.
// No live chain and no object store are required.
//
// Prints per-step results plus an overall ok/FAIL, with a `--json` mode.
// Nonzero exit on failure. Importable: `summarizeDrillResults`, `runDrillsCli`
// and `formatDrillReport` are exported and `main()` only runs under the main
// guard, so tests can drive the module without spawning a process.
import { pathToFileURL } from "node:url";

function drillsModuleUrl() {
  return new URL("../apps/worker/dist/drills/index.js", import.meta.url);
}

/** Pure aggregation of an AllDrillsResult into counts and flat step list. */
export function summarizeDrillResults(result) {
  const drills = Array.isArray(result?.drills) ? result.drills : [];
  const steps = drills.flatMap((drill) => (Array.isArray(drill?.steps) ? drill.steps : []));
  const failedSteps = steps.filter((step) => !step?.ok);
  const failedDrills = drills.filter((drill) => !drill?.ok);
  return {
    ok: result?.ok === true,
    drillCount: drills.length,
    passedDrills: drills.length - failedDrills.length,
    failedDrillCount: failedDrills.length,
    stepCount: steps.length,
    failedStepCount: failedSteps.length,
    drills,
    steps,
  };
}

/**
 * Load the drills module (injectable via `options.loadModule`) and run every
 * offline drill. Returns `{ ok, result, summary, error }`; never throws.
 */
export async function runDrillsCli(options = {}) {
  const load = options.loadModule ?? (() => import(drillsModuleUrl().href));
  let module;
  try {
    module = await load();
  } catch (error) {
    return {
      ok: false,
      result: null,
      summary: null,
      module: null,
      error:
        error?.code === "ERR_MODULE_NOT_FOUND"
          ? "worker dist not built; run pnpm --filter @midman/worker build"
          : String(error?.message ?? error),
    };
  }

  try {
    const result = await module.runAllDrills({
      restore: () => module.restoreDrillWithLocalStore(),
      outage: () => module.outageDrill(module.simulatedOutageDeps()),
    });
    return { ok: result?.ok === true, result, summary: summarizeDrillResults(result), module, error: null };
  } catch (error) {
    return { ok: false, result: null, summary: null, module, error: String(error?.message ?? error) };
  }
}

/** Human-readable per-step report. */
export function formatDrillReport(outcome) {
  const lines = [];
  if (outcome.error) {
    lines.push(`DRILLS: FAIL - ${outcome.error}`);
    return lines.join("\n");
  }
  for (const drill of outcome.result?.drills ?? []) {
    lines.push(`${drill.ok ? "PASS" : "FAIL"} drill: ${drill.detail ?? "(no detail)"}`);
    for (const step of drill.steps ?? []) {
      lines.push(`  ${step.ok ? "ok  " : "FAIL"} ${step.name} - ${step.detail}`);
    }
  }
  const summary = outcome.summary;
  lines.push("");
  lines.push(
    `DRILLS: ${outcome.ok ? "PASS" : "FAIL"} (${summary?.passedDrills ?? 0}/${summary?.drillCount ?? 0} drills, ` +
      `${summary?.stepCount ?? 0} steps, ${summary?.failedStepCount ?? 0} failed)`,
  );
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const outcome = await runDrillsCli();
  if (json) {
    console.log(
      JSON.stringify(
        { ok: outcome.ok, error: outcome.error, summary: outcome.summary, result: outcome.result },
        null,
        2,
      ),
    );
  } else {
    console.log(formatDrillReport(outcome));
  }
  return { outcome, exitCode: outcome.ok ? 0 : 1 };
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
