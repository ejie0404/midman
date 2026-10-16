// HTTP-layer hardening for the API: per-client rate limits, security
// headers, proxy trust and structured request logging with redaction.
//
// Rate limiting is a fixed one-minute window per (client IP, bucket), kept in
// process memory. That is the right shape for the single-VPS deployment (one
// API instance behind Caddy/Cloudflare); a multi-instance deployment should
// move the counters to Postgres/Redis or the edge. Buckets separate the
// expensive/abusable surfaces (login challenges, anonymous chain reads that
// burn RPC quota, draft creation) from ordinary reads.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type RateBucket = "auth" | "chain-read" | "draft-create" | "write" | "read";

export interface RateLimits {
  readonly auth: number;
  readonly "chain-read": number;
  readonly "draft-create": number;
  readonly write: number;
  readonly read: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  auth: 30,
  "chain-read": 60,
  "draft-create": 10,
  write: 120,
  read: 600,
};

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 50_000;
const EXEMPT_ROUTES = new Set(["/health", "/health/live", "/health/ready"]);
const CHAIN_READ_ROUTES = new Set(["/tx/:hash/status", "/deals/:dealId/confirmation", "/relay/:key"]);

/** Which bucket a request counts against. */
export function bucketFor(method: string, route: string): RateBucket | null {
  if (EXEMPT_ROUTES.has(route)) return null;
  if (route.startsWith("/auth/")) return "auth";
  if (CHAIN_READ_ROUTES.has(route)) return "chain-read";
  if (method === "POST" && route === "/drafts") return "draft-create";
  if (method === "GET" || method === "HEAD") return "read";
  return "write";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per-minute limits, overridable as RATE_LIMIT_AUTH, RATE_LIMIT_CHAIN_READ, ... */
export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimits {
  return {
    auth: positiveInt(env["RATE_LIMIT_AUTH"], DEFAULT_RATE_LIMITS.auth),
    "chain-read": positiveInt(env["RATE_LIMIT_CHAIN_READ"], DEFAULT_RATE_LIMITS["chain-read"]),
    "draft-create": positiveInt(env["RATE_LIMIT_DRAFT_CREATE"], DEFAULT_RATE_LIMITS["draft-create"]),
    write: positiveInt(env["RATE_LIMIT_WRITE"], DEFAULT_RATE_LIMITS.write),
    read: positiveInt(env["RATE_LIMIT_READ"], DEFAULT_RATE_LIMITS.read),
  };
}

/** Fixed-window counter keyed by `${ip}|${bucket}`; bounded memory. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limits: RateLimits) {}

  /** Returns 0 when allowed, else the seconds until the window resets. */
  hit(ip: string, bucket: RateBucket, nowMs: number = Date.now()): number {
    const key = `${ip}|${bucket}`;
    let window = this.windows.get(key);
    if (!window || nowMs >= window.resetAt) {
      if (!window && this.windows.size >= MAX_TRACKED_KEYS) this.sweep(nowMs);
      window = { count: 0, resetAt: nowMs + WINDOW_MS };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= this.limits[bucket]) return 0;
    return Math.max(1, Math.ceil((window.resetAt - nowMs) / 1_000));
  }

  private sweep(nowMs: number): void {
    for (const [key, window] of this.windows) {
      if (nowMs >= window.resetAt) this.windows.delete(key);
    }
    // Still full (a flood of distinct IPs within one window): drop the oldest.
    while (this.windows.size >= MAX_TRACKED_KEYS) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Fastify `trustProxy` from TRUST_PROXY: unset/"false" -> false (direct),
 * "true" -> true, anything else -> a comma-separated address/CIDR list. Behind
 * Caddy use its address or the docker network CIDR (e.g. "172.16.0.0/12") so
 * req.ip is the real client and rate limits are per client.
 */
export function trustProxyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean | string[] {
  const raw = (env["TRUST_PROXY"] ?? "").trim();
  if (raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true") return true;
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Structured request logs (pino via Fastify) with secrets redacted. Enabled
 * in production or when LOG_LEVEL is set. Query strings are dropped from the
 * logged URL so tokens or signatures passed as query parameters never land
 * in logs; cookies, authorization and request-signature headers are never
 * serialized.
 */
export function loggerFromEnv(env: NodeJS.ProcessEnv = process.env): false | Record<string, unknown> {
  const level = (env["LOG_LEVEL"] ?? "").trim();
  if (level === "" && env["NODE_ENV"] !== "production") return false;
  return {
    level: level === "" ? "info" : level,
    redact: {
      paths: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
      censor: "[redacted]",
    },
    serializers: {
      req(req: { method?: string; url?: string; ip?: string; routeOptions?: { url?: string } }) {
        return {
          method: req.method,
          url: (req.url ?? "").split("?")[0],
          route: req.routeOptions?.url,
          ip: req.ip,
        };
      },
      res(res: { statusCode?: number }) {
        return { statusCode: res.statusCode };
      },
    },
  };
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export interface HardeningOptions {
  /** Enforce rate limits. Default: production or RATE_LIMIT_ENABLE=1. */
  readonly rateLimit?: boolean;
  readonly limits?: RateLimits;
}

/** Register rate limiting + security headers on an app. */
export function registerHttpHardening(
  app: FastifyInstance,
  options: HardeningOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): { limiter: RateLimiter | null } {
  const production = env["NODE_ENV"] === "production";
  const enabled = options.rateLimit ?? (production || env["RATE_LIMIT_ENABLE"] === "1");
  const limiter = enabled ? new RateLimiter(options.limits ?? rateLimitsFromEnv(env)) : null;

  if (limiter) {
    app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      const bucket = bucketFor(req.method.toUpperCase(), req.routeOptions?.url ?? req.url.split("?")[0] ?? "");
      if (bucket === null) return;
      const retryAfter = limiter.hit(req.ip, bucket);
      if (retryAfter > 0) {
        return reply
          .code(429)
          .header("retry-after", String(retryAfter))
          .send({ error: "Too many requests", bucket, retryAfterSeconds: retryAfter });
      }
      return;
    });
  }

  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (production && !reply.hasHeader("strict-transport-security")) {
      reply.header("strict-transport-security", "max-age=63072000; includeSubDomains");
    }
    return payload;
  });

  return { limiter };
}
