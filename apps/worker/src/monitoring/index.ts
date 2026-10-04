// Monitoring subsystem entry point. One pass = collect -> evaluate -> dedupe
// -> deliver. Dedupe state (and the default sink) live at module scope so a
// long-running worker suppresses repeated alerts across timer ticks.
import type { WorkerEnv } from "../index.js";
import { collectMetrics, type MetricsSnapshot } from "./metrics.js";
import {
  evaluate,
  thresholdsFromEnv,
  type Alert,
  type MonitoringThresholds,
} from "./thresholds.js";
import { AlertDeduper, makeSinkFromEnv, type AlertSink } from "./alerts.js";

export interface MonitoringPassOptions {
  readonly sink?: AlertSink;
  readonly deduper?: AlertDeduper;
  readonly thresholds?: MonitoringThresholds;
}

export interface MonitoringPassResult {
  readonly snapshot: MetricsSnapshot;
  readonly alerts: readonly Alert[];
  /** Alerts accepted by the sink this pass. */
  readonly delivered: number;
  /** Alerts skipped because already delivered (or permanently failed). */
  readonly suppressed: number;
  /** Alerts the sink rejected this pass; they are re-queued for the next pass. */
  readonly failed: number;
}

/** Attempt delivery once; a throwing sink counts as a failure, never a crash. */
async function trySend(sink: AlertSink, alert: Alert): Promise<boolean> {
  try {
    return (await sink.send(alert)) === true;
  } catch {
    return false;
  }
}

let defaultDeduper: AlertDeduper | null = null;
let defaultSink: AlertSink | null = null;

/** Run a single monitoring pass. Never throws for delivery failures. */
export async function runMonitoringPass(
  env: WorkerEnv,
  nowSeconds: number,
  opts: MonitoringPassOptions = {},
): Promise<MonitoringPassResult> {
  const snapshot = await collectMetrics(env, nowSeconds);
  const thresholds = opts.thresholds ?? thresholdsFromEnv();
  const alerts = evaluate(snapshot, thresholds);

  const deduper = opts.deduper ?? (defaultDeduper ??= new AlertDeduper());
  const { fresh, suppressed } = deduper.filter(alerts, nowSeconds);

  const sink = opts.sink ?? (defaultSink ??= makeSinkFromEnv());
  let delivered = 0;
  let failed = 0;
  const metaAlerts: Alert[] = [];
  for (const alert of fresh) {
    if (await trySend(sink, alert)) {
      deduper.recordSuccess(alert, nowSeconds);
      delivered += 1;
      continue;
    }
    // Not delivered: never mark delivered, so the next pass retries it.
    failed += 1;
    const state = deduper.recordFailure(alert, nowSeconds);
    if (state.givenUp) {
      metaAlerts.push({
        id: "delivery_failed",
        severity: "warning",
        summary: `Alert delivery failed after ${state.attempts} attempts`,
        details: { alertId: alert.id, attempts: String(state.attempts) },
        atUnix: nowSeconds,
      });
    }
  }

  // A give-up is itself reported (once per pass); failures here are counted too.
  for (const meta of metaAlerts) {
    alerts.push(meta);
    if (await trySend(sink, meta)) delivered += 1;
    else failed += 1;
  }

  return { snapshot, alerts, delivered, suppressed: suppressed.length, failed };
}

/** Documented snapshot metric paths, for dashboards and docs. */
export const MONITOR_METRICS: readonly string[] = [
  "solvency.liabilitiesUnits",
  "solvency.balanceUnits",
  "solvency.ok",
  "solvency.status",
  "escrow.activeDeals",
  "rulings.pendingCount",
  "rulings.overdueCount",
  "rulings.queuedAgeMaxSeconds",
  "disputes.inEvidence",
  "disputes.inPrimary",
  "disputes.inFallback",
  "disputes.deadlock",
  "escapes.eligibleCount",
  "lifecycle.settledCount",
  "lifecycle.fundedCount",
  "lifecycle.fundingPaused",
  "ops.relayQueued",
  "ops.relayFailed",
  "ops.relayUnsigned",
  "ops.sponsors24h",
  "ops.sponsorSpendWeiUnits",
  "ops.indexerLagSeconds",
  "storage.evidenceCount",
  "settlements[].fundedUnits",
];

export { collectMetrics, evaluate, thresholdsFromEnv, makeSinkFromEnv, AlertDeduper };
export type { MetricsSnapshot, MetricSources, SolvencyMetrics } from "./metrics.js";
export type { Alert, MonitoringThresholds } from "./thresholds.js";
export type { AlertSink, AlertAttemptState } from "./alerts.js";
export { DEFAULT_ALERT_MAX_ATTEMPTS, alertMaxAttemptsFromEnv } from "./alerts.js";
