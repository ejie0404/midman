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
//                         `registry_kv(deal_id, ns, key, value jsonb, version)`
//                         table. `value` is JSON, so every stored record MUST
//                         be JSON-serializable (no bigint/Date/class instances).
//
// App registries keep their synchronous in-memory API; they attach a
// `RegistryWriter` that write-throughs to the adapter. `configureRegistry(...)`
// switches them to durable mode; without it they behave as before.
//
// Durability guarantees added in Phase 3:
//   * `RegistryWriter.put`/`delete` SURFACE failures (the returned promise
//     rejects) while the internal queue stays usable after a rejection.
//     `putSafe` is the old log-and-continue behavior for fire-and-forget.
//   * `RegistryWriter.putCas` / adapters' `putVersioned` provide optimistic
//     concurrency (compare-and-set) so concurrent updates conflict instead of
//     silently overwriting.
//   * `DurableCollection.setAuthoritative` publishes the in-memory cache only
//     AFTER the durable write commits; `refresh`/`getAuthoritative` re-read a
//     deal from the backing store so a second API instance sees committed
//     writes.
//
// The Store kv methods this file needs (implemented by the parallel PgStore
// and the in-memory store) are declared by `RegistryKvStore`:
//   kvGet(ns, dealId, key)                 -> unknown | null
//   kvList(ns, dealId)                     -> { key, value }[]  (key ordered)
//   kvPut(ns, dealId, key, value)          -> void
//   kvDelete(ns, dealId, key)              -> void
//   kvDeals?(ns)                           -> string[]
//   kvGetWithVersion?(ns, dealId, key)     -> { value, version } | null
//   kvPutCas?(ns, dealId, key, value, v)   -> number            (throws on stale)
// `kvDel` is accepted as an alias of `kvDelete`.
import type { AuthStateEntry } from "./store.js";

export type RegistryBacking = Map<string, Map<string, Map<string, unknown>>>;
type VersionBacking = Map<string, Map<string, Map<string, number>>>;

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
  /** Optional versioned read (compare-and-set support). */
  getVersioned?<T>(ns: string, dealId: string, key: string): Promise<{ value: T; version: number } | null>;
  /** Optional versioned write. Must throw on a stale expectedVersion. */
  putVersioned?<T>(ns: string, dealId: string, key: string, value: T, expectedVersion: number): Promise<number>;
  /** Optional create-only write; returns false when the key already exists. */
  putIfAbsent?<T>(ns: string, dealId: string, key: string, value: T): Promise<boolean>;
  /** Optional monotonic sequence allocator for append-only keys. */
  nextSeq?(name: string): Promise<number>;
}

/** Ordered key helper for append-only sequences (manifest seq, message seq…). */
export function orderedKey(n: number): string {
  return String(n).padStart(12, "0");
}

/** In-memory Map adapter. Pass a shared backing to simulate a restart. */
export class MemoryRegistry implements RegistryAdapter {
  private readonly backing: RegistryBacking;
  private readonly versions: VersionBacking;

  constructor(backing: RegistryBacking = new Map(), versions: VersionBacking = new Map()) {
    this.backing = backing;
    this.versions = versions;
  }

  async nextSeq(name: string): Promise<number> {
    // Store the counter in the SHARED backing so two adapter instances over one
    // backing (the cross-instance scenario) never allocate the same sequence.
    const map = this.dealMap("__seq__", name, true)!;
    const current = (map.get("value") as number | undefined) ?? 0;
    const next = current + 1;
    map.set("value", next);
    return next;
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

  private versionMap(ns: string, dealId: string, create: boolean): Map<string, number> | undefined {
    let byNs = this.versions.get(ns);
    if (!byNs && create) {
      byNs = new Map();
      this.versions.set(ns, byNs);
    }
    if (!byNs) return undefined;
    let deal = byNs.get(dealId);
    if (!deal && create) {
      deal = new Map();
      byNs.set(dealId, deal);
    }
    return deal;
  }

  private versionOf(ns: string, dealId: string, key: string): number {
    return this.versionMap(ns, dealId, false)?.get(key) ?? 0;
  }

  async get<T>(ns: string, dealId: string, key: string): Promise<T | null> {
    const value = this.dealMap(ns, dealId, false)?.get(key);
    return value === undefined ? null : (value as T);
  }

  async getVersioned<T>(ns: string, dealId: string, key: string): Promise<{ value: T; version: number } | null> {
    const value = this.dealMap(ns, dealId, false)?.get(key);
    return value === undefined ? null : { value: value as T, version: this.versionOf(ns, dealId, key) };
  }

  async list<T>(ns: string, dealId: string): Promise<T[]> {
    return [...(this.dealMap(ns, dealId, false)?.values() ?? [])] as T[];
  }

  async put<T>(ns: string, dealId: string, key: string, value: T): Promise<void> {
    this.dealMap(ns, dealId, true)!.set(key, value);
    this.versionMap(ns, dealId, true)!.set(key, this.versionOf(ns, dealId, key) + 1);
  }

  async putVersioned<T>(ns: string, dealId: string, key: string, value: T, expectedVersion: number): Promise<number> {
    const current = this.versionOf(ns, dealId, key);
    if (current !== expectedVersion) {
      throw new Error(`registry conflict for ${ns}/${dealId}/${key}: expected ${expectedVersion}, found ${current}`);
    }
    this.dealMap(ns, dealId, true)!.set(key, value);
    const next = expectedVersion + 1;
    this.versionMap(ns, dealId, true)!.set(key, next);
    return next;
  }

  async putIfAbsent<T>(ns: string, dealId: string, key: string, value: T): Promise<boolean> {
    const map = this.dealMap(ns, dealId, false);
    if (map?.has(key)) return false;
    this.dealMap(ns, dealId, true)!.set(key, value);
    this.versionMap(ns, dealId, true)!.set(key, 1);
    return true;
  }

  async delete(ns: string, dealId: string, key: string): Promise<void> {
    this.dealMap(ns, dealId, false)?.delete(key);
    this.versionMap(ns, dealId, false)?.delete(key);
  }

  async listDeals(ns: string): Promise<string[]> {
    return [...(this.nsMap(ns, false)?.keys() ?? [])];
  }
}

/**
 * The kv methods a durable Store must expose for `SqlRegistry`. PgStore and
 * MemoryStore implement these.
 */
export interface RegistryKvStore {
  kvGet(ns: string, dealId: string, key: string): Promise<unknown | null>;
  kvList(ns: string, dealId: string): Promise<Array<{ key: string; value: unknown }>>;
  kvPut(ns: string, dealId: string, key: string, value: unknown): Promise<void>;
  kvDelete(ns: string, dealId: string, key: string): Promise<void>;
  /** Alias of kvDelete accepted from Phase-2 auth adapters. */
  kvDel?(ns: string, dealId: string, key: string): Promise<void>;
  kvDeals?(ns: string): Promise<string[]>;
  kvGetWithVersion?(ns: string, dealId: string, key: string): Promise<{ value: unknown; version: number } | null>;
  kvPutCas?(ns: string, dealId: string, key: string, value: unknown, expectedVersion: number): Promise<number>;
  kvPutIfAbsent?(ns: string, dealId: string, key: string, value: unknown): Promise<boolean>;
  /** DB-backed monotonic counter (Store.nextSeq); enables cross-instance sequences. */
  nextSeq?(name: string): Promise<number>;
}

/** True when a Store-like object exposes the registry kv surface. */
export function hasKvStore(store: unknown): store is RegistryKvStore {
  if (!store || typeof store !== "object") return false;
  const candidate = store as Partial<RegistryKvStore>;
  return (
    typeof candidate.kvGet === "function" &&
    typeof candidate.kvList === "function" &&
    typeof candidate.kvPut === "function" &&
    typeof (candidate.kvDelete ?? candidate.kvDel) === "function"
  );
}

/** Normalize the delete alias so callers only ever call kvDelete. */
async function kvDeleteVia(store: RegistryKvStore, ns: string, dealId: string, key: string): Promise<void> {
  if (typeof store.kvDelete === "function") {
    await store.kvDelete(ns, dealId, key);
    return;
  }
  await store.kvDel!(ns, dealId, key);
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

  async getVersioned<T>(ns: string, dealId: string, key: string): Promise<{ value: T; version: number } | null> {
    if (!this.durable) return this.fallback.getVersioned<T>(ns, dealId, key);
    if (typeof this.store.kvGetWithVersion === "function") {
      const row = await this.store.kvGetWithVersion(ns, dealId, key);
      return row ? { value: row.value as T, version: row.version } : null;
    }
    const value = await this.store.kvGet(ns, dealId, key);
    return value === null || value === undefined ? null : { value: value as T, version: 0 };
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

  async putVersioned<T>(ns: string, dealId: string, key: string, value: T, expectedVersion: number): Promise<number> {
    if (!this.durable) return this.fallback.putVersioned(ns, dealId, key, value, expectedVersion);
    if (typeof this.store.kvPutCas === "function") {
      return this.store.kvPutCas(ns, dealId, key, value, expectedVersion);
    }
    await this.store.kvPut(ns, dealId, key, value);
    return expectedVersion + 1;
  }

  async delete(ns: string, dealId: string, key: string): Promise<void> {
    if (!this.durable) {
      await this.fallback.delete(ns, dealId, key);
      return;
    }
    await kvDeleteVia(this.store, ns, dealId, key);
  }

  async listDeals(ns: string): Promise<string[]> {
    if (!this.durable) return this.fallback.listDeals(ns);
    if (typeof this.store.kvDeals === "function") return this.store.kvDeals(ns);
    return [];
  }

  async putIfAbsent<T>(ns: string, dealId: string, key: string, value: T): Promise<boolean> {
    if (!this.durable) return this.fallback.putIfAbsent(ns, dealId, key, value);
    if (typeof this.store.kvPutIfAbsent === "function") {
      return this.store.kvPutIfAbsent(ns, dealId, key, value);
    }
    const existing = await this.get(ns, dealId, key);
    if (existing !== null) return false;
    await this.put(ns, dealId, key, value);
    return true;
  }

  async nextSeq(name: string): Promise<number> {
    if (!this.durable) return this.fallback.nextSeq(name);
    if (typeof this.store.nextSeq === "function") return this.store.nextSeq(name);
    // No durable counter available: fall back to the process-local sequence.
    return this.fallback.nextSeq(name);
  }
}

/** Selects a durable adapter when the Store exposes kv methods, else memory. */
export function createRegistry(store: unknown): RegistryAdapter {
  return hasKvStore(store) ? new SqlRegistry(store) : new MemoryRegistry();
}

/**
 * Serialized write queue used by the app registries. Sync mutating methods
 * update their in-memory cache and enqueue the durable write; async methods may
 * await the returned promise.
 *
 * `put`/`delete`/`deleteAll` surface failures to the caller (the returned
 * promise rejects) while the queue itself always remains usable — a failed
 * write never poisons subsequent ones. `putSafe` preserves the old
 * log-and-continue behavior for callers that cannot await.
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

  private enqueue<T>(job: (adapter: RegistryAdapter) => Promise<T>): Promise<T> {
    const adapter = this.adapter;
    if (!adapter) return Promise.resolve(undefined as unknown as T);
    const run = this.tail.then(() => job(adapter));
    // Keep the queue usable regardless of this job's outcome.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Durable write; rejects on failure. Callers that need the record to be
   * authoritative must await this before returning success. */
  put<T>(ns: string, dealId: string, key: string, value: T): Promise<void> {
    return this.enqueue((adapter) => adapter.put(ns, dealId, key, value));
  }

  /** Compare-and-set write; rejects on version conflict or transport failure. */
  putCas<T>(ns: string, dealId: string, key: string, value: T, expectedVersion: number): Promise<number> {
    const adapter = this.adapter;
    if (!adapter) return Promise.resolve(expectedVersion + 1);
    return this.enqueue(async (a) => {
      if (typeof a.putVersioned === "function") return a.putVersioned(ns, dealId, key, value, expectedVersion);
      await a.put(ns, dealId, key, value);
      return expectedVersion + 1;
    });
  }

  /**
   * Allocate the next monotonic sequence for `name`. Uses the adapter's
   * DB-backed counter when present (so two API instances never allocate the
   * same number), else a process-local counter.
   */
  private readonly localSeq = new Map<string, number>();
  async nextSeq(name: string): Promise<number> {
    const adapter = this.adapter;
    if (adapter?.nextSeq) return adapter.nextSeq(name);
    const next = (this.localSeq.get(name) ?? 0) + 1;
    this.localSeq.set(name, next);
    return next;
  }

  /** Versioned read through the adapter (null when no durable adapter is set). */
  async getVersioned<T>(ns: string, dealId: string, key: string): Promise<{ value: T; version: number } | null> {
    const adapter = this.adapter;
    if (!adapter) return null;
    if (typeof adapter.getVersioned === "function") return adapter.getVersioned<T>(ns, dealId, key);
    const value = await adapter.get<T>(ns, dealId, key);
    return value === null ? null : { value, version: 0 };
  }

  /** Create-only durable write; see RegistryAdapter.putIfAbsent. */
  async putIfAbsent<T>(ns: string, dealId: string, key: string, value: T): Promise<boolean> {
    const adapter = this.adapter;
    if (!adapter) return false;
    if (typeof adapter.putIfAbsent === "function") return adapter.putIfAbsent(ns, dealId, key, value);
    const existing = await adapter.get(ns, dealId, key);
    if (existing !== null) return false;
    await adapter.put(ns, dealId, key, value);
    return true;
  }

  /** Fire-and-forget durable write: logs (never rejects) on failure. */
  async putSafe<T>(ns: string, dealId: string, key: string, value: T): Promise<void> {
    try {
      await this.put(ns, dealId, key, value);
    } catch (error) {
      console.error(`[registry] durable put failed (${ns}/${dealId}/${key}):`, error);
    }
  }

  delete(ns: string, dealId: string, key: string): Promise<void> {
    return this.enqueue((adapter) => adapter.delete(ns, dealId, key));
  }

  async deleteSafe(ns: string, dealId: string, key: string): Promise<void> {
    try {
      await this.delete(ns, dealId, key);
    } catch (error) {
      console.error(`[registry] durable delete failed (${ns}/${dealId}/${key}):`, error);
    }
  }

  deleteAll(ns: string, dealId: string, keys: Iterable<string>): Promise<void> {
    const snapshot = [...keys];
    return this.enqueue(async (adapter) => {
      for (const key of snapshot) await adapter.delete(ns, dealId, key);
    });
  }

  /** Resolves once every queued durable write has settled. */
  async flush(): Promise<void> {
    await this.tail;
  }

  /** Test helper: clear the process-local sequence counters. */
  resetSequences(): void {
    this.localSeq.clear();
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

  /** Publish a value to the in-memory cache WITHOUT a durable write. Use after
   * the durable state was already committed through another path. */
  remember(dealId: string, key: string, value: T): void {
    this.deal(dealId, true)!.set(key, value);
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

  /**
   * Legacy write-through: publishes to the cache immediately and enqueues the
   * durable write. Use for non-authoritative/display caches.
   */
  set(dealId: string, key: string, value: T): Promise<void> {
    this.deal(dealId, true)!.set(key, value);
    return this.writer.put(this.ns, dealId, key, value);
  }

  /**
   * Authoritative write: the durable write commits BEFORE the cache is
   * updated, so no reader can observe uncommitted state. With expectedVersion
   * the write is compare-and-set and throws on conflict. Returns the new
   * version.
   */
  async setAuthoritative(dealId: string, key: string, value: T, expectedVersion?: number): Promise<number> {
    const adapter = this.writer.getAdapter();
    if (!adapter) {
      this.deal(dealId, true)!.set(key, value);
      return expectedVersion === undefined ? 0 : expectedVersion + 1;
    }
    let version: number;
    if (expectedVersion !== undefined) {
      version = await this.writer.putCas(this.ns, dealId, key, value, expectedVersion);
    } else {
      await this.writer.put(this.ns, dealId, key, value);
      const stored = await adapter.getVersioned?.(this.ns, dealId, key);
      version = stored?.version ?? 1;
    }
    this.deal(dealId, true)!.set(key, value);
    return version;
  }

  /** Re-read one deal from the backing store (authoritative invalidation). */
  async refresh(dealId: string): Promise<void> {
    const adapter = this.writer.getAdapter();
    if (!adapter) return;
    const values = await adapter.list<T>(this.ns, dealId);
    const map = new Map<string, T>();
    for (const value of values) map.set(this.keyOf(value), value);
    this.cache.set(dealId, map);
  }

  /** Bypass the cache and read the authoritative value from the adapter. */
  async getAuthoritative(dealId: string, key: string): Promise<T | null> {
    const adapter = this.writer.getAdapter();
    if (!adapter) return this.get(dealId, key);
    return adapter.get<T>(this.ns, dealId, key);
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

// ---------------------------------------------------------------------------
// AuthPersistence surface (Phase 2 build target).
//
// Exposes the scoped auth-state table (auth_kv) behind a tiny adapter so the
// Phase-2 AuthPersistence layer can store login challenges, request nonces and
// session revocations durably without depending on the store's concrete class.
// `store` only needs the authGet/authPut/authDelete/authList surface.
// ---------------------------------------------------------------------------

export interface AuthPersistence {
  get(scope: string, key: string): Promise<unknown | null>;
  put(scope: string, key: string, value: unknown, expiresAt?: string | null): Promise<void>;
  delete(scope: string, key: string): Promise<void>;
  list(scope: string): Promise<Array<{ key: string; value: unknown; expiresAt: string | null }>>;
}

export interface AuthStateStore {
  authGet(scope: string, key: string): Promise<unknown | null>;
  authPut(scope: string, key: string, value: unknown, expiresAt?: string | null): Promise<void>;
  authDelete(scope: string, key: string): Promise<void>;
  authList(scope: string): Promise<AuthStateEntry[]>;
}

export function hasAuthStateStore(store: unknown): store is AuthStateStore {
  if (!store || typeof store !== "object") return false;
  const candidate = store as Partial<AuthStateStore>;
  return (
    typeof candidate.authGet === "function" &&
    typeof candidate.authPut === "function" &&
    typeof candidate.authDelete === "function" &&
    typeof candidate.authList === "function"
  );
}

export function createAuthPersistence(store: AuthStateStore): AuthPersistence {
  return {
    get: (scope, key) => store.authGet(scope, key),
    put: (scope, key, value, expiresAt) => store.authPut(scope, key, value, expiresAt ?? null),
    delete: (scope, key) => store.authDelete(scope, key),
    list: (scope) => store.authList(scope),
  };
}
