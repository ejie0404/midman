// Worker-side, serialized, reorg-aware indexer tick.
//
// The API owns the canonical Indexer; the worker runs the same projection so
// operation passes can advance the cursor without waiting on an API request.
// Ticks and replays are serialized per instance (in-process single-flight) and
// each batch commits its events and cursor in one transaction when the store
// supports it, so a crash cannot persist events without the cursor or vice
// versa.
import type { Address } from "viem";
import { decodeHubLog, type ChainReader } from "@midman/chain";
import type { ChainEventRow, Store } from "@midman/store";

export interface WorkerIndexerConfig {
  readonly hub: Address;
  readonly fromBlock: bigint;
  readonly batchSize?: bigint;
  readonly reorgWalkLimit?: number;
}

const DEFAULT_BATCH = 2_000n;

export interface TickResult {
  readonly scannedTo: bigint;
  readonly added: number;
  readonly orphaned: number;
  readonly reorg: boolean;
}

const LOCK_NS = "indexer.lock";
const LOCK_TTL_MS = 120_000;

export class WorkerIndexer {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lockOwner = `indexer-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    private readonly reader: ChainReader,
    private readonly store: Store,
    private readonly config: WorkerIndexerConfig,
  ) {}

  /** Serialized forward scan (single-flight: overlapping calls queue). */
  tick(): Promise<TickResult> {
    return this.serialize(() =>
      this.withLock(
        () => this.tickInner(),
        async () => {
          const tip = await this.store.getTip(this.config.hub);
          return {
            scannedTo: tip ? tip.blockNumber : this.config.fromBlock - 1n,
            added: 0,
            orphaned: 0,
            reorg: false,
          };
        },
      ),
    );
  }

  /** Serialized full replay from a deployment block. */
  replay(fromBlock?: bigint): Promise<void> {
    return this.serialize(() => this.withLock(() => this.replayInner(fromBlock), async () => {}));
  }

  /**
   * Cross-process lock: only one worker may advance this hub's cursor at a
   * time. Without it, a slower instance can read a stale tip and overwrite a
   * newer one. Held via a TTL row so a crashed holder self-heals.
   */
  private async withLock<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (!(await this.tryAcquire())) return fallback();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  private async tryAcquire(): Promise<boolean> {
    const key = this.config.hub.toLowerCase();
    const payload = { owner: this.lockOwner, expiresAt: Date.now() + LOCK_TTL_MS };
    if (await this.store.kvPutIfAbsent(LOCK_NS, key, "lock", payload)) return true;
    const existing = (await this.store.kvGet(LOCK_NS, key, "lock")) as { owner?: string; expiresAt?: number } | null;
    if (existing && typeof existing.expiresAt === "number" && existing.expiresAt > Date.now()) return false;
    // Expired holder: steal it. A brief race here is resolved by the create-only put.
    await this.store.kvDelete(LOCK_NS, key, "lock");
    return this.store.kvPutIfAbsent(LOCK_NS, key, "lock", payload);
  }

  private async release(): Promise<void> {
    const key = this.config.hub.toLowerCase();
    const existing = (await this.store.kvGet(LOCK_NS, key, "lock")) as { owner?: string } | null;
    if (existing?.owner === this.lockOwner) await this.store.kvDelete(LOCK_NS, key, "lock");
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async tickInner(): Promise<TickResult> {
    const hub = this.config.hub;
    let reorg = false;
    let orphaned = 0;
    const continuity = await this.verifyContinuity();
    if (!continuity.ok) {
      reorg = true;
      orphaned += continuity.orphaned;
    }
    const tip = await this.store.getTip(hub);
    const head = await this.reader.getLatestBlockNumber();
    const start = tip ? tip.blockNumber + 1n : this.config.fromBlock;
    if (start > head) {
      return { scannedTo: start - 1n, added: 0, orphaned, reorg };
    }
    const batch = this.config.batchSize ?? DEFAULT_BATCH;
    const end = head < start + batch - 1n ? head : start + batch - 1n;
    let added = 0;
    if (end >= start) {
      const logs = await this.reader.getLogs({ address: hub, fromBlock: start, toBlock: end });
      const rows: ChainEventRow[] = [];
      for (const log of logs) {
        if (log.removed) {
          await this.store.markOrphanedFrom(hub, log.blockNumber);
          orphaned += 1;
          continue;
        }
        const decoded = decodeHubLog(log);
        const args: Record<string, unknown> = {};
        if (decoded) {
          for (const [k, v] of Object.entries(decoded.args)) {
            args[k] = typeof v === "bigint" ? (v as bigint).toString() : (v as unknown);
          }
        }
        rows.push({
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          contractAddress: hub,
          dealId: typeof args["dealId"] === "string" ? (args["dealId"] as string) : null,
          eventName: decoded ? decoded.eventName : "Unknown",
          args,
          orphaned: false,
        });
      }
      const tipBlock = await this.reader.getBlock(end);
      // Commit events + cursor together so the projection and tip never drift.
      await this.store.withTransaction(async (tx) => {
        added = await tx.putEvents(rows);
        await tx.setTip(hub, { blockNumber: end, blockHash: tipBlock.hash });
      });
    }
    return { scannedTo: end >= start ? end : start - 1n, added, orphaned, reorg };
  }

  private async replayInner(fromBlock?: bigint): Promise<void> {
    await this.store.clearContractData(this.config.hub);
    const start = fromBlock ?? this.config.fromBlock;
    if (start > 0n) {
      const before = await this.reader.getBlock(start - 1n);
      await this.store.setTip(this.config.hub, { blockNumber: start - 1n, blockHash: before.hash });
    }
  }

  async verifyContinuity(): Promise<{ ok: boolean; forkPoint: bigint | null; orphaned: number }> {
    const hub = this.config.hub;
    const tip = await this.store.getTip(hub);
    if (!tip) return { ok: true, forkPoint: null, orphaned: 0 };
    const head = await this.reader.getLatestBlockNumber();
    let chainTip: { hash: string } | null = null;
    try {
      chainTip = await this.reader.getBlock(tip.blockNumber);
    } catch {
      chainTip = null;
    }
    const recorded = await this.store.blockHashAt(hub, tip.blockNumber);
    const canonical =
      chainTip !== null &&
      chainTip.hash.toLowerCase() === tip.blockHash.toLowerCase() &&
      (recorded === null || recorded.toLowerCase() === tip.blockHash.toLowerCase());
    let linked = true;
    if (tip.blockNumber + 1n <= head) {
      try {
        const successor = await this.reader.getBlock(tip.blockNumber + 1n);
        const expectedParent = recorded ?? tip.blockHash;
        linked = successor.parentHash.toLowerCase() === expectedParent.toLowerCase();
      } catch {
        linked = false;
      }
    }
    if (canonical && linked) return { ok: true, forkPoint: null, orphaned: 0 };
    const forkPoint = await this.findForkPoint(hub, tip.blockNumber);
    const orphaned = await this.store.markOrphanedFrom(hub, forkPoint + 1n);
    if (forkPoint >= 0n) {
      const block = await this.reader.getBlock(forkPoint);
      await this.store.setTip(hub, { blockNumber: forkPoint, blockHash: block.hash });
    }
    return { ok: false, forkPoint, orphaned };
  }

  private async findForkPoint(hub: string, tipNumber: bigint): Promise<bigint> {
    const limit = this.config.reorgWalkLimit ?? 64;
    let number = tipNumber;
    for (let i = 0; i < limit && number >= this.config.fromBlock; i++) {
      const recorded = await this.store.blockHashAt(hub, number);
      try {
        const chain = await this.reader.getBlock(number);
        if (recorded !== null && chain.hash.toLowerCase() === recorded.toLowerCase()) return number;
      } catch {
        // Unreadable height (backward-moving head): keep walking down.
      }
      number -= 1n;
    }
    await this.store.clearContractData(hub);
    return this.config.fromBlock - 1n;
  }
}
