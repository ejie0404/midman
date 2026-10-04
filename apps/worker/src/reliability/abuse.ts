// AbuseControls: per-key token buckets, content-hash duplicate detection, and
// malformed-payload guards for relay submissions and evidence uploads.
// Deterministic: supply `now` (and `nowUnix` for duplicates) in tests.
export const DEFAULT_RELAY_RATE_PER_MIN = 30;
export const DEFAULT_EVIDENCE_RATE_PER_MIN = 10;
export const DEFAULT_DUPLICATE_WINDOW_SECONDS = 300;
export const DEFAULT_RELAY_MAX_BYTES = 20_000;

export interface AbuseControlsOptions {
  readonly relayRatePerMin?: number;
  readonly evidenceRatePerMin?: number;
  readonly duplicateWindowSeconds?: number;
  readonly relayMaxBytes?: number;
  readonly now?: () => number;
}

export interface Decision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const ALLOW: Decision = { allowed: true, reason: "", retryAfterSeconds: 0 };
const MAX_TRACKED_HASHES = 10_000;

function deny(reason: string, retryAfterSeconds: number): Decision {
  return { allowed: false, reason, retryAfterSeconds };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Even-length 0x-prefixed hex (0x is valid empty calldata). */
export function isHexData(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0;
}

export class AbuseControls {
  readonly relayRatePerMin: number;
  readonly evidenceRatePerMin: number;
  readonly duplicateWindowSeconds: number;
  readonly relayMaxBytes: number;
  private readonly now: () => number;
  private readonly relayBuckets = new Map<string, Bucket>();
  private readonly uploadBuckets = new Map<string, Bucket>();
  private readonly seenHashes = new Map<string, number>();

  constructor(options: AbuseControlsOptions = {}) {
    this.relayRatePerMin = options.relayRatePerMin ?? envInt("RELAY_RATE_PER_MIN", DEFAULT_RELAY_RATE_PER_MIN);
    this.evidenceRatePerMin =
      options.evidenceRatePerMin ?? envInt("EVIDENCE_RATE_PER_MIN", DEFAULT_EVIDENCE_RATE_PER_MIN);
    this.duplicateWindowSeconds =
      options.duplicateWindowSeconds ?? envInt("DUPLICATE_WINDOW_SECONDS", DEFAULT_DUPLICATE_WINDOW_SECONDS);
    this.relayMaxBytes = options.relayMaxBytes ?? envInt("RELAY_MAX_BYTES", DEFAULT_RELAY_MAX_BYTES);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  private take(buckets: Map<string, Bucket>, key: string, perMin: number): Decision {
    const nowSeconds = this.now();
    if (perMin <= 0) return deny("rate-limited", 60);
    const ratePerSecond = perMin / 60;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: perMin, updatedAt: nowSeconds };
      buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, nowSeconds - bucket.updatedAt);
    bucket.tokens = Math.min(perMin, bucket.tokens + elapsed * ratePerSecond);
    bucket.updatedAt = nowSeconds;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return ALLOW;
    }
    const deficit = 1 - bucket.tokens;
    return deny("rate-limited", Math.max(1, Math.ceil(deficit / ratePerSecond)));
  }

  /** Relay-submission token bucket, keyed by wallet/IP/token. */
  checkRelay(key: string): Decision {
    return this.take(this.relayBuckets, key, this.relayRatePerMin);
  }

  /** Evidence-upload token bucket, keyed by wallet/IP/token; rejects empty bodies. */
  checkUpload(key: string, bytes: number): Decision {
    if (!Number.isFinite(bytes) || bytes <= 0) return deny("bad-size", 0);
    return this.take(this.uploadBuckets, key, this.evidenceRatePerMin);
  }

  /** Content-hash duplicate guard inside DUPLICATE_WINDOW_SECONDS. */
  checkDuplicate(hash: string, nowUnix: number): Decision {
    const key = hash.toLowerCase();
    const seen = this.seenHashes.get(key);
    if (seen !== undefined && nowUnix - seen < this.duplicateWindowSeconds) {
      return deny("duplicate", this.duplicateWindowSeconds - (nowUnix - seen));
    }
    if (this.seenHashes.size >= MAX_TRACKED_HASHES) {
      for (const [tracked, at] of this.seenHashes) {
        if (nowUnix - at >= this.duplicateWindowSeconds) this.seenHashes.delete(tracked);
      }
    }
    this.seenHashes.set(key, nowUnix);
    return ALLOW;
  }

  /** Oversize JSON and non-hex `data` guard for a raw relay/evidence payload. */
  checkPayload(json: string, data?: unknown): Decision {
    if (Buffer.byteLength(json, "utf8") > this.relayMaxBytes) return deny("oversize", 0);
    if (data !== undefined && !isHexData(data)) return deny("non-hex", 0);
    return ALLOW;
  }
}
