// Alert delivery: pluggable sinks plus delivery-aware dedupe. Delivery is
// deliberately non-throwing and best-effort: an alerting outage must never
// take down the worker. Unlike the old contract, a sink now REPORTS success
// (true) or failure (false/throw), and the deduper only marks an alert
// delivered after a sink actually accepted it. No secret or configured
// webhook URL is ever written to logs or error strings.
import type { Alert } from "./thresholds.js";

export interface AlertSink {
  /** true when the alert was accepted by the sink; false/throw means retry. */
  send(alert: Alert): Promise<boolean>;
}

export const DEFAULT_ALERT_MAX_ATTEMPTS = 3;

/** Bounded per-alert delivery attempts before the deduper gives up. */
export function alertMaxAttemptsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env["ALERT_MAX_ATTEMPTS"]);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_ALERT_MAX_ATTEMPTS;
}

const SECRET_KEY = /(secret|private|key|token|sig|signature|password|passphrase|auth|webhook)/i;

/** Mask values whose key names look like credentials before any output. */
export function redactDetails(details: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    redacted[key] = SECRET_KEY.test(key) ? "[redacted]" : value;
  }
  return redacted;
}

export interface LogSinkOptions {
  readonly write?: (line: string) => void;
}

/** Structured, redacted console sink. Never throws. */
export class LogSink implements AlertSink {
  private readonly write: (line: string) => void;

  constructor(options: LogSinkOptions = {}) {
    this.write =
      options.write ??
      ((line) => {
        try {
          console.log(line);
        } catch {
          // ignore console failures
        }
      });
  }

  async send(alert: Alert): Promise<boolean> {
    try {
      this.write(
        JSON.stringify({
          kind: "alert",
          severity: alert.severity,
          id: alert.id,
          summary: alert.summary,
          details: redactDetails(alert.details),
          atUnix: alert.atUnix,
        }),
      );
      return true;
    } catch {
      // never throw from a sink; report failure so the alert is retried
      return false;
    }
  }
}

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

export interface WebhookSinkOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly idempotencyWindowSeconds?: number;
}

/**
 * POSTs one JSON object per alert to a webhook. Delivery is non-throwing and
 * idempotent within a coarse window: repeats of the same alert id in the same
 * bucket are skipped before the network call. Failures are counted, not raised.
 */
export class WebhookSink implements AlertSink {
  readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly windowSeconds: number;
  private readonly seen = new Map<string, number>();
  failures = 0;
  lastError: string | null = null;

  constructor(url: string, options: WebhookSinkOptions = {}) {
    this.url = url;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl =
      options.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
    this.windowSeconds = Math.max(1, options.idempotencyWindowSeconds ?? 900);
  }

  async send(alert: Alert): Promise<boolean> {
    const bucket = Math.floor(alert.atUnix / this.windowSeconds);
    const key = `${alert.id}:${bucket}`;
    // Only a SUCCESSFUL delivery is remembered; a failure must not suppress a retry.
    if (this.seen.has(key)) return true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: alert.id,
          severity: alert.severity,
          summary: alert.summary,
          details: redactDetails(alert.details),
          atUnix: alert.atUnix,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.failures += 1;
        this.lastError = `http-${response.status}`;
        return false;
      }
      this.seen.set(key, alert.atUnix);
      return true;
    } catch (error) {
      this.failures += 1;
      this.lastError = error instanceof Error ? error.name : "fetch-failed";
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fan-out sink that isolates failures so one sink cannot block the others. */
export class CompositeSink implements AlertSink {
  private readonly sinks: readonly AlertSink[];

  constructor(sinks: readonly AlertSink[]) {
    this.sinks = sinks;
  }

  async send(alert: Alert): Promise<boolean> {
    // Fan out to every sink (one outage must not block the others), but only
    // report success when ALL sinks accepted: a failed sink still needs a retry.
    let allOk = true;
    for (const sink of this.sinks) {
      try {
        const ok = await sink.send(alert);
        if (!ok) allOk = false;
      } catch {
        allOk = false;
      }
    }
    return allOk;
  }
}

/** Standard windowed dedupe keyed by (alert id + coarse time bucket). */
export function dedupeAlert(
  alerts: readonly Alert[],
  nowUnix: number,
  windowSeconds: number,
  seen: Map<string, number>,
): { fresh: Alert[]; suppressed: Alert[] } {
  const window = Math.max(1, windowSeconds);
  const bucket = Math.floor(nowUnix / window);
  const fresh: Alert[] = [];
  const suppressed: Alert[] = [];
  for (const alert of alerts) {
    const key = `${alert.id}:${bucket}`;
    if (seen.has(key)) {
      suppressed.push(alert);
    } else {
      seen.set(key, nowUnix);
      fresh.push(alert);
    }
  }
  for (const [key, at] of seen) {
    if (nowUnix - at >= window) seen.delete(key);
  }
  return { fresh, suppressed };
}

export function dedupeWindowFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env["DEDUPE_WINDOW_SECONDS"]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900;
}

export interface AlertAttemptState {
  readonly attempts: number;
  readonly deliveredAt: number | null;
  readonly givenUp: boolean;
}

/**
 * Stateful, delivery-aware deduper that persists across monitoring passes.
 *
 * An alert is suppressed only when it was successfully delivered within the
 * dedupe window, or when delivery permanently gave up after `maxAttempts`.
 * A failed delivery is therefore re-offered as `fresh` on the next pass. The
 * caller reports outcomes via `recordSuccess` / `recordFailure`.
 */
export class AlertDeduper {
  private readonly states = new Map<string, AlertAttemptState>();
  private readonly windowSeconds: number;
  readonly maxAttempts: number;

  constructor(windowSeconds: number = dedupeWindowFromEnv(), maxAttempts: number = alertMaxAttemptsFromEnv()) {
    this.windowSeconds = Math.max(1, windowSeconds);
    this.maxAttempts = Math.max(1, Math.floor(maxAttempts));
  }

  filter(alerts: readonly Alert[], nowUnix: number): { fresh: Alert[]; suppressed: Alert[] } {
    const fresh: Alert[] = [];
    const suppressed: Alert[] = [];
    const seenThisPass = new Set<string>();
    for (const alert of alerts) {
      if (seenThisPass.has(alert.id)) {
        suppressed.push(alert);
        continue;
      }
      seenThisPass.add(alert.id);
      const state = this.states.get(alert.id);
      if (state === undefined) {
        fresh.push(alert);
        continue;
      }
      if (state.givenUp) {
        suppressed.push(alert);
        continue;
      }
      if (state.deliveredAt !== null && nowUnix - state.deliveredAt < this.windowSeconds) {
        suppressed.push(alert);
        continue;
      }
      fresh.push(alert);
    }
    this.prune(nowUnix);
    return { fresh, suppressed };
  }

  /** Record an accepted delivery; the alert is suppressed for one window. */
  recordSuccess(alert: Alert, nowUnix: number): void {
    this.states.set(alert.id, { attempts: 0, deliveredAt: nowUnix, givenUp: false });
  }

  /**
   * Record a failed attempt. Returns the resulting state; `givenUp` is true
   * once the bounded attempt budget (ALERT_MAX_ATTEMPTS) is exhausted.
   */
  recordFailure(alert: Alert, nowUnix: number): AlertAttemptState {
    const previous = this.states.get(alert.id);
    const attempts = (previous?.attempts ?? 0) + 1;
    const state: AlertAttemptState = {
      attempts,
      deliveredAt: previous?.deliveredAt ?? null,
      givenUp: attempts >= this.maxAttempts,
    };
    void nowUnix;
    this.states.set(alert.id, state);
    return state;
  }

  /** Current attempt state for an alert (observability / tests). */
  stateFor(id: string): AlertAttemptState | undefined {
    return this.states.get(id);
  }

  private prune(nowUnix: number): void {
    for (const [id, state] of this.states) {
      if (state.givenUp) continue;
      if (state.deliveredAt !== null && nowUnix - state.deliveredAt >= this.windowSeconds) {
        this.states.delete(id);
      }
    }
  }
}

/** Build the default sink stack: always log; also POST when a webhook is set. */
export function makeSinkFromEnv(env: NodeJS.ProcessEnv = process.env): AlertSink {
  const sinks: AlertSink[] = [new LogSink()];
  const url = env["ALERT_WEBHOOK_URL"];
  if (url) {
    const timeout = Number(env["ALERT_WEBHOOK_TIMEOUT_MS"]);
    sinks.push(
      new WebhookSink(url, {
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5_000,
        idempotencyWindowSeconds: dedupeWindowFromEnv(env),
      }),
    );
  }
  return sinks.length === 1 ? sinks[0]! : new CompositeSink(sinks);
}
