// Reorg-aware, replayable indexer. Contract state is authoritative for money;
// this projection is display + operations. Financial labels from the DB must
// never override a chain read (enforced in routes, not just documented).
import type { Address } from "viem";
import { decodeHubLog, type ChainReader } from "@midman/chain";
import type { ChainEventRow, Store } from "./db.js";

export interface IndexerConfig {
  readonly hub: Address;
  readonly fromBlock: bigint;
  readonly batchSize?: bigint;
  readonly reorgWalkLimit?: number;
}

const DEFAULT_BATCH = 2_000n;

export interface ContinuityCheck {
  /** True when the stored tip is still canonical and links to its successor. */
  readonly ok: boolean;
  /** Common anchor when a reorg was detected, else null. */
  readonly forkPoint: bigint | null;
  /** Events orphaned by the rollback. */
  readonly orphaned: number;
}

/**
 * Deals the worker must consider: drafts plus every deal seen in chain events.
 * `store.listDealIds()` only knows locally-created drafts, so externally funded
 * deals were invisible to progression/reminders/capacity passes (audit #10).
 * The worker passes should call this instead of `store.listDealIds()`.
 */
// Deal discovery is shared with the worker via @midman/store so both use the
// union of draft-linked and chain-discovered deals.
export { listKnownDealIds } from "@midman/store";

export class Indexer {
  // In-process single-flight: ticks and replays never overlap, so two timer
  // passes cannot scan the same range or interleave cursor updates. (Cross-
  // process serialization still needs a DB advisory lock — see the worker.)
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly reader: ChainReader,
    private readonly store: Store,
    private readonly config: IndexerConfig,
  ) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Verify the stored tip is still on the canonical chain before scanning.
   * Unlike a single parent check, this compares the STORED hash at the tip
   * height to the chain (catching a same-height replacement even when no new
   * block exists) and checks the parent linkage of the successor block.
   * Returns `ok: false` after rolling the tip back to the common anchor.
   */
  async verifyContinuity(): Promise<ContinuityCheck> {
    const hub = this.config.hub;
    const tip = await this.store.getTip(hub);
    if (!tip) return { ok: true, forkPoint: null, orphaned: 0 };
    const head = await this.reader.getLatestBlockNumber();

    // (a) Stored hash at the tip height must still be the chain hash there.
    // An unreadable tip (e.g. a backward-moving head past our block) is treated
    // as a reorg rather than an exception.
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

    // (b) The successor's parent must link to the stored hash at its parent
    // height. This rejects a parent-hash mismatch introduced by a rewrite of
    // an already-scanned block that is not the tip.
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
      await this.store.setTip(hub, await this.tipAt(forkPoint));
    }
    return { ok: false, forkPoint, orphaned };
  }

  /** Scan one batch forward (serialized). Returns operations visibility. */
  tick(): Promise<{ scannedTo: bigint; added: number; orphaned: number; reorg: boolean }> {
    return this.serialize(() => this.tickInner());
  }

  private async tickInner(): Promise<{ scannedTo: bigint; added: number; orphaned: number; reorg: boolean }> {
    const hub = this.config.hub;
    // Immediate reorg detection: never trust the stored tip. A same-height
    // replacement is caught even when head === the old tip.
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
        const dealId = typeof args["dealId"] === "string" ? (args["dealId"] as string) : null;
        rows.push({
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          contractAddress: hub,
          dealId,
          eventName: decoded ? decoded.eventName : "Unknown",
          args,
          orphaned: false,
        });
      }
      const tipBlock = await this.reader.getBlock(end);
      // Commit events + cursor together: a crash cannot leave the projection
      // ahead of (or behind) its tip.
      await this.store.withTransaction(async (tx) => {
        added = await tx.putEvents(rows); // idempotent on (txHash, logIndex)
        await tx.setTip(hub, { blockNumber: end, blockHash: tipBlock.hash });
      });
    }
    return { scannedTo: end >= start ? end : start - 1n, added, orphaned, reorg };
  }

  /** Full replay from the deployment block (or a chosen block); serialized. */
  replay(fromBlock?: bigint): Promise<void> {
    return this.serialize(() => this.replayInner(fromBlock));
  }

  private async replayInner(fromBlock?: bigint): Promise<void> {
    await this.store.clearContractData(this.config.hub);
    // Prime the tip just before the rescan start so tick() continues naturally.
    const start = fromBlock ?? this.config.fromBlock;
    if (start > 0n) {
      const before = await this.reader.getBlock(start - 1n);
      await this.store.setTip(this.config.hub, { blockNumber: start - 1n, blockHash: before.hash });
    }
  }

  private async tipAt(blockNumber: bigint): Promise<{ blockNumber: bigint; blockHash: string }> {
    const block = await this.reader.getBlock(blockNumber);
    return { blockNumber, blockHash: block.hash };
  }

  private async findForkPoint(hub: string, tipNumber: bigint): Promise<bigint> {
    const limit = this.config.reorgWalkLimit ?? 64;
    // Walk down comparing CHAIN hashes to STORED event hashes. Heights with
    // no stored events prove nothing and are skipped.
    let number = tipNumber;
    for (let i = 0; i < limit && number >= this.config.fromBlock; i++) {
      const recorded = await this.store.blockHashAt(hub, number);
      try {
        const chain = await this.reader.getBlock(number);
        if (recorded !== null && chain.hash.toLowerCase() === recorded.toLowerCase()) return number;
      } catch {
        // Unreadable height (backward-moving head): nothing recorded here can
        // be proven canonical, so keep walking down.
      }
      number -= 1n;
    }
    // No common anchor within the walk limit (or before deployment):
    // rescan everything from deployment.
    await this.store.clearContractData(hub);
    return this.config.fromBlock - 1n;
  }
}
