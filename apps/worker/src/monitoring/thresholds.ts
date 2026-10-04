// Pure threshold evaluation over a MetricsSnapshot. No I/O, no state, no
// secrets. Thresholds come from the environment with safe defaults so a
// missing variable degrades to a conservative constant instead of throwing.
import type { MetricsSnapshot } from "./metrics.js";

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly summary: string;
  readonly details: Record<string, string>;
  readonly atUnix: number;
}

export interface MonitoringThresholds {
  /** Alert on a settled deal whose funded (principal + prepaid fee) is >= this. */
  readonly largeSettlementUnits: bigint;
  /** Reportable bound that backs the overdue-ruling warning. */
  readonly rulingPendingMaxSeconds: number;
  /** Alert when relayFailed is strictly greater than this. */
  readonly relayFailedMax: number;
  /** Alert when sponsors24h is strictly greater than this. */
  readonly sponsorDailyTxCap: number;
  /** Alert when known sponsor spend (wei) is >= this; 0 disables the check. */
  readonly sponsorDailyWeiCap: bigint;
  /** Alert when a queued ruling has aged beyond this many seconds. */
  readonly reviewerInactivitySeconds: number;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBigInt(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || !/^[0-9]+$/.test(value.trim())) return fallback;
  try {
    return BigInt(value.trim());
  } catch {
    return fallback;
  }
}

/** Read thresholds from env, substituting documented defaults on absence/parse failure. */
export function thresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): MonitoringThresholds {
  return {
    largeSettlementUnits: parseBigInt(env["LARGE_SETTLEMENT_UNITS"], 10_000_000_000n),
    rulingPendingMaxSeconds: parseNumber(env["RULING_PENDING_MAX_SECONDS"], 172_800),
    relayFailedMax: parseNumber(env["RELAY_FAILED_MAX"], 5),
    sponsorDailyTxCap: parseNumber(env["SPONSOR_DAILY_TX_CAP"], 50),
    sponsorDailyWeiCap: parseBigInt(env["SPONSOR_DAILY_WEI_CAP"], 0n),
    reviewerInactivitySeconds: parseNumber(env["REVIEWER_INACTIVITY_SECONDS"], 259_200),
  };
}

function shortfallUnits(snapshot: MetricsSnapshot): string {
  const liabilities = BigInt(snapshot.solvency.liabilitiesUnits);
  const balance = BigInt(snapshot.solvency.balanceUnits);
  return (liabilities - balance).toString();
}

/** Evaluate a snapshot into a set of alerts. Deterministic and side-effect free. */
export function evaluate(snapshot: MetricsSnapshot, thresholds: MonitoringThresholds): Alert[] {
  const atUnix = snapshot.atUnix;
  const alerts: Alert[] = [];

  if (snapshot.solvency.status === "unknown" || snapshot.solvency.ok === null) {
    alerts.push({
      id: "solvency_unknown",
      severity: "warning",
      summary: "Solvency is unknown: chain read failed or reader/hub is missing",
      details: {
        reason: snapshot.solvency.reason ?? "unknown",
        liabilitiesUnits: snapshot.solvency.liabilitiesUnits,
        balanceUnits: snapshot.solvency.balanceUnits,
      },
      atUnix,
    });
  } else if (!snapshot.solvency.ok) {
    alerts.push({
      id: "solvency",
      severity: "critical",
      summary: "Custody balance is below accounted liabilities",
      details: {
        liabilitiesUnits: snapshot.solvency.liabilitiesUnits,
        balanceUnits: snapshot.solvency.balanceUnits,
        shortfallUnits: shortfallUnits(snapshot),
      },
      atUnix,
    });
  }

  for (const settlement of snapshot.settlements) {
    if (BigInt(settlement.fundedUnits) >= thresholds.largeSettlementUnits) {
      alerts.push({
        id: `large-settlement:${settlement.dealId}`,
        severity: "warning",
        summary: "Large settlement funded above threshold",
        details: {
          dealId: settlement.dealId,
          fundedUnits: settlement.fundedUnits,
          thresholdUnits: thresholds.largeSettlementUnits.toString(),
        },
        atUnix,
      });
    }
  }

  if (snapshot.rulings.overdueCount > 0) {
    alerts.push({
      id: "ruling-overdue",
      severity: "warning",
      summary: "Queued ruling has passed its execution deadline",
      details: {
        overdueCount: String(snapshot.rulings.overdueCount),
        rulingPendingMaxSeconds: String(thresholds.rulingPendingMaxSeconds),
      },
      atUnix,
    });
  }

  if (snapshot.ops.relayQueued === null) {
    alerts.push({
      id: "relay_queued_unknown",
      severity: "warning",
      summary: "Relay queue depth could not be read",
      details: {},
      atUnix,
    });
  }

  if (snapshot.ops.relayFailed > thresholds.relayFailedMax) {
    alerts.push({
      id: "relay-failed",
      severity: "warning",
      summary: "Relay outbox has more failed jobs than allowed",
      details: {
        relayFailed: String(snapshot.ops.relayFailed),
        relayFailedMax: String(thresholds.relayFailedMax),
      },
      atUnix,
    });
  }

  if (snapshot.ops.sponsors24h === null) {
    alerts.push({
      id: "sponsor_count_unknown",
      severity: "warning",
      summary: "Sponsored transaction count (24h) could not be read",
      details: { sponsorDailyTxCap: String(thresholds.sponsorDailyTxCap) },
      atUnix,
    });
  } else if (snapshot.ops.sponsors24h > thresholds.sponsorDailyTxCap) {
    alerts.push({
      id: "sponsor-cap",
      severity: "warning",
      summary: "Sponsored transactions in the last 24h exceed the daily cap",
      details: {
        sponsors24h: String(snapshot.ops.sponsors24h),
        sponsorDailyTxCap: String(thresholds.sponsorDailyTxCap),
      },
      atUnix,
    });
  }

  if (snapshot.ops.sponsorSpendWeiUnits === null) {
    alerts.push({
      id: "sponsor_spend_unknown",
      severity: "warning",
      summary: "Sponsor gas spend is unknown: no spend source is available",
      details: { sponsorDailyWeiCap: thresholds.sponsorDailyWeiCap.toString() },
      atUnix,
    });
  } else if (
    thresholds.sponsorDailyWeiCap > 0n &&
    BigInt(snapshot.ops.sponsorSpendWeiUnits) >= thresholds.sponsorDailyWeiCap
  ) {
    alerts.push({
      id: "sponsor-wei-cap",
      severity: "warning",
      summary: "Sponsored gas spend has reached the daily wei cap",
      details: {
        sponsorSpendWeiUnits: snapshot.ops.sponsorSpendWeiUnits,
        sponsorDailyWeiCap: thresholds.sponsorDailyWeiCap.toString(),
      },
      atUnix,
    });
  }

  if (snapshot.disputes.inFallback > 0) {
    alerts.push({
      id: "fallback-active",
      severity: "info",
      summary: "Fallback review is active on at least one deal",
      details: { inFallback: String(snapshot.disputes.inFallback) },
      atUnix,
    });
  }

  if (snapshot.escapes.eligibleCount > 0) {
    alerts.push({
      id: "escape-eligible",
      severity: "warning",
      summary: "At least one deal is eligible for catastrophic escape",
      details: { eligibleCount: String(snapshot.escapes.eligibleCount) },
      atUnix,
    });
  }

  if (snapshot.rulings.queuedAgeMaxSeconds > thresholds.reviewerInactivitySeconds) {
    alerts.push({
      id: "reviewer-inactivity",
      severity: "warning",
      summary: "A ruling has been queued beyond the reviewer inactivity bound",
      details: {
        queuedAgeMaxSeconds: String(snapshot.rulings.queuedAgeMaxSeconds),
        reviewerInactivitySeconds: String(thresholds.reviewerInactivitySeconds),
      },
      atUnix,
    });
  }

  if (snapshot.lifecycle.fundingPaused === true) {
    alerts.push({
      id: "funding-paused",
      severity: "critical",
      summary: "Hub funding is paused",
      details: { fundingPaused: "true" },
      atUnix,
    });
  }

  return alerts;
}
