// Exact money formatting for Midman V1. USDC has 6 decimals.
// Rules: bigint/strings only, NEVER floats. All functions are pure.
// Uses only erasable TypeScript so Node 24 can import this file directly
// in tests (no enums, namespaces, or parameter properties).

const DEFAULT_DECIMALS = 6;

/** Parse a decimal USDC string (e.g. "1.5", "0.500000") into exact smallest-unit string. */
export function parseUSDC(value: string, decimals: number = DEFAULT_DECIMALS): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed) || decimals !== DEFAULT_DECIMALS) {
    throw new RangeError(`Invalid USDC amount: ${value}`);
  }
  const dot = trimmed.indexOf(".");
  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const frac = dot === -1 ? "" : trimmed.slice(dot + 1);
  if (frac.length > decimals) throw new RangeError(`Too many decimals: ${value}`);
  const paddedFrac = (frac + "000000").slice(0, decimals);
  const units = BigInt(whole === "" ? "0" : whole) * 1_000_000n + BigInt(paddedFrac);
  return units.toString();
}

function groupThousands(digits: string): string {
  let out = "";
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    out = digits[i] + out;
    count++;
    if (count % 3 === 0 && i !== 0) out = "," + out;
  }
  return out;
}

/** Format smallest-unit string/bigint as "1,234.567890" (6 decimals, thousands separators). */
export function formatUnits(units: string | bigint, decimals: number = DEFAULT_DECIMALS): string {
  if (decimals !== DEFAULT_DECIMALS) throw new RangeError("Only 6-decimal USDC is supported");
  const value = typeof units === "bigint" ? units : BigInt(units);
  if (value < 0n) throw new RangeError("Negative units");
  const base = 1_000_000n;
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0");
  return `${groupThousands(whole.toString())}.${frac}`;
}

/**
 * Human display of an exact amount: thousands separators, trailing zeros
 * trimmed down to 2 decimals ("1,234.50", "0.123456"). Never rounds.
 */
export function formatAmount(units: string | bigint): string {
  const full = formatUnits(units);
  const [whole, frac = ""] = full.split(".");
  let trimmed = frac.replace(/0+$/, "");
  if (trimmed.length < 2) trimmed = trimmed.padEnd(2, "0");
  return `${whole}.${trimmed}`;
}

/** Format smallest units as "1,234.567890 USDC". */
export function formatUSDC(units: string | bigint): string {
  return `${formatUnits(units)} USDC`;
}

/** Format an effective fee in basis points as "x.xx%" using integer math only. */
export function formatFeePct(bps: number | bigint): string {
  const b = typeof bps === "bigint" ? bps : BigInt(bps);
  if (b < 0n) throw new RangeError("Negative bps");
  const whole = b / 100n;
  const frac = (b % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}%`;
}

/** Effective fee rate of earnedFee on principal, in bps (floor). Integer math only. */
export function effectiveFeeBps(earnedFeeUnits: string | bigint, principalUnits: string | bigint): bigint {
  const earned = typeof earnedFeeUnits === "bigint" ? earnedFeeUnits : BigInt(earnedFeeUnits);
  const principal = typeof principalUnits === "bigint" ? principalUnits : BigInt(principalUnits);
  if (principal <= 0n) throw new RangeError("Non-positive principal");
  if (earned < 0n) throw new RangeError("Negative fee");
  return (earned * 10_000n) / principal;
}

/** Human countdown to a unix-seconds deadline. Pure: pass `nowUnix` in tests. */
export function countdownTo(targetUnix: number, nowUnix?: number): string {
  const now = nowUnix ?? Math.floor(Date.now() / 1_000);
  if (!Number.isInteger(targetUnix) || !Number.isInteger(now)) {
    throw new TypeError("Timestamps must be integer seconds");
  }
  const diff = targetUnix - now;
  if (diff <= 0) return "expired";
  return formatDuration(diff);
}

/** Human duration for a non-negative integer second count. Pure. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) {
    throw new RangeError("Duration must be a non-negative integer");
  }
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** Format unix seconds as an ISO UTC string. Pure. */
export function formatUnixDate(unixSeconds: string | number): string {
  const n = typeof unixSeconds === "string" ? Number(unixSeconds) : unixSeconds;
  if (!Number.isInteger(n)) throw new TypeError("Timestamp must be integer seconds");
  return new Date(n * 1_000).toISOString();
}

/** Friendly span for windows and countdowns: "3 days", "1 day 6 hours", "45 minutes". */
export function formatSpan(totalSeconds: number): string {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) {
    throw new RangeError("Duration must be a non-negative integer");
  }
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${plural(days, "day")} ${plural(hours, "hour")}` : plural(days, "day");
  if (hours > 0) return minutes > 0 ? `${plural(hours, "hour")} ${plural(minutes, "minute")}` : plural(hours, "hour");
  if (minutes > 0) return plural(minutes, "minute");
  return plural(totalSeconds, "second");
}

