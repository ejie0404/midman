// Reliability kit: resilient RPC reads, buffered gas estimation, sponsorship
// budget caps, and abuse controls. Re-exported here so the worker entry can
// wire a single import.
export * from "./rpcPool.js";
export * from "./gas.js";
export * from "./budget.js";
export * from "./abuse.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Report the configured reliability limits for docs/health without exposing
 * any secret. Values mirror the module defaults when the env var is unset.
 */
export function reliabilitySummaryFromEnv(): Record<string, unknown> {
  const urls = (process.env["BASE_RPC_URLS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    rpc: {
      urlsConfigured: urls.length,
      cooldownSeconds: envInt("RPC_COOLDOWN_SECONDS", 60),
    },
    gas: {
      bufferBps: 2_500,
      fallbackGasLimit: envInt("GAS_FALLBACK", 400_000),
    },
    sponsor: {
      dailyTxCap: envInt("SPONSOR_DAILY_TX_CAP", 50),
      dailyWeiCap: process.env["SPONSOR_DAILY_WEI_CAP"] ?? "20000000000000000",
      budgetFile: process.env["SPONSOR_BUDGET_FILE"] !== undefined,
    },
    abuse: {
      relayRatePerMin: envInt("RELAY_RATE_PER_MIN", 30),
      evidenceRatePerMin: envInt("EVIDENCE_RATE_PER_MIN", 10),
      duplicateWindowSeconds: envInt("DUPLICATE_WINDOW_SECONDS", 300),
      relayMaxBytes: envInt("RELAY_MAX_BYTES", 20_000),
    },
  };
}
