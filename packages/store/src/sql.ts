// Narrow SQL execution boundary for @midman/store.
//
// The package declares the real `pg` driver as a dependency (not an optional
// peer): production construction from a connection string always opens a
// bounded pg.Pool with a connection timeout. A structural `PoolLike` may still
// be injected for unit tests, but the driver is never optional and the package
// no longer loads "pg" through a non-resolvable specifier.
//
// `PgExecutor.withTransaction(fn)` runs `fn` on a single checked-out client
// between BEGIN/COMMIT (ROLLBACK on error) so multi-statement invariants
// (invitation redemption, signature merges, manifest sequencing, leases) are
// atomic. `close()` releases the pool for graceful shutdown.
export interface SqlResult<T> {
  rows: T[];
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
  /** Optional atomic scope. Present on PgExecutor; absent on trivial fakes. */
  withTransaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Optional graceful shutdown (releases the underlying pool). */
  close?(): Promise<void>;
}

/** Minimal structural view of a checked-out pg client. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release?(): void;
}

/** Minimal structural view of a driver pool we rely on. */
export interface PoolLike {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  connect?(): Promise<SqlClient>;
  end?(): Promise<void>;
}

export interface PgExecutorOptions {
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

/** Default pool ceiling when PG_POOL_MAX is unset. */
export const DEFAULT_PG_POOL_MAX = 10;
/** Default connect timeout (ms) when PG_CONNECT_TIMEOUT_MS is unset. */
export const DEFAULT_PG_CONNECT_TIMEOUT_MS = 10_000;

export interface PgPoolConfig {
  connectionString: string;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

type PgPoolConstructor = new (config: PgPoolConfig) => PoolLike;

let cachedPoolConstructor: PgPoolConstructor | null = null;

/**
 * Resolve the real pg.Pool constructor. `pg` is CommonJS and exports its
 * singleton through `module.exports`, so the value is read from the module
 * default (with a named fallback for bundlers). The result is cached.
 */
async function loadPgPool(): Promise<PgPoolConstructor> {
  if (cachedPoolConstructor) return cachedPoolConstructor;
  const mod = (await import("pg")) as unknown as {
    default?: { Pool?: PgPoolConstructor };
    Pool?: PgPoolConstructor;
  };
  const Pool = mod.default?.Pool ?? mod.Pool;
  if (!Pool) throw new Error('the "pg" driver was loaded but exposed no Pool constructor');
  cachedPoolConstructor = Pool;
  return Pool;
}

function isPoolLike(value: unknown): value is PoolLike {
  return typeof value === "object" && value !== null && typeof (value as PoolLike).query === "function";
}

/**
 * SqlExecutor backed by a pg Pool. Accepts either an already-constructed
 * PoolLike (test injection) or a connection string, in which case a bounded
 * pg.Pool is created on first use.
 */
export class PgExecutor implements SqlExecutor {
  private pool: PoolLike | null = null;
  private poolPromise: Promise<PoolLike> | null = null;

  constructor(
    private readonly source: PoolLike | string,
    private readonly options: PgExecutorOptions = {},
  ) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>> {
    const pool = await this.ensurePool();
    const result = await pool.query<T>(text, params);
    return { rows: result.rows };
  }

  async withTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const pool = await this.ensurePool();
    if (typeof pool.connect !== "function") {
      throw new Error("configured pool does not support transactions (no connect())");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Nested transactions are not supported: a tx handle only exposes query.
      const tx: SqlExecutor = { query: (text, params) => client.query(text, params) };
      const value = await fn(tx);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Best-effort rollback: the original error is what matters.
      }
      throw error;
    } finally {
      client.release?.();
    }
  }

  /** Release the pool. Safe to call more than once. */
  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.poolPromise = null;
    if (pool && typeof pool.end === "function") await pool.end();
  }

  private ensurePool(): Promise<PoolLike> {
    if (this.pool) return Promise.resolve(this.pool);
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        if (isPoolLike(this.source)) {
          this.pool = this.source;
          return this.source;
        }
        const Pool = await loadPgPool();
        const config: PgPoolConfig = {
          connectionString: this.source,
          ...(this.options.max !== undefined ? { max: this.options.max } : {}),
          ...(this.options.connectionTimeoutMillis !== undefined
            ? { connectionTimeoutMillis: this.options.connectionTimeoutMillis }
            : {}),
          ...(this.options.idleTimeoutMillis !== undefined
            ? { idleTimeoutMillis: this.options.idleTimeoutMillis }
            : {}),
        };
        const pool = new Pool(config);
        this.pool = pool;
        return pool;
      })();
    }
    return this.poolPromise;
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
export function createPgExecutor(connectionString: string, options: PgExecutorOptions = {}): PgExecutor {
  return new PgExecutor(connectionString, options);
}

/** Pool sizing resolved from the environment (PG_POOL_MAX, PG_CONNECT_TIMEOUT_MS). */
export function pgExecutorOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PgExecutorOptions {
  const rawMax = Number(env["PG_POOL_MAX"]);
  const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_PG_POOL_MAX;
  const rawTimeout = Number(env["PG_CONNECT_TIMEOUT_MS"]);
  const connectionTimeoutMillis =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : DEFAULT_PG_CONNECT_TIMEOUT_MS;
  const options: PgExecutorOptions = { max, connectionTimeoutMillis };
  return options;
}
