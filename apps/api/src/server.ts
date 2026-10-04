import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { createRegistry, hasKvStore } from "@midman/store";
import { loadConfig } from "./config.js";
import { createStore, type Store } from "./db.js";
import { buildDeps, registerRoutes } from "./routes.js";
import { registerEvidenceRoutes } from "./evidence/routes.js";
import { registerAuthGuards, registerAuthRoutes } from "./auth/middleware.js";
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

export interface ServerOptions {
  /**
   * Enforce wallet session auth + authorization guards. Defaults to true when
   * NODE_ENV=production or MIDMAN_AUTH_ENFORCE=1, otherwise false so local
   * development and the existing (auth-agnostic) unit tests keep working.
   */
  readonly auth?: boolean;
}

/**
 * Attach the store-backed registry adapter to every in-memory metadata
 * registry (evidence, delivery forms, messages, review, approvals,
 * proposals) and rehydrate prior state. No-op when the store has no kv
 * backend (dev MemoryStore), so behavior is unchanged there.
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
  ]);
  return true;
}

export function buildServer(options: ServerOptions = {}) {
  const config = loadConfig();
  const store = createStore();
  const deps = buildDeps(store);
  const app = Fastify({ logger: false });

  const enforceAuth =
    options.auth ?? (process.env["MIDMAN_AUTH_ENFORCE"] === "1" || process.env["NODE_ENV"] === "production");

  // Guards must be registered before the routes they protect.
  if (enforceAuth) registerAuthGuards(app, deps);

  registerRoutes(app, deps);
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

  return app;
}

/** Build + hydrate durable registries. Used by the CLI/worker boot path. */
export async function buildServerAsync(options: ServerOptions = {}) {
  const config = loadConfig();
  const store = createStore();
  if (hasKvStore(store)) {
    await configureDurableRegistries(store);
  }
  const app = buildServer(options);
  return { app, config, durableRegistries: hasKvStore(store) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildServerAsync({ auth: true })
    .then(({ app, config }) =>
      app.listen({ port: config.port, host: "0.0.0.0" }),
    )
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
