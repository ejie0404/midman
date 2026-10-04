// Phase 10 drill suite: re-exports the individual drills and runs them
// together. The lead wires this into worker/index.ts; each drill stays
// injected so it is runnable without a live chain or object store.
export * from "./restore.js";
export * from "./outage.js";

import type { DrillResult } from "./restore.js";

export interface DrillContext {
  readonly restore?: () => DrillResult | Promise<DrillResult>;
  readonly outage?: () => DrillResult | Promise<DrillResult>;
}

export interface AllDrillsResult {
  readonly ok: boolean;
  readonly drills: DrillResult[];
}

/** Runs every drill supplied in the context; a missing drill is skipped. */
export async function runAllDrills(ctx: DrillContext = {}): Promise<AllDrillsResult> {
  const drills: DrillResult[] = [];
  if (ctx.restore) drills.push(await ctx.restore());
  if (ctx.outage) drills.push(await ctx.outage());
  return { ok: drills.every((drill) => drill.ok), drills };
}
