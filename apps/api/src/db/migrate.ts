// Migration entrypoint. Requires DATABASE_URL. Uses the shared, tracked
// migration runner from @midman/store (idempotent, transaction-per-migration,
// records ids in `schema_migrations`), covering all app + evidence tables.
import { runMigrations, defaultMigrations } from "@midman/store";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set; skipping migrations (degraded mode).");
  process.exit(0);
}
const { Client } = await import("pg");
// Single connection: the runner issues BEGIN/COMMIT, which requires one
// session (a Pool would send statements to different connections).
const client = new Client({ connectionString: url });
await client.connect();
const executor = { query: (text: string, params?: unknown[]) => client.query(text, params) };
const applied = await runMigrations(executor, defaultMigrations());
console.log(JSON.stringify({ migrationsApplied: applied }));
await client.end();
