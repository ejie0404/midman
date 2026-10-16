import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../dist/server.js";
import {
  RateLimiter,
  bucketFor,
  loggerFromEnv,
  rateLimitsFromEnv,
  trustProxyFromEnv,
} from "../dist/http/hardening.js";
import {
  MAX_CACHED_CHALLENGES,
  __resetChallengesForTests,
  cachedChallengeCount,
  issueLoginChallenge,
} from "../dist/auth/challenge.js";

const WALLET = "0x1111111111111111111111111111111111111111";

describe("rate-limit buckets", () => {
  it("classifies abusable surfaces separately and exempts health probes", () => {
    assert.equal(bucketFor("GET", "/health/ready"), null);
    assert.equal(bucketFor("POST", "/auth/challenge"), "auth");
    assert.equal(bucketFor("GET", "/auth/challenge"), "auth");
    assert.equal(bucketFor("GET", "/tx/:hash/status"), "chain-read");
    assert.equal(bucketFor("GET", "/deals/:dealId/confirmation"), "chain-read");
    assert.equal(bucketFor("POST", "/drafts"), "draft-create");
    assert.equal(bucketFor("POST", "/drafts/:id/signatures"), "write");
    assert.equal(bucketFor("GET", "/drafts/:id/terms"), "read");
  });

  it("reads per-bucket overrides from env and ignores junk", () => {
    const limits = rateLimitsFromEnv({ RATE_LIMIT_AUTH: "5", RATE_LIMIT_READ: "abc" });
    assert.equal(limits.auth, 5);
    assert.equal(limits.read, 600);
  });

  it("allows up to the limit per window, then reports retry-after", () => {
    const limiter = new RateLimiter({ auth: 2, "chain-read": 1, "draft-create": 1, write: 1, read: 1 });
    const t0 = 1_000_000;
    assert.equal(limiter.hit("1.1.1.1", "auth", t0), 0);
    assert.equal(limiter.hit("1.1.1.1", "auth", t0 + 1), 0);
    assert.equal(limiter.hit("1.1.1.1", "auth", t0 + 2_000), 58);
    assert.equal(limiter.hit("2.2.2.2", "auth", t0 + 2_000), 0, "per client");
    assert.equal(limiter.hit("1.1.1.1", "read", t0 + 2_000), 0, "per bucket");
    assert.equal(limiter.hit("1.1.1.1", "auth", t0 + 60_000), 0, "window resets");
  });
});

describe("server hardening", () => {
  it("returns 429 with retry-after once the auth bucket is exhausted", async () => {
    const prev = process.env["RATE_LIMIT_AUTH"];
    process.env["RATE_LIMIT_AUTH"] = "3";
    try {
      const app = buildServer({ auth: false, rateLimit: true });
      await app.ready();
      const hit = () => app.inject({ method: "GET", url: `/auth/challenge?wallet=${WALLET}` });
      for (let i = 0; i < 3; i++) assert.equal((await hit()).statusCode, 200);
      const limited = await hit();
      assert.equal(limited.statusCode, 429);
      assert.ok(Number(limited.headers["retry-after"]) > 0);
      assert.equal(limited.json().bucket, "auth");
      // Health probes are never limited.
      assert.equal((await app.inject({ method: "GET", url: "/health/live" })).statusCode, 200);
      await app.close();
    } finally {
      if (prev === undefined) delete process.env["RATE_LIMIT_AUTH"];
      else process.env["RATE_LIMIT_AUTH"] = prev;
    }
  });

  it("sets security headers on every response", async () => {
    const app = buildServer({ auth: false, rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
    await app.close();
  });

  it("parses proxy trust and keeps logging off outside production by default", () => {
    assert.equal(trustProxyFromEnv({}), false);
    assert.equal(trustProxyFromEnv({ TRUST_PROXY: "true" }), true);
    assert.deepEqual(trustProxyFromEnv({ TRUST_PROXY: "127.0.0.1, 172.16.0.0/12" }), ["127.0.0.1", "172.16.0.0/12"]);
    assert.equal(loggerFromEnv({}), false);
    const logger = loggerFromEnv({ NODE_ENV: "production" });
    assert.equal(logger.level, "info");
    const req = logger.serializers.req({ method: "GET", url: "/auth/challenge?wallet=0xabc&token=secret", ip: "1.2.3.4" });
    assert.equal(req.url, "/auth/challenge", "query strings never reach logs");
  });
});

describe("login challenge cache", () => {
  it("is bounded: unauthenticated issuance cannot grow memory without limit", () => {
    __resetChallengesForTests();
    const now = Math.floor(Date.now() / 1_000);
    for (let i = 0; i < MAX_CACHED_CHALLENGES + 50; i++) {
      issueLoginChallenge({ domain: "midman.local", chainId: 8453, wallet: WALLET, nowSeconds: now });
    }
    assert.ok(cachedChallengeCount() <= MAX_CACHED_CHALLENGES);
    __resetChallengesForTests();
  });
});
