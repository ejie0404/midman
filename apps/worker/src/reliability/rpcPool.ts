// RpcPool: ordered BASE_RPC_URLS with health checks, failover ordering, and a
// per-URL cooldown after failure. Dependency-light and fully injectable
// (`probe`, `now`) so it can be tested without a network.
//
// The pool never treats an RPC as authoritative for money: it only decides
// which endpoint to read from. Contract state remains the source of truth.
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createViemReader, type ChainReader } from "@midman/chain";

/** eth_blockNumber round-trip. Resolves to the chain head, rejects on failure. */
export type RpcProbe = (url: string) => Promise<bigint>;

export const DEFAULT_RPC_COOLDOWN_SECONDS = 60;

async function defaultProbe(url: string): Promise<bigint> {
  const client = createPublicClient({ chain: base, transport: http(url) });
  return client.getBlockNumber();
}

export interface RpcPoolOptions {
  readonly cooldownSeconds?: number;
  readonly probe?: RpcProbe;
  readonly now?: () => number;
}

interface UrlState {
  cooldownUntil: number;
  failures: number;
}

export interface RpcHealth {
  readonly url: string;
  readonly ok: boolean;
  readonly blockNumber: bigint | null;
  readonly error: string | null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class RpcPool {
  private readonly urls: readonly string[];
  private readonly cooldownSeconds: number;
  private readonly probe: RpcProbe;
  private readonly now: () => number;
  private readonly state = new Map<string, UrlState>();

  constructor(urls: readonly string[], options: RpcPoolOptions = {}) {
    this.urls = urls.map((url) => url.trim()).filter((url) => url.length > 0);
    this.cooldownSeconds = options.cooldownSeconds ?? envInt("RPC_COOLDOWN_SECONDS", DEFAULT_RPC_COOLDOWN_SECONDS);
    this.probe = options.probe ?? defaultProbe;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    for (const url of this.urls) this.state.set(url, { cooldownUntil: 0, failures: 0 });
  }

  /** Configured URLs in preference order (healthy or not). */
  urlsInOrder(): string[] {
    return [...this.urls];
  }

  /** URLs not currently in cooldown, in preference order. */
  healthyUrls(nowSeconds: number = this.now()): string[] {
    return this.urls.filter((url) => (this.state.get(url)?.cooldownUntil ?? 0) <= nowSeconds);
  }

  isHealthy(url: string, nowSeconds: number = this.now()): boolean {
    return (this.state.get(url)?.cooldownUntil ?? 0) <= nowSeconds;
  }

  /** Put a URL in cooldown immediately after a failed call. */
  markFailure(url: string, nowSeconds: number = this.now()): void {
    const current = this.state.get(url) ?? { cooldownUntil: 0, failures: 0 };
    this.state.set(url, {
      cooldownUntil: nowSeconds + this.cooldownSeconds,
      failures: current.failures + 1,
    });
  }

  /** Clear cooldown/failure state after a successful probe. */
  markHealthy(url: string): void {
    if (this.state.has(url)) this.state.set(url, { cooldownUntil: 0, failures: 0 });
  }

  /** Probe every URL (eth_blockNumber) and update cooldown state. */
  async healthCheck(): Promise<RpcHealth[]> {
    const results: RpcHealth[] = [];
    for (const url of this.urls) {
      if (!this.isHealthy(url)) {
        results.push({ url, ok: false, blockNumber: null, error: "cooldown" });
        continue;
      }
      try {
        const blockNumber = await this.probe(url);
        this.markHealthy(url);
        results.push({ url, ok: true, blockNumber, error: null });
      } catch (error) {
        this.markFailure(url);
        results.push({
          url,
          ok: false,
          blockNumber: null,
          error: error instanceof Error ? error.message : "probe-failed",
        });
      }
    }
    return results;
  }

  /**
   * Try healthy URLs in preference order, marking each failure. Returns the
   * first success. If every URL is cooling down, all are tried once anyway so
   * a total outage cannot permanently wedge reads.
   */
  async read<T>(fn: (url: string) => Promise<T>): Promise<T> {
    let candidates = this.healthyUrls();
    if (candidates.length === 0) candidates = [...this.urls];
    let lastError: unknown = new Error("rpc-pool: no urls configured");
    for (const url of candidates) {
      try {
        return await fn(url);
      } catch (error) {
        lastError = error;
        this.markFailure(url);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("rpc-pool: all urls failed");
  }
}

/**
 * ChainReader backed by a pool. Each call runs against the current healthy
 * endpoint and rotates to the next one on failure.
 */
export function createResilientReader(urls: readonly string[], options: RpcPoolOptions = {}): ChainReader {
  const pool = new RpcPool(urls, options);
  const readers = new Map<string, ChainReader>();
  const readerFor = (url: string): ChainReader => {
    let reader = readers.get(url);
    if (!reader) {
      reader = createViemReader([url]);
      readers.set(url, reader);
    }
    return reader;
  };
  const call = <T>(fn: (reader: ChainReader) => Promise<T>): Promise<T> =>
    pool.read((url) => fn(readerFor(url)));
  return {
    getLatestBlockNumber: () => call((reader) => reader.getLatestBlockNumber()),
    getBlock: (number) => call((reader) => reader.getBlock(number)),
    getBlockByTag: (tag) => call((reader) => reader.getBlockByTag(tag)),
    getLogs: (params) => call((reader) => reader.getLogs(params)),
    getTransactionReceipt: (txHash) => call((reader) => reader.getTransactionReceipt(txHash)),
    getDeal: (hub, dealId) => call((reader) => reader.getDeal(hub, dealId)),
    getClaim: (hub, claimId) => call((reader) => reader.getClaim(hub, claimId)),
    getLiabilities: (hub) => call((reader) => reader.getLiabilities(hub)),
    getTokenBalance: (token, account) => call((reader) => reader.getTokenBalance(token, account)),
    isPanelMember: (policies, epoch, house, wallet) =>
      call((reader) => reader.isPanelMember(policies, epoch, house, wallet)),
    getBondPolicy: (policies, id) => call((reader) => reader.getBondPolicy(policies, id)),
  };
}
