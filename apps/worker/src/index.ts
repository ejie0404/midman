// Worker entry: durable inline loop over the relay outbox plus periodic
// passes (reminders, reconciliation, progression, escape). BullMQ/Redis
// scale-out is a Phase 10 cutover; durability comes from the outbox table
// (pg-backed in hosted environments) and idempotency keys, not the runner.
import { pathToFileURL } from "node:url";
import type { Address } from "viem";
import type { ChainReader } from "@midman/chain";
import { createViemReader } from "@midman/chain";
import { auditLog, createStore, type Store } from "@midman/store";
import { sponsorConfigFromEnv, createRelayProcessor } from "./relay.js";
import {
  RelayProcessor,
  reconcileSubmitted,
  relayRecoverySnapshot,
  defaultSponsorshipBudget,
} from "./reliability/hardening.js";
import { AbuseControls } from "./reliability/abuse.js";
import { RpcPool } from "./reliability/rpcPool.js";
import { WorkerIndexer } from "./indexer.js";
import { progressionPass, escapePass } from "./progression.js";
import { reconcile } from "./reconcile.js";
import { remindersPass } from "./reminders.js";
import { runMonitoringPass, makeSinkFromEnv } from "./monitoring/index.js";
import { CapacityMeter, assess, pauseRecommendation } from "./capacity/capacity.js";
import { runAllDrills } from "./drills/index.js";
import { restoreDrillWithLocalStore } from "./drills/restore.js";
import { outageDrill, simulatedOutageDeps } from "./drills/outage.js";
import { keeperFromEnv, runOutageKeeper, type KeeperMemory } from "./outage/keeper.js";

export const QUEUES = ["reminders", "relay", "reconciliation", "progression"] as const;
export type QueueName = (typeof QUEUES)[number];

export interface JobResult {
  readonly queue: QueueName;
  readonly dedupeKey: string;
  readonly note: string;
}

export function describeJob(queue: QueueName, dedupeKey: string): JobResult {
  return { queue, dedupeKey, note: "idempotent; re-check chain state before submit" };
}

export interface WorkerEnv {
  readonly store: Store;
  readonly reader: ChainReader | null;
  readonly hub: Address | null;
  readonly usdc: Address;
}

export function workerEnv(): WorkerEnv {
  const rpcUrls = (process.env["BASE_RPC_URLS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const hub = (process.env["HUB_ADDRESS"] ?? "") as Address;
  return {
    store: createStore(),
    reader: rpcUrls.length > 0 ? createViemReader(rpcUrls) : null,
    hub: /^0x[0-9a-fA-F]{40}$/.test(hub) ? hub : null,
    usdc: (process.env["USDC_ADDRESS"] ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address,
  };
}

let sharedAbuse: AbuseControls | null = null;
const processors = new WeakMap<Store, RelayProcessor>();
const indexers = new WeakMap<Store, WorkerIndexer>();

function abuseControls(): AbuseControls {
  return (sharedAbuse ??= new AbuseControls());
}

function fromBlockFromEnv(): bigint {
  const raw = process.env["HUB_DEPLOY_BLOCK"] ?? process.env["INDEXER_FROM_BLOCK"] ?? "0";
  try {
    const value = BigInt(raw);
    return value >= 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

/** Serialized worker indexer for a store/env (cursor survives timer ticks). */
export function workerIndexerFor(env: WorkerEnv): WorkerIndexer | null {
  if (!env.reader || !env.hub) return null;
  let indexer = indexers.get(env.store);
  if (!indexer) {
    indexer = new WorkerIndexer(env.reader, env.store, {
      hub: env.hub,
      fromBlock: fromBlockFromEnv(),
    });
    indexers.set(env.store, indexer);
  }
  return indexer;
}

/**
 * Live relay processor for a worker env: SponsorshipBudget + AbuseControls +
 * optional RpcPool, cached per store so nonce coordination and lease/backoff
 * state survive across timer ticks.
 */
export function relayProcessorFor(env: WorkerEnv): RelayProcessor {
  let processor = processors.get(env.store);
  if (!processor) {
    const rpcUrls = (process.env["BASE_RPC_URLS"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    processor = createRelayProcessor({
      store: env.store,
      reader: env.reader,
      hub: env.hub,
      sponsor: sponsorConfigFromEnv(),
      budget: defaultSponsorshipBudget(),
      abuse: abuseControls(),
      rpcPool: rpcUrls.length > 0 ? new RpcPool(rpcUrls) : null,
    });
    processors.set(env.store, processor);
  }
  return processor;
}

/**
 * Drain queued relay jobs once. Recovery queries are mandatory (no optional
 * capability probes): queued work AND work left 'processing' by a crashed
 * worker are both discovered, and expired leases are reaped first.
 */
export async function drainRelayOnce(
  env: WorkerEnv,
  processor?: RelayProcessor,
): Promise<Array<{ key: string; status: string; reason?: string }>> {
  const outcomes: Array<{ key: string; status: string; reason?: string }> = [];
  if (!env.hub) return outcomes;
  const relay = processor ?? relayProcessorFor(env);
  await env.store.reapExpiredRelayLeases();
  const processing = await env.store.listRelayByStatus("processing", 25);
  const jobs = [...(await env.store.listQueuedRelay("relay", 25)), ...processing];
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.idempotencyKey)) continue;
    seen.add(job.idempotencyKey);
    const result = await relay.process(job.idempotencyKey);
    outcomes.push({
      key: job.idempotencyKey,
      status: result.status,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    });
  }
  return outcomes;
}

// In-process single-flight guard: timer passes never overlap. A pass that
// arrives while one is running is dropped (counted as `overlapped`), and DB
// leases still guard the multi-worker case.
const keeperMemory: KeeperMemory = { behindSince: null };
let keeperWiring: ReturnType<typeof keeperFromEnv> | null = null;

let passRunning = false;

/** True while a worker pass is executing in this process (test/diagnostic). */
export function workerPassInFlight(): boolean {
  return passRunning;
}

/** One full operations pass. Safe to run on a timer; overlapping calls skip. */
export async function runPassOnce(env: WorkerEnv, nowSeconds: number): Promise<Record<string, number>> {
  const counts: Record<string, number> = { relay: 0, progression: 0, escape: 0, reminders: 0 };
  if (!env.hub || !env.reader) {
    auditLog({ actor: "worker", action: "worker.degraded", details: { reason: "no-rpc-or-hub" } });
    return counts;
  }
  if (passRunning) {
    counts["overlapped"] = 1;
    return counts;
  }
  passRunning = true;
  try {
    return await runPassInner(env, nowSeconds, counts);
  } finally {
    passRunning = false;
  }
}

async function runPassInner(
  env: WorkerEnv,
  nowSeconds: number,
  counts: Record<string, number>,
): Promise<Record<string, number>> {
  const reader = env.reader;
  const hub = env.hub;
  if (!reader || !hub) return counts;
  // Advance the chain projection first so relay reconciliation sees fresh
  // events, serialized per deployment through the WorkerIndexer.
  const indexer = workerIndexerFor(env);
  if (indexer) {
    try {
      const tick = await indexer.tick();
      counts["indexed"] = tick.added;
      counts["indexOrphaned"] = tick.orphaned;
      if (tick.reorg) counts["indexReorgs"] = 1;
    } catch {
      // Indexing is best-effort within a pass; a bad RPC must not abort relay.
      counts["indexError"] = 1;
    }
  }
  const processor = relayProcessorFor(env);
  const drained = await drainRelayOnce(env, processor);
  counts["relay"] = drained.length;
  counts["relaySkipped"] = drained.filter((outcome) => outcome.status === "skipped").length;
  counts["relayBudgetStopped"] = drained.filter(
    (outcome) => outcome.status === "unsigned" && outcome.reason === "budget-exhausted",
  ).length;
  // Resolve previously submitted jobs: finalized / confirmed / reverted / orphaned.
  const reconciled = await reconcileSubmitted(env.store, reader, processor.submittedKeysList());
  counts["relayReconciled"] = reconciled.filter(
    (outcome) =>
      outcome.status === "finalized" ||
      outcome.status === "confirmed" ||
      outcome.status === "reverted" ||
      outcome.status === "orphaned",
  ).length;
  counts["relayFinalized"] = reconciled.filter((outcome) => outcome.status === "finalized").length;
  counts["relayOrphaned"] = reconciled.filter((outcome) => outcome.status === "orphaned").length;
  // Recovery visibility: every non-terminal status is queried, not assumed.
  const recovery = await relayRecoverySnapshot(env.store);
  counts["relayProcessing"] = recovery["processing"] ?? 0;
  counts["relaySubmitted"] = recovery["submitted"] ?? 0;
  counts["relayFailed"] = recovery["failed"] ?? 0;
  // Outage keeper before progression: a lagging watermark makes every
  // time-derived hub action revert with OutageUnknown.
  const rpcUrls = (process.env["BASE_RPC_URLS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  let keeperAlerts: Awaited<ReturnType<typeof runOutageKeeper>>["alerts"] = [];
  if (rpcUrls.length > 0) {
    keeperWiring ??= keeperFromEnv(rpcUrls, hub);
    const keeper = await runOutageKeeper({ ...keeperWiring, memory: keeperMemory, nowSeconds });
    counts["outageKeeperSubmitted"] = keeper.submitted.length;
    if (keeper.status === "behind" || keeper.status === "unknown") counts["outageWatermarkBehind"] = 1;
    keeperAlerts = keeper.alerts;
  }
  counts["progression"] = (await progressionPass({ store: env.store, reader, hub, nowSeconds })).length;
  counts["escape"] = (await escapePass({ store: env.store, reader, hub, nowSeconds })).length;
  counts["reminders"] = (await remindersPass({ store: env.store, reader, hub, nowSeconds })).length;
  const reconciliation = await reconcile({ reader, hub, usdc: env.usdc });
  if (!reconciliation.ok) counts["alerts"] = 1;
  // Monitoring: metrics + threshold alerts (deduped, non-throwing delivery).
  const monitoring = await runMonitoringPass(env, nowSeconds, { sink: makeSinkFromEnv(), extraAlerts: keeperAlerts });
  counts["monitorAlerts"] = monitoring.delivered;
  return counts;
}

/** Combined worker health for operators (no secrets). */
export async function workerHealth(env: WorkerEnv, nowSeconds: number): Promise<Record<string, unknown>> {
  const meter = new CapacityMeter({ store: env.store, reader: env.reader, hub: env.hub });
  const load = await meter.measure();
  const limits = {
    activeEscalated: Number(process.env["MAX_CONCURRENT_ESCALATED_PROTOCOL"] ?? "20"),
    openRelayJobs: Number(process.env["MAX_OPEN_RELAY_JOBS"] ?? "500"),
    evidenceCount: Number(process.env["MAX_EVIDENCE_OBJECTS"] ?? "100000"),
    reviewerPending: Number(process.env["MAX_REVIEWER_PENDING"] ?? "40"),
  };
  const assessment = assess(load, limits);
  return {
    degraded: !env.reader || !env.hub,
    load,
    capacity: assessment,
    pauseRecommended: pauseRecommendation(assessment),
    at: nowSeconds,
  };
}

/** Run the reliability/recovery drills (offline, injected; safe to run on demand). */
export async function runDrills(nowSeconds: number): Promise<Record<string, unknown>> {
  const result = await runAllDrills({
    restore: () => restoreDrillWithLocalStore(),
    outage: () => outageDrill(simulatedOutageDeps()),
  });
  return { ...result, at: nowSeconds };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = workerEnv();
  const intervalMs = Number(process.env["WORKER_INTERVAL_MS"] ?? "15000");
  console.log(JSON.stringify({ worker: "midman", queues: QUEUES, degraded: !env.reader || !env.hub }));
  setInterval(() => {
    runPassOnce(env, Math.floor(Date.now() / 1_000)).catch((error) => console.error(error));
  }, intervalMs);
}
