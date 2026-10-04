// Narrow SQL execution boundary for @midman/store.
//
// The package deliberately has no hard runtime dependency on a database
// driver: callers inject a SqlExecutor (dev/test use a fake), or call
// createPgExecutor(connectionString) which lazily loads "pg" on first use.
// Lazy loading (via a non-literal specifier) keeps this package compiling and
// loading even when "pg" is not installed, so only hosted environments that
// actually open Postgres need the driver present.

export interface SqlResult<T> {
  rows: T[];
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
}

/** Minimal structural view of a driver pool we rely on. */
export interface PoolLike {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type PgPoolConstructor = new (config: { connectionString: string }) => PoolLike;

function isPoolLike(value: unknown): value is PoolLike {
  return typeof value === "object" && value !== null && typeof (value as PoolLike).query === "function";
}

/**
 * SqlExecutor backed by a pg Pool. Accepts either an already-constructed
 * PoolLike (test injection) or a connection string, in which case the pool is
 * created on first query by dynamically importing "pg".
 */
export class PgExecutor implements SqlExecutor {
  private pool: PoolLike | null = null;

  constructor(private readonly source: PoolLike | string) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>> {
    const pool = await this.ensurePool();
    const result = await pool.query<T>(text, params);
    return { rows: result.rows };
  }

  private async ensurePool(): Promise<PoolLike> {
    if (this.pool) return this.pool;
    if (isPoolLike(this.source)) {
      this.pool = this.source;
      return this.pool;
    }
    // Non-literal specifier: TypeScript does not try to resolve "pg" at build
    // time, so the package type-checks without @types/pg installed.
    const specifier: string = "pg";
    let mod: { Pool?: PgPoolConstructor; default?: { Pool?: PgPoolConstructor } };
    try {
      mod = (await import(specifier)) as typeof mod;
    } catch (error) {
      throw new Error(
        `DATABASE_URL is set but the "pg" driver could not be loaded; install pg in the runtime package (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
    const Pool = mod.Pool ?? mod.default?.Pool;
    if (!Pool) throw new Error('Loaded "pg" but it exposed no Pool constructor');
    this.pool = new Pool({ connectionString: this.source });
    return this.pool;
  }
}

/** Wrap an existing pg.Pool (or any PoolLike) as a SqlExecutor. */
export function executorFromPool(pool: PoolLike): PgExecutor {
  return new PgExecutor(pool);
}

/**
 * Create a Postgres executor for a connection string. Synchronous: the pool is
 * opened lazily on first query so this is safe to call from createStore().
 */
export function createPgExecutor(connectionString: string): PgExecutor {
  return new PgExecutor(connectionString);
}
