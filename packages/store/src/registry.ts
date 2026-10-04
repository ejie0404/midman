// Storage-agnostic registry layer (audit finding #4, part 2).
//
// Evidence manifests, delivery forms, message threads, review cases, quorum
// approvals and settlement proposals used to live only in process-wide
// module singletons: a restart after the Store became Postgres-backed still
// lost them. This module is the single durability boundary for that metadata.
//
// `RegistryAdapter` is a tiny namespaced key/value contract. Two adapters
// implement it:
//   * `MemoryRegistry`  — a plain Map (dev/test; also the fallback).
//   * `SqlRegistry`     — delegates to a Store-like executor over the
//                         `registry_kv(deal_id, ns, key, value jsonb, ...)`
//                         table. `value` is JSON, so every stored record MUST
//                         be JSON-serializable (no bigint/Date/class instances).
//
// App registries keep their synchronous in-memory API; they attach a
// `RegistryWriter` that write-throughs to the adapter in the background.
// `configureRegistry(adapter)` (wired in server.ts) switches them to durable
// mode; without it they behave exactly as before.
//
// The Store kv methods this file needs (implemented by the parallel PgStore
// and/or the in-memory store) are declared by `RegistryKvStore`. Parameter
// order mirrors `RegistryAdapter` — `(ns, dealId, key)`:
//   kvGet(ns, dealId, key)                 -> unknown | null
//   kvList(ns, dealId)                     -> { key, value }[]  (key ordered)
//   kvPut(ns, dealId, key, value)          -> void
//   kvDelete(ns, dealId, key)              -> void
//   kvDeals?(ns)                           -> string[]         (optional)

export type RegistryBacking = Map<string, Map<string, Map<string, unknown>>>;

/** Namespaced key/value durability contract. This is the single boundary. */
export interface RegistryAdapter {
  get<T>(ns: string, dealId: string, key: string): Promise<T | null>;
  list<T>(ns: string, dealId: string): Promise<T[]>;
  put<T>(ns: string, dealId: string, key: string, value: T): Promise<void>;
  delete(ns: string, dealId: string, key: string): Promise<void>;
  /**
   * Optional namespace-wide deal enumeration: enables full rehydration after a
   * restart. PgStore can implement this as `select distinct deal_id ...`.
   */
  listDeals?(ns: string): Promise<string[]>;
}

/** Ordered key helper for append-only sequences (manifest seq, message seq…). */
export function orderedKey(n: number): string {
  return String(n).padStart(12, "0");
}

/** In-memory Map adapter. Pass a shared backing to simulate a restart. */
export class MemoryRegistry implements RegistryAdapter {
  private readonly backing: RegistryBacking;

  constructor(backing: RegistryBacking = new Map()) {
    this.backing = backing;
  }

  private nsMap(ns: string, create: boolean): Map<string, Map<string, unknown>> | undefined {
    let map = this.backing.get(ns);
    if (!map && create) {
      map = new Map();
      this.backing.set(ns, map);
    }
    return map;
  }

  private dealMap(ns: string, dealId: string, create: boolean): Map<string, unknown> | undefined {
    const nsMap = this.nsMap(ns, create);
    if (!nsMap) return undefined;
    let deal = nsMap.get(dealId);
    if (!deal && create) {
      deal = new Map();
      nsMap.set(dealId, deal);
    }
    return deal;
  }

  async get<T>(ns: string, dealId: string, key: string): Promise<T | null> {
    const value = this.dealMap(ns, dealId, false)?.get(key);
    return value === undefined ? null : (value as T);
  }

  async list<T>(ns: string, dealId: string): Promise<T[]> {
    return [...(this.dealMap(ns, dealId, false)?.values() ?? [])] as T[];
  }

  async put<T>(ns: string, dealId: string, key: string, value: T): Promise<void> {
    this.dealMap(ns, dealId, true)!.set(key, value);
  }

  async delete(ns: string, dealId: string, key: string): Promise<void> {
    this.dealMap(ns, dealId, false)?.delete(key);
  }

  async listDeals(ns: string): Promise<string[]> {
    return [...(this.nsMap(ns, false)?.keys() ?? [])];
  }
}

/**
 * The kv methods a durable Store must expose for `SqlRegistry`. The parallel
 * PgStore agent is adding these; when the store lacks them `SqlRegistry` (and
 * `createRegistry`) transparently use an in-memory fallback.
 */
export interface RegistryKvStore {
  kvGet(ns: string, dealId: string, key: string): Promise<unknown | null>;
  kvList(ns: string, dealId: string): Promise<Array<{ key: string; value: unknown }>>;
  kvPut(ns: string, dealId: string, key: string, value: unknown): Promise<void>;
  kvDelete(ns: string, dealId: string, key: string): Promise<void>;
  kvDeals?(ns: string): Promise<string[]>;
}

/** True when a Store-like object exposes the full registry kv surface. */
export function hasKvStore(store: unknown): store is RegistryKvStore {
  if (!store || typeof store !== "object") return false;
  const candidate = store as Partial<RegistryKvStore>;
  return (
    typeof candidate.kvGet === "function" &&
    typeof candidate.kvList === "function" &&
    typeof candidate.kvPut === "function" &&
    typeof candidate.kvDelete === "function"
  );
}

/** JSONB-backed adapter delegating to a Store-like executor. */
export class SqlRegistry implements RegistryAdapter {
  private readonly fallback = new MemoryRegistry();

  constructor(private readonly store: RegistryKvStore) {}

  private get durable(): boolean {
    return hasKvStore(this.store);
  }

  async get<T>(ns: string, dealId: string, key: string): Promise<T | null> {
    if (!this.durable) return this.fallback.get<T>(ns, dealId, key);
    const value = await this.store.kvGet(ns, dealId, key);
    return value === null || value === undefined ? null : (value as T);
  }

  async list<T>(ns: string, dealId: string): Promise<T[]> {
    if (!this.durable) return this.fallback.list<T>(ns, dealId);
    const rows = await this.store.kvList(ns, dealId);
    return rows.map((row) => row.value as T);
  }

  async put<T>(ns: string, dealId: string, key: string, value: T): Promise<void> {
    if (!this.durable) {
      await this.fallback.put(ns, dealId, key, value);
      return;
    }
    await this.store.kvPut(ns, dealId, key, value);
  }

  async delete(ns: string, dealId: string, key: string): Promise<void> {
    if (!this.durable) {
      await this.fallback.delete(ns, dealId, key);
      return;
    }
    await this.store.kvDelete(ns, dealId, key);
  }

  async listDeals(ns: string): Promise<string[]> {
    if (!this.durable) return this.fallback.listDeals(ns);
    if (typeof this.store.kvDeals === "function") return this.store.kvDeals(ns);
    return [];
  }
}

/** Selects a durable adapter when the Store exposes kv methods, else memory. */
export function createRegistry(store: unknown): RegistryAdapter {
  return hasKvStore(store) ? new SqlRegistry(store) : new MemoryRegistry();
}

/**
 * Serialized background write queue used by the app registries. Sync mutating
 * methods update their in-memory cache and enqueue the durable write; async
 * methods may await the returned promise. `flush()` lets tests await quiescence.
 */
export class RegistryWriter {
  private adapter: RegistryAdapter | null;
  private tail: Promise<void> = Promise.resolve();

  constructor(adapter: RegistryAdapter | null = null) {
    this.adapter = adapter;
  }

  get durable(): boolean {
    return this.adapter !== null;
  }

  getAdapter(): RegistryAdapter | null {
    return this.adapter;
  }

  setAdapter(adapter: RegistryAdapter | null): void {
    this.adapter = adapter;
  }

  put<T>(ns: string, dealId: string, key: string, value: T): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return Promise.resolve();
    // Swallow + log so fire-and-forget callers never surface an unhandled
    // rejection; the in-memory cache remains authoritative for this session.
    const task = this.tail
      .then(() => adapter.put(ns, dealId, key, value))
      .catch((error) => {
        console.error(`[registry] durable put failed (${ns}/${dealId}/${key}):`, error);
      });
    this.tail = task;
    return task;
  }

  delete(ns: string, dealId: string, key: string): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return Promise.resolve();
    const task = this.tail
      .then(() => adapter.delete(ns, dealId, key))
      .catch((error) => {
        console.error(`[registry] durable delete failed (${ns}/${dealId}/${key}):`, error);
      });
    this.tail = task;
    return task;
  }

  deleteAll(ns: string, dealId: string, keys: Iterable<string>): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return Promise.resolve();
    const snapshot = [...keys];
    const task = this.tail
      .then(async () => {
        for (const key of snapshot) await adapter.delete(ns, dealId, key);
      })
      .catch((error) => {
        console.error(`[registry] durable deleteAll failed (${ns}/${dealId}):`, error);
      });
    this.tail = task;
    return task;
  }

  /** Resolves once every queued durable write has settled. */
  async flush(): Promise<void> {
    await this.tail;
  }
}

/**
 * Load one namespace into an in-memory cache. When `dealIds` is omitted the
 * adapter's `listDeals` is used (MemoryRegistry always supports it; SqlRegistry
 * needs `kvDeals` on the store, otherwise callers pass explicit deal ids).
 */
export async function hydrateNamespace<T>(
  adapter: RegistryAdapter | null,
  ns: string,
  dealIds: string[] | undefined,
  apply: (dealId: string, values: T[]) => void,
): Promise<void> {
  if (!adapter) return;
  const ids = dealIds ?? (adapter.listDeals ? await adapter.listDeals(ns) : []);
  for (const dealId of ids) {
    const values = await adapter.list<T>(ns, dealId);
    if (values.length > 0) apply(dealId, values);
  }
}

/**
 * Generic per-deal collection: synchronous cache reads + write-through to the
 * adapter. `keyOf` lets hydration recover each entry's storage key from its
 * value (values are what `list()` returns).
 */
export class DurableCollection<T> {
  private readonly cache = new Map<string, Map<string, T>>();

  constructor(
    private readonly ns: string,
    private readonly writer: RegistryWriter,
    private readonly keyOf: (value: T) => string,
  ) {}

  private deal(dealId: string, create: boolean): Map<string, T> | undefined {
    let map = this.cache.get(dealId);
    if (!map && create) {
      map = new Map();
      this.cache.set(dealId, map);
    }
    return map;
  }

  get(dealId: string, key: string): T | null {
    return this.deal(dealId, false)?.get(key) ?? null;
  }

  list(dealId: string): T[] {
    return [...(this.deal(dealId, false)?.values() ?? [])];
  }

  entries(dealId: string): Array<[string, T]> {
    return [...(this.deal(dealId, false)?.entries() ?? [])];
  }

  keys(dealId: string): string[] {
    return [...(this.deal(dealId, false)?.keys() ?? [])];
  }

  size(dealId: string): number {
    return this.deal(dealId, false)?.size ?? 0;
  }

  dealIds(): string[] {
    return [...this.cache.keys()];
  }

  set(dealId: string, key: string, value: T): Promise<void> {
    this.deal(dealId, true)!.set(key, value);
    return this.writer.put(this.ns, dealId, key, value);
  }

  delete(dealId: string, key: string): Promise<void> {
    this.deal(dealId, false)?.delete(key);
    return this.writer.delete(this.ns, dealId, key);
  }

  clearDeal(dealId: string): Promise<void> {
    const keys = this.keys(dealId);
    this.cache.delete(dealId);
    return this.writer.deleteAll(this.ns, dealId, keys);
  }

  clear(): void {
    this.cache.clear();
  }

  async hydrate(dealIds?: string[]): Promise<void> {
    const adapter = this.writer.getAdapter();
    if (!adapter) return;
    const ids = dealIds ?? (adapter.listDeals ? await adapter.listDeals(this.ns) : []);
    for (const dealId of ids) {
      const values = await adapter.list<T>(this.ns, dealId);
      if (values.length === 0) continue;
      const map = new Map<string, T>();
      for (const value of values) map.set(this.keyOf(value), value);
      this.cache.set(dealId, map);
    }
  }
}
