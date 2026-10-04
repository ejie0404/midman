// Migration entrypoint. Requires DATABASE_URL. Uses the shared, tracked
// migration runner from @midman/store (idempotent, transaction-per-migration,
// records ids in `schema_migrations`), covering all app + evidence tables.
import { runMigrations, defaultMigrations } from "@midman/store";

interface PgClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

type PgClientConstructor = new (config: { connectionString: string }) => PgClient;

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set; skipping migrations (degraded mode).");
  process.exit(0);
}
// `pg` is CommonJS and exposes its singleton through module.exports, so the
// value lives on the module default (named exports are not runtime-resolvable).
const pgModule = (await import("pg")) as unknown as {
  default?: { Client?: PgClientConstructor };
  Client?: PgClientConstructor;
};
const Client = pgModule.default?.Client ?? pgModule.Client;
if (!Client) throw new Error('the "pg" driver exposed no Client constructor');
// Single connection: the runner issues BEGIN/COMMIT, which requires one
// session (a Pool would send statements to different connections).
const client = new Client({ connectionString: url });
await client.connect();
const executor = { query: <T>(text: string, params?: unknown[]) => client.query<T>(text, params) };
const applied = await runMigrations(executor, defaultMigrations());
console.log(JSON.stringify({ migrationsApplied: applied }));
await client.end();
