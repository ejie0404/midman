import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { closeStore, createRegistry, hasAuthStateStore, hasKvStore, migrateStore } from "@midman/store";
import { loadConfig, type AppConfig } from "./config.js";
import { createStoreFromEnv, type Store } from "./db.js";
import { buildDeps, registerRoutes, type RouteDeps } from "./routes.js";
import { registerDealMetaRoutes } from "./dealsMeta.js";
import { registerEvidenceRoutes } from "./evidence/routes.js";
import { registerAuthGuards, registerAuthRoutes } from "./auth/middleware.js";
import { createStoreAuthPersistence, setAuthPersistence } from "./auth/persistence.js";
import { hydrateSessionRevocations } from "./auth/session.js";
import {
  registerCategoryRoutes,
  registerMessageRoutes,
  registerCommitmentRoutes,
} from "./categories/routes.js";
import { registerReviewRoutes } from "./review/routes.js";
import { configureRegistry as configureEvidenceRegistry } from "./evidence/registry.js";
import { configureRegistry as configureCategoryRegistry } from "./categories/registry.js";
import { configureRegistry as configureReviewRegistry } from "./review/registry.js";
import { configureRegistry as configureApprovals } from "./review/approvals.js";
import { configureRegistry as configureProposals } from "./review/proposals.js";
import { configureRegistry as configureAwards } from "./review/awards.js";

export interface ServerOptions {
  /**
   * Enforce wallet session auth + authorization guards. Defaults to true when
   * NODE_ENV=production or MIDMAN_AUTH_ENFORCE=1, otherwise false so local
   * development and the existing (auth-agnostic) unit tests keep working.
   */
  readonly auth?: boolean;
  /**
   * A single configured store to share between routes and durable registries.
   * When omitted the server opens one via createStoreFromEnv(). Passing the
   * store in is what guarantees API instance B reads A's committed writes.
   */
  readonly store?: Store;
  /** Run store migrations on boot. Defaults to true when DATABASE_URL is set. */
  readonly runMigrations?: boolean;
}

/**
 * Attach the store-backed registry adapter to every in-memory metadata
 * registry (evidence, delivery forms, messages, review, approvals,
 * proposals) and rehydrate prior state. No-op when the store has no kv
 * backend, so behavior is unchanged there.
 */
export async function configureDurableRegistries(store: Store): Promise<boolean> {
  if (!hasKvStore(store)) return false;
  const adapter = createRegistry(store);
  const dealIds = await store.listDealIds();
  await Promise.all([
    configureEvidenceRegistry(adapter, dealIds),
    configureCategoryRegistry(adapter, dealIds),
    configureReviewRegistry(adapter, dealIds),
    configureApprovals(adapter, dealIds),
    configureProposals(adapter, dealIds),
    configureAwards(adapter, dealIds),
  ]);
  return true;
}

/**
 * Build the HTTP server around ONE store. All route deps and (via
 * buildServerAsync) the durable registries share that instance; there is no
 * second pool. Synchronous so the existing tests can call buildServer()
 * directly.
 */
export function buildServer(options: ServerOptions = {}) {
  const config = loadConfig();
  const store = options.store ?? createStoreFromEnv();
  const deps = buildDeps(store);
  const app = Fastify({ logger: false });

  const enforceAuth =
    options.auth ?? (process.env["MIDMAN_AUTH_ENFORCE"] === "1" || process.env["NODE_ENV"] === "production");

  // Guards must be registered before the routes they protect.
  if (enforceAuth) registerAuthGuards(app, deps);

  registerRoutes(app, deps);
  registerDealMetaRoutes(app);
  registerEvidenceRoutes(app, deps);
  registerCategoryRoutes(app, deps);
  registerMessageRoutes(app, deps);
  registerCommitmentRoutes(app, deps);
  registerReviewRoutes(app, deps);
  registerAuthRoutes(app, deps);

  app.get("/health", async () => ({
    ok: true,
    degraded: config.databaseUrl === null || config.redisUrl === null || !deps.rpcConfigured || !deps.hub,
    chainId: config.chainId,
    rpc: deps.rpcConfigured,
    hub: deps.hub,
  }));

  // Liveness: the process is running. Readiness (below) decides traffic.
  app.get("/health/live", async () => ({ ok: true }));

  // Readiness: safe to receive production traffic. 200 only when every
  // critical dependency is configured; otherwise 503 with the missing list
  // so orchestrators route around this instance.
  app.get("/health/ready", async (_req, reply) => {
    const readiness = checkReadiness(deps, config);
    if (!readiness.ready) return reply.code(503).send(readiness);
    return readiness;
  });

  return app;
}

/**
 * Production readiness: database (production only — dev memory store is an
 * explicit local choice), chain id, RPC providers, hub, and malware
 * scanning (a real scanner or the explicit EVIDENCE_ALLOW_DEFERRED=1
 * development opt-in, never set in production).
 */
export function checkReadiness(
  deps: Pick<RouteDeps, "hub">,
  config: Pick<AppConfig, "databaseUrl" | "chainId" | "rpcUrls">,
): { ready: boolean; missing: string[]; checks: Record<string, boolean> } {
  const production = process.env["NODE_ENV"] === "production";
  const checks: Record<string, boolean> = {
    database: production ? config.databaseUrl !== null : true,
    chainId:
      typeof config.chainId === "number" && Number.isInteger(config.chainId) && (config.chainId as number) > 0,
    rpc: config.rpcUrls.length > 0,
    hub: deps.hub !== null,
    scanner:
      (process.env["CLAMAV_HOST"] ?? "").trim() !== "" || process.env["EVIDENCE_ALLOW_DEFERRED"] === "1",
  };
  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return { ready: missing.length === 0, missing, checks };
}

/**
 * Build + migrate + hydrate durable registries, all over a single store. Used
 * by the CLI/worker boot path. Migrations are opt-in per env (skipped when
 * MIDMAN_RUN_MIGRATIONS=0 or DATABASE_URL is unset).
 */
export async function buildServerAsync(options: ServerOptions = {}) {
  const config = loadConfig();
  const store = options.store ?? createStoreFromEnv();
  const runMigrations =
    options.runMigrations ?? (config.databaseUrl !== null && process.env["MIDMAN_RUN_MIGRATIONS"] !== "0");
  let migrationsApplied: string[] = [];
  if (runMigrations) migrationsApplied = await migrateStore(store);
  // Durable auth state (challenges, nonces, session revocations, invitations)
  // when a kv-capable store is configured; in-memory otherwise.
  let durableAuth = false;
  if (hasAuthStateStore(store)) {
    setAuthPersistence(createStoreAuthPersistence(store));
    await hydrateSessionRevocations();
    durableAuth = true;
  }
  const durableRegistries = await configureDurableRegistries(store);
  const app = buildServer({ ...options, store });
  return { app, config, store, durableRegistries, durableAuth, migrationsApplied };
}

/** Graceful shutdown: close HTTP then release the pool exactly once. */
export function installShutdownHandlers(
  app: { close(): Promise<void> },
  store: Store,
  exit: (code: number) => void = (code) => process.exit(code),
): () => Promise<void> {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } finally {
      await closeStore(store);
      exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  return shutdown;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildServerAsync({ auth: true })
    .then(async ({ app, config, store }) => {
      installShutdownHandlers(app, store);
      await app.listen({ port: config.port, host: "0.0.0.0" });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
