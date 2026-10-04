// Relay hardening: connects the reliability kit (RpcPool, gas buffer,
// SponsorshipBudget, AbuseControls) to the live submission path.
//
// Responsibilities:
//   1. Calldata validation — decode with HUB_ABI and refuse any job whose
//      encoded function does not match the requested action (blocks a
//      mismatched/malicious submission).
//   2. Atomic leasing with crash recovery — reuse store.claimRelay (atomic in
//      both stores). A job left 'processing' by a crashed worker is requeued
//      once its lease is older than LEASE_TTL_SECONDS. The lease timestamp is
//      written into the job's `result` JSON because the base Store interface
//      exposes no updated_at; see the note at `lease()`.
//   3. Bounded retries with backoff — RELAY_MAX_ATTEMPTS (default 5); the final
//      failure marks the job 'failed' with a reason. Unknown-outcome jobs are
//      never auto-resubmitted: a submitted tx stays 'submitted' until a receipt
//      is observed by reconcileSubmitted.
//   4. Sponsor nonce coordination — one in-flight sponsored tx at a time via a
//      promise chain; the pending nonce is fetched once and incremented locally
//      between submissions so concurrent sends can never reuse a nonce.
//   5. Receipt tracking — reconcileSubmitted flips 'submitted' -> 'confirmed'
//      or 'reverted' from getTransactionReceipt and emits audit events.
//   6. Budget + abuse + RPC recovery wired through injected dependencies.
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  http,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HUB_ABI, type ChainReader, type TransactionReceipt } from "@midman/chain";
import { auditLog, type RelayJob, type Store } from "@midman/store";
import { estimateGasWithBuffer, type GasClient, type GasEstimate } from "./gas.js";
import { AbuseControls } from "./abuse.js";
import { SponsorshipBudget } from "./budget.js";
import { RpcPool } from "./rpcPool.js";

/** Documented action -> on-chain functionName allow-list. `fund` must decode
 * as `fund`; every other action maps to its identically named hub function. */
export const ACTION_FUNCTION_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  openDispute: ["openDispute"],
  escalate: ["escalate"],
  postRespondentBond: ["postRespondentBond"],
  submitEvidenceCommitment: ["submitEvidenceCommitment"],
  approveSeller: ["approveSeller"],
  refundBuyer: ["refundBuyer"],
  mutualSettlement: ["mutualSettlement"],
  markDelivered: ["markDelivered"],
  finalizeAfterTimeout: ["finalizeAfterTimeout"],
  refundForNonDelivery: ["refundForNonDelivery"],
  lapseDispute: ["lapseDispute"],
  advanceToPrimary: ["advanceToPrimary"],
  activateFallback: ["activateFallback"],
  queuePrimaryRuling: ["queuePrimaryRuling"],
  queueFallbackRuling: ["queueFallbackRuling"],
  vetoPrimaryRuling: ["vetoPrimaryRuling"],
  vetoFallbackRuling: ["vetoFallbackRuling"],
  executeRuling: ["executeRuling"],
  markDeadlock: ["markDeadlock"],
  catastrophicEscape: ["catastrophicEscape"],
  claimFor: ["claimFor"],
  fund: ["fund"],
});

export interface CalldataValidation {
  readonly ok: boolean;
  readonly functionName: string | null;
  readonly reason: string;
}

/**
 * Decode a job's calldata with HUB_ABI and assert the function name is allowed
 * for the job's action. `data` defaults to `job.params.data` (the pre-encoded
 * path used by fund / evidence / ruling jobs).
 */
export function validateRelayJob(
  job: { readonly action: string; readonly params: Record<string, unknown> },
  data?: string | null,
): CalldataValidation {
  const fallback = data ?? (typeof job.params["data"] === "string" ? (job.params["data"] as string) : null);
  if (fallback === null || !/^0x[0-9a-fA-F]*$/.test(fallback) || fallback.length < 10) {
    return { ok: false, functionName: null, reason: "no-calldata" };
  }
  let functionName: string | null = null;
  try {
    const decoded = decodeFunctionData({ abi: HUB_ABI, data: fallback as Hex });
    functionName = typeof decoded.functionName === "string" ? decoded.functionName : null;
  } catch {
    return { ok: false, functionName: null, reason: "undecodable-calldata" };
  }
  const allowed = ACTION_FUNCTION_MAP[job.action];
  if (allowed === undefined) return { ok: false, functionName, reason: "unknown-action" };
  if (functionName === null || !allowed.includes(functionName)) {
    return { ok: false, functionName, reason: "action-calldata-mismatch" };
  }
  return { ok: true, functionName, reason: "ok" };
}

// ---- Injected sponsor transport (tests stub this; prod builds viem clients) ----

export interface RelayTxRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly nonce: number;
  readonly gas?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
}

export interface RelayTransport {
  getNonce(): Promise<number>;
  send(tx: RelayTxRequest): Promise<Hash>;
}

export interface HardeningSponsor {
  readonly key: string | null;
  readonly rpcUrl: string | null;
  readonly dailyCapTxs: number;
}

export type CalldataBuilder = (action: string, dealId: Hash, params: Record<string, unknown>) => Hash | null;
export type PreconditionCheck = (
  reader: ChainReader | null,
  hub: Address | null,
  action: string,
  dealId: Hash,
  params: Record<string, unknown>,
) => Promise<{ ok: boolean; reason: string }>;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function defaultBuildCalldata(_action: string, _dealId: Hash, params: Record<string, unknown>): Hash | null {
  const data = params["data"];
  return typeof data === "string" && data.startsWith("0x") ? (data as Hash) : null;
}

const defaultCheckPreconditions: PreconditionCheck = async () => ({ ok: true, reason: "no-reader" });

export function retryBackoffSeconds(attempt: number, baseSeconds?: number): number {
  const base = baseSeconds ?? envInt("RELAY_RETRY_BASE_SECONDS", 5);
  const cap = envInt("RELAY_RETRY_MAX_SECONDS", 300);
  if (attempt <= 1) return Math.min(base, cap);
  return Math.min(base * 2 ** (attempt - 1), cap);
}

function retryAtOf(job: RelayJob): number | null {
  const result = job.result;
  if (result === null || result === undefined) return null;
  const value = result["retryAt"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function leaseAtOf(job: RelayJob): number | null {
  const result = job.result;
  if (result === null || result === undefined) return null;
  const value = result["leaseAt"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dealIdOf(job: { readonly params: Record<string, unknown> }): string | null {
  const value = job.params["dealId"];
  return typeof value === "string" ? value : null;
}

export interface RelayProcessResult {
  readonly status: string;
  readonly txHash: string | null;
  readonly reason?: string;
  readonly functionName?: string | null;
}

export interface RelayProcessorOptions {
  readonly store: Store;
  readonly reader?: ChainReader | null;
  readonly hub?: Address | null;
  readonly sponsor?: HardeningSponsor | null;
  readonly budget?: SponsorshipBudget | null;
  readonly abuse?: AbuseControls | null;
  readonly rpcPool?: RpcPool | null;
  readonly gasClient?: GasClient | null;
  readonly transport?: RelayTransport | null;
  readonly buildCalldata?: CalldataBuilder | null;
  readonly checkPreconditions?: PreconditionCheck | null;
  readonly now?: (() => number) | null;
  readonly leaseTtlSeconds?: number | null;
  readonly maxAttempts?: number | null;
}

/**
 * RelayProcessor owns the submission state machine for relay jobs.
 *
 * Lease algorithm (atomic + crash recovery):
 *   claim = store.claimRelay(key)            // atomic UPDATE ... WHERE queued
 *   if claim: stampLease(claim)              // status stays 'processing'
 *   else if getRelay(key).status == 'processing':
 *        age = now - result.leaseAt          // missing leaseAt => treat as stale
 *        if age >= LEASE_TTL_SECONDS:
 *           finishRelay(key,'queued',...)    // requeue
 *           claimRelay(key)                  // reclaim (attempt++)
 *
 * Nonce algorithm (single in-flight sponsored tx):
 *   serialize sends on a promise chain; on first send fetch the pending nonce
 *   once, then increment locally for every subsequent send. A failed send
 *   clears the cached nonce so the next attempt re-reads the pending count.
 */
export class RelayProcessor {
  private readonly store: Store;
  private readonly reader: ChainReader | null;
  private readonly hub: Address | null;
  private readonly sponsor: HardeningSponsor | null;
  private readonly budget: SponsorshipBudget | null;
  private readonly abuse: AbuseControls | null;
  private readonly rpcPool: RpcPool | null;
  private readonly build: CalldataBuilder;
  private readonly check: PreconditionCheck;
  private readonly now: () => number;
  private readonly leaseTtlSeconds: number;
  private readonly maxAttempts: number;
  private readonly leaseOwner: string;
  private readonly submittedKeys = new Set<string>();
  private transport: RelayTransport | null;
  private gasClient: GasClient | null;
  private sendChain: Promise<unknown> = Promise.resolve();
  private localNonce: number | null = null;

  constructor(options: RelayProcessorOptions) {
    this.store = options.store;
    this.reader = options.reader ?? null;
    this.hub = options.hub ?? null;
    this.sponsor = options.sponsor ?? null;
    this.budget = options.budget ?? null;
    this.abuse = options.abuse ?? null;
    this.rpcPool = options.rpcPool ?? null;
    this.build = options.buildCalldata ?? defaultBuildCalldata;
    this.check = options.checkPreconditions ?? defaultCheckPreconditions;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.leaseTtlSeconds = options.leaseTtlSeconds ?? envInt("RELAY_LEASE_TTL_SECONDS", 120);
    this.maxAttempts = options.maxAttempts ?? envInt("RELAY_MAX_ATTEMPTS", 5);
    this.leaseOwner = `worker-${process.pid}-${Math.floor(this.now())}`;
    this.transport = options.transport ?? null;
    this.gasClient = options.gasClient ?? null;
  }

  /** Keys submitted by this processor; fed to reconcileSubmitted each pass. */
  submittedKeysList(): string[] {
    return [...this.submittedKeys];
  }

  async process(idempotencyKey: string): Promise<RelayProcessResult> {
    const existing = await this.store.getRelay(idempotencyKey);
    if (!existing) return { status: "missing", txHash: null };
    if (existing.status !== "queued" && existing.status !== "processing") {
      return { status: "already-handled", txHash: existing.txHash };
    }

    // Backoff gate for retried jobs (leave queued until retryAt elapses).
    if (existing.status === "queued") {
      const retryAt = retryAtOf(existing);
      if (retryAt !== null && this.now() < retryAt) {
        return { status: "backoff", txHash: null, reason: `retry-at-${retryAt}` };
      }
      const decision = this.abuse?.checkRelay(this.abuseKey(existing));
      if (decision !== undefined && !decision.allowed) {
        return { status: "skipped", txHash: null, reason: `abuse.${decision.reason}` };
      }
    }

    const dealId = existing.params["dealId"] as Hash | undefined;
    if (!this.hub || !dealId) {
      await this.retire(existing, "failed", "no-hub-or-deal");
      return { status: "failed", txHash: null, reason: "no-hub-or-deal" };
    }

    const pre = await this.check(this.reader, this.hub, existing.action, dealId, existing.params);
    if (!pre.ok) {
      await this.store.finishRelay(idempotencyKey, "skipped", null, { reason: pre.reason });
      return { status: "skipped", txHash: null, reason: pre.reason };
    }

    const data = this.build(existing.action, dealId, existing.params);
    if (!data) {
      await this.retire(existing, "failed", "no-calldata");
      return { status: "failed", txHash: null, reason: "no-calldata" };
    }
    const validation = validateRelayJob(existing, data);
    if (!validation.ok) {
      const reason = `calldata-mismatch:${validation.reason}:${validation.functionName ?? "?"}`;
      await this.retire(existing, "failed", reason);
      return { status: "failed", txHash: null, reason, functionName: validation.functionName };
    }

    const job = await this.lease(idempotencyKey);
    if (!job) return { status: "already-handled", txHash: existing.txHash };
    if (job.attempts > this.maxAttempts) {
      await this.retire(job, "failed", "max-attempts-exceeded");
      return { status: "failed", txHash: null, reason: "max-attempts-exceeded" };
    }

    // No sponsor => hand back unsigned calldata (operator can submit manually).
    if (!this.sponsor || !this.sponsor.key || !this.sponsor.rpcUrl) {
      await this.store.finishRelay(idempotencyKey, "unsigned", null, { to: this.hub, data });
      auditLog({
        actor: "relay",
        action: `relay.${job.action}.unsigned`,
        ...(dealIdOf(job) !== null ? { dealId: dealIdOf(job)! } : {}),
      });
      return { status: "unsigned", txHash: null };
    }

    // Gas estimate (best-effort) so the wei budget can be enforced exactly.
    const estimate = await this.estimate(job, data);

    if (this.budget && !this.budget.canSpend(1, estimate.costWei)) {
      await this.store.finishRelay(idempotencyKey, "unsigned", null, {
        to: this.hub,
        data,
        reason: "budget-exhausted",
      });
      return { status: "unsigned", txHash: null, reason: "budget-exhausted" };
    }

    // Legacy daily transaction cap kept for parity with the previous path.
    const spent = await this.store.countSponsorsSince(new Date((this.now() - 86_400) * 1_000).toISOString());
    if (spent >= this.sponsor.dailyCapTxs) {
      await this.store.finishRelay(idempotencyKey, "unsigned", null, { to: this.hub, data, reason: "daily-cap" });
      return { status: "unsigned", txHash: null, reason: "daily-cap" };
    }

    try {
      const request: RelayTxRequest = this.txRequest(this.hub, data, 0);
      const txHash = await this.serializeSend(async (nonce) => {
        const withNonce: RelayTxRequest = { ...request, nonce };
        return this.ensureTransport().send(withNonce);
      });
      await this.store.recordSponsor(txHash, dealIdOf(job), job.action);
      if (this.budget) this.budget.record(txHash, estimate.costWei, this.now());
      await this.store.finishRelay(idempotencyKey, "submitted", txHash, { to: this.hub, data });
      this.submittedKeys.add(idempotencyKey);
      auditLog({
        actor: "relay",
        action: `relay.${job.action}.submitted`,
        ...(dealIdOf(job) !== null ? { dealId: dealIdOf(job)! } : {}),
        details: { txHash, gasLimit: estimate.gasLimit.toString(), fallback: estimate.fallback },
      });
      return { status: "submitted", txHash };
    } catch (error) {
      // Unknown outcome: never auto-resubmit; bounded retry or terminal fail.
      this.localNonce = null;
      const reason = error instanceof Error ? error.message : "send-failed";
      return this.retryOrFail(job, reason);
    }
  }

  private abuseKey(job: RelayJob): string {
    const dealId = dealIdOf(job);
    return dealId === null ? job.idempotencyKey : `${job.action}:${dealId}`;
  }

  private async retire(job: RelayJob, status: string, reason: string): Promise<void> {
    await this.store.finishRelay(job.idempotencyKey, status, null, { reason });
    const dealId = dealIdOf(job);
    auditLog({
      actor: "relay",
      action: `relay.${job.action}.${status}`,
      ...(dealId !== null ? { dealId } : {}),
      details: { reason, attempts: job.attempts },
    });
  }

  private async retryOrFail(job: RelayJob, reason: string): Promise<RelayProcessResult> {
    if (job.attempts >= this.maxAttempts) {
      await this.retire(job, "failed", reason);
      return { status: "failed", txHash: null, reason };
    }
    const backoff = retryBackoffSeconds(job.attempts);
    const result = { ...(job.result ?? {}), reason, retryAt: this.now() + backoff, attempts: job.attempts };
    await this.store.finishRelay(job.idempotencyKey, "queued", null, result);
    const dealId = dealIdOf(job);
    auditLog({
      actor: "relay",
      action: `relay.${job.action}.retry`,
      ...(dealId !== null ? { dealId } : {}),
      details: { reason, attempts: job.attempts, retryInSeconds: backoff },
    });
    return { status: "retrying", txHash: null, reason };
  }

  private async lease(idempotencyKey: string): Promise<RelayJob | null> {
    const claimed = await this.store.claimRelay(idempotencyKey);
    if (claimed) {
      await this.stampLease(claimed);
      return claimed;
    }
    const current = await this.store.getRelay(idempotencyKey);
    if (!current || current.status !== "processing") return null;
    const at = leaseAtOf(current);
    const stale = at === null ? true : this.now() - at >= this.leaseTtlSeconds;
    if (!stale) return null;
    // Crash recovery: requeue then reclaim. No reliable cross-process age is
    // available from the base Store (relay_outbox.updated_at is not surfaced),
    // so a missing leaseAt is treated as a crashed worker.
    await this.store.finishRelay(idempotencyKey, "queued", current.txHash, current.result);
    const reclaimed = await this.store.claimRelay(idempotencyKey);
    if (!reclaimed) return null;
    await this.stampLease(reclaimed);
    return reclaimed;
  }

  private async stampLease(job: RelayJob): Promise<void> {
    const result = { ...(job.result ?? {}), leaseAt: this.now(), leaseOwner: this.leaseOwner };
    await this.store.finishRelay(job.idempotencyKey, "processing", job.txHash, result);
  }

  private txRequest(to: Address, data: Hash, nonce: number): RelayTxRequest {
    return { to, data: data as Hex, nonce };
  }

  private async estimate(
    job: RelayJob,
    data: Hash,
  ): Promise<{ gasLimit: bigint; fallback: boolean; costWei: bigint }> {
    const client = this.ensureGasClient();
    let estimate: GasEstimate;
    if (client) {
      estimate = await estimateGasWithBuffer(client, { to: this.hub as Address, data: data as Hex });
    } else {
      const fallbackLimit = BigInt(envInt("GAS_FALLBACK", 400_000));
      estimate = { gasLimit: fallbackLimit, fallback: true };
    }
    const fee = estimate.maxFeePerGas ?? 0n;
    return { gasLimit: estimate.gasLimit, fallback: estimate.fallback, costWei: estimate.gasLimit * fee };
  }

  private ensureGasClient(): GasClient | null {
    if (this.gasClient) return this.gasClient;
    const url = this.writeUrl();
    if (!url) return null;
    this.gasClient = createPublicClient({ chain: base, transport: http(url) });
    return this.gasClient;
  }

  private ensureTransport(): RelayTransport {
    if (this.transport) return this.transport;
    if (!this.sponsor || !this.sponsor.key || !this.sponsor.rpcUrl) {
      throw new Error("no-sponsor-transport");
    }
    this.transport = createProductionTransport(this.sponsor, this.rpcPool);
    return this.transport;
  }

  private writeUrl(): string | null {
    if (this.rpcPool) {
      const healthy = this.rpcPool.healthyUrls();
      if (healthy.length > 0) return healthy[0]!;
      const all = this.rpcPool.urlsInOrder();
      if (all.length > 0) return all[0]!;
    }
    return this.sponsor?.rpcUrl ?? null;
  }

  private async nextNonce(): Promise<number> {
    if (this.localNonce === null) {
      this.localNonce = await this.ensureTransport().getNonce();
    }
    const nonce = this.localNonce;
    this.localNonce = nonce + 1;
    return nonce;
  }

  /** Serialize all sponsored sends; one in-flight tx at a time. */
  private async serializeSend<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => fn(await this.nextNonce());
    const result = this.sendChain.then(run, run);
    this.sendChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Build a viem-backed transport. Reads fail over via the pool; a send is
 * broadcast to one healthy URL (broadcasting the same nonce to several URLs
 * risks duplicate hashes, so receipts — not retries — resolve outcomes). */
function createProductionTransport(sponsor: HardeningSponsor, rpcPool: RpcPool | null): RelayTransport {
  const account = privateKeyToAccount(sponsor.key as Hex);
  const pickUrl = (): string => {
    if (rpcPool) {
      const healthy = rpcPool.healthyUrls();
      if (healthy.length > 0) return healthy[0]!;
      const all = rpcPool.urlsInOrder();
      if (all.length > 0) return all[0]!;
    }
    if (sponsor.rpcUrl) return sponsor.rpcUrl;
    throw new Error("no-rpc-url");
  };
  return {
    async getNonce(): Promise<number> {
      const read = async (url: string): Promise<number> => {
        const client = createPublicClient({ chain: base, transport: http(url) });
        return client.getTransactionCount({ address: account.address, blockTag: "pending" });
      };
      if (rpcPool) return rpcPool.read(read);
      return read(pickUrl());
    },
    async send(tx: RelayTxRequest): Promise<Hash> {
      const url = pickUrl();
      const wallet = createWalletClient({ account, chain: base, transport: http(url) });
      try {
        return await wallet.sendTransaction({
          account,
          chain: base,
          to: tx.to,
          data: tx.data,
          nonce: tx.nonce,
          ...(tx.gas !== undefined ? { gas: tx.gas } : {}),
          ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas } : {}),
          ...(tx.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
        });
      } catch (error) {
        if (rpcPool) rpcPool.markFailure(url);
        throw error;
      }
    },
  };
}

// ---- Receipt reconciliation ----

export interface ReconcileOutcome {
  readonly key: string;
  readonly txHash: string;
  readonly status: "confirmed" | "reverted" | "pending";
  readonly reason: string;
}

/** Optional store capability (not on the base Store interface). */
export interface RelayStatusLister {
  listRelayByStatus?(status: string): Promise<RelayJob[]>;
}

/**
 * Resolve 'submitted' jobs against chain receipts.
 *   success  -> 'confirmed'
 *   reverted -> 'reverted'  (the exact reason: receipt.status === false)
 *   no receipt yet / unreadable -> left 'submitted' (unknown outcome; never
 *   resubmitted automatically).
 * Jobs are discovered through an optional `store.listRelayByStatus('submitted')`
 * and/or the explicit `keys` (the processor's own submitted set).
 */
export async function reconcileSubmitted(
  store: Store,
  reader: ChainReader | null,
  keys: readonly string[] = [],
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  if (!reader) return outcomes;

  const jobs: RelayJob[] = [];
  const lister = store as unknown as RelayStatusLister;
  if (typeof lister.listRelayByStatus === "function") {
    try {
      jobs.push(...(await lister.listRelayByStatus("submitted")));
    } catch {
      // optional capability failed; fall back to explicit keys
    }
  }
  for (const key of keys) {
    const job = await store.getRelay(key);
    if (job && job.status === "submitted" && job.txHash) jobs.push(job);
  }

  const seen = new Set<string>();
  for (const job of jobs) {
    if (!job.txHash || seen.has(job.idempotencyKey)) continue;
    seen.add(job.idempotencyKey);
    const txHash = job.txHash;
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await reader.getTransactionReceipt(txHash as Hash);
    } catch {
      receipt = null;
    }
    if (receipt === null) {
      outcomes.push({ key: job.idempotencyKey, txHash, status: "pending", reason: "no-receipt" });
      continue;
    }
    const finalStatus = receipt.status ? "confirmed" : "reverted";
    const reason = receipt.status ? "receipt-success" : "receipt-reverted";
    const result = { ...(job.result ?? {}), reason, blockNumber: receipt.blockNumber.toString() };
    await store.finishRelay(job.idempotencyKey, finalStatus, txHash, result);
    const dealId = dealIdOf(job);
    auditLog({
      actor: "reconcile",
      action: `relay.${job.action}.${finalStatus}`,
      ...(dealId !== null ? { dealId } : {}),
      details: { txHash, blockNumber: receipt.blockNumber.toString() },
    });
    outcomes.push({ key: job.idempotencyKey, txHash, status: finalStatus, reason });
  }
  return outcomes;
}

// ---- Module-level shared budget (spend reporting + live enforcement) ----

let sharedBudget: SponsorshipBudget | null = null;

/** The process-wide sponsorship budget used by the live worker path. */
export function defaultSponsorshipBudget(): SponsorshipBudget {
  if (sharedBudget === null) sharedBudget = new SponsorshipBudget();
  return sharedBudget;
}

/** Today's recorded sponsor spend in wei (0 when no budget has been created). */
export function sponsorSpendWei(): bigint {
  return sharedBudget?.used().wei ?? 0n;
}
