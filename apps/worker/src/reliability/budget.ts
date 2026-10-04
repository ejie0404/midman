// SponsorshipBudget: daily transaction-count AND daily wei-spend caps for the
// relay sponsor. In-memory by default; optionally persisted to a JSON file so
// caps survive a worker restart. Wei is always bigint.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_SPONSOR_DAILY_TX_CAP = 50;
// 20000000000000000 wei = 0.02 ETH.
export const DEFAULT_SPONSOR_DAILY_WEI_CAP = 20_000_000_000_000_000n;

export interface SponsorshipBudgetOptions {
  readonly txCap?: number;
  readonly weiCap?: bigint;
  readonly file?: string | null;
  readonly now?: () => number;
}

export interface BudgetRemaining {
  readonly day: number;
  readonly tx: number;
  readonly wei: bigint;
}

interface PersistedBudget {
  day: number;
  count: number;
  wei: string;
}

function dayIndex(atUnix: number): number {
  return Math.floor(atUnix / 86_400);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function envWei(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export class SponsorshipBudget {
  readonly txCap: number;
  readonly weiCap: bigint;
  private readonly file: string | null;
  private readonly now: () => number;
  private day: number;
  private count: number;
  private wei: bigint;

  constructor(options: SponsorshipBudgetOptions = {}) {
    this.txCap = options.txCap ?? envInt("SPONSOR_DAILY_TX_CAP", DEFAULT_SPONSOR_DAILY_TX_CAP);
    this.weiCap = options.weiCap ?? envWei("SPONSOR_DAILY_WEI_CAP", DEFAULT_SPONSOR_DAILY_WEI_CAP);
    this.file = options.file ?? process.env["SPONSOR_BUDGET_FILE"] ?? null;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.day = dayIndex(this.now());
    this.count = 0;
    this.wei = 0n;
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistedBudget>;
      if (
        typeof parsed.day === "number" &&
        Number.isInteger(parsed.day) &&
        typeof parsed.count === "number" &&
        parsed.count >= 0 &&
        typeof parsed.wei === "string"
      ) {
        this.day = parsed.day;
        this.count = Math.floor(parsed.count);
        this.wei = BigInt(parsed.wei);
      }
    } catch {
      // Corrupt or unreadable budget file: start fresh; caps stay enforced.
    }
  }

  private persist(): void {
    if (!this.file) return;
    const payload: PersistedBudget = { day: this.day, count: this.count, wei: this.wei.toString() };
    try {
      writeFileSync(this.file, JSON.stringify(payload), "utf8");
    } catch {
      // Best-effort: persistence failure must not break submission.
    }
  }

  private rollIfNeeded(atUnix: number): void {
    const day = dayIndex(atUnix);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
      this.wei = 0n;
    }
  }

  /** True when `count` more txs spending `wei` more wei fit under today's caps. */
  canSpend(count: number, wei: bigint): boolean {
    this.rollIfNeeded(this.now());
    if (count > 0 && this.count + count > this.txCap) return false;
    if (wei > 0n && this.wei + wei > this.weiCap) return false;
    return true;
  }

  /** Record one sponsored tx (exact wei) against the day of `atUnix`. */
  record(_txHash: string, wei: bigint, atUnix: number): void {
    this.rollIfNeeded(atUnix);
    this.count += 1;
    this.wei += wei;
    this.persist();
  }

  /** Remaining capacity for the current UTC day. */
  remaining(): BudgetRemaining {
    this.rollIfNeeded(this.now());
    return {
      day: this.day,
      tx: Math.max(0, this.txCap - this.count),
      wei: this.weiCap > this.wei ? this.weiCap - this.wei : 0n,
    };
  }

  /** Current usage for health/summary surfaces. */
  used(): { readonly count: number; readonly wei: bigint } {
    this.rollIfNeeded(this.now());
    return { count: this.count, wei: this.wei };
  }
}
