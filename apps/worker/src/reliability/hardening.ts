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
  keccak256,
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
import { SponsorNonceCoordinator } from "./nonce.js";

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

export interface CalldataValidationOptions {
  /** Configured hub address; a job whose `to`/`target` disagrees is rejected. */
  readonly hub?: Address | null;
}

/** Raw calldata for a job, accepting the legacy `data` and the API `calldata`. */
export function relayCalldataOf(job: { readonly params: Record<string, unknown> }): string | null {
  for (const field of ["data", "calldata"]) {
    const value = job.params[field];
    if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length >= 10) return value;
  }
  return null;
}

/** Extract the dealId a decoded calldata is bound to, if discoverable. */
function decodedDealId(args: readonly unknown[] | undefined): string | null {
  if (!args || args.length === 0) return null;
  const first = args[0] as unknown;
  if (typeof first === "string" && /^0x[0-9a-fA-F]{64}$/.test(first)) return first;
  if (first !== null && typeof first === "object") {
    const nested = (first as { dealId?: unknown }).dealId;
    if (typeof nested === "string") return nested;
  }
  for (const arg of args) {
    if (arg !== null && typeof arg === "object") {
      const nested = (arg as { dealId?: unknown }).dealId;
      if (typeof nested === "string") return nested;
    }
  }
  return null;
}

/**
 * Decode a job's calldata with HUB_ABI and assert:
 *   * the encoded function is allowed for the job's action,
 *   * the calldata's dealId is bound to the job's dealId (blocks a deal-A
 *     metadata record paired with deal-B calldata),
 *   * `fund` decodes as the full fund struct (not a bare selector), and
 *   * any explicit `to`/`target` matches the configured hub.
 * `data` defaults to `job.params.data` or `job.params.calldata` (the API emits
 * `calldata`); the legacy `data` spelling stays accepted.
 */
export function validateRelayJob(
  job: { readonly action: string; readonly params: Record<string, unknown> },
  data?: string | null,
  options: CalldataValidationOptions = {},
): CalldataValidation {
  const fallback = data ?? relayCalldataOf(job);
  if (fallback === null || !/^0x[0-9a-fA-F]*$/.test(fallback) || fallback.length < 10) {
    return { ok: false, functionName: null, reason: "no-calldata" };
  }
  const target = job.params["to"] ?? job.params["target"];
  if (
    options.hub !== undefined &&
    options.hub !== null &&
    typeof target === "string" &&
    target.toLowerCase() !== options.hub.toLowerCase()
  ) {
    return { ok: false, functionName: null, reason: "target-mismatch" };
  }
  let decoded: { functionName: string; args: readonly unknown[] } | null = null;
  try {
    const result = decodeFunctionData({ abi: HUB_ABI, data: fallback as Hex });
    decoded = { functionName: String(result.functionName), args: result.args ?? [] };
  } catch {
    return { ok: false, functionName: null, reason: "undecodable-calldata" };
  }
  const functionName = decoded.functionName;
  const allowed = ACTION_FUNCTION_MAP[job.action];
  if (allowed === undefined) return { ok: false, functionName, reason: "unknown-action" };
  if (!allowed.includes(functionName)) {
    return { ok: false, functionName, reason: "action-calldata-mismatch" };
  }
  const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const expectedDealId = job.params["dealId"];
  if (typeof expectedDealId === "string") {
    const bound = decodedDealId(decoded.args);
    // An all-zero dealId in calldata is a placeholder used by legacy builders,
    // so it is treated as unspecified; any concrete mismatch is rejected.
    if (bound !== null && bound.toLowerCase() !== ZERO32 && bound.toLowerCase() !== expectedDealId.toLowerCase()) {
      return { ok: false, functionName, reason: "deal-mismatch" };
    }
    if (bound === null && job.action === "fund") {
      return { ok: false, functionName, reason: "fund-struct-undecoded" };
    }
  }
  if (job.action === "fund") {
    const term = decoded.args[0] as { dealId?: unknown } | null | undefined;
    if (term === null || typeof term !== "object" || typeof term.dealId !== "string") {
      return { ok: false, functionName, reason: "fund-struct-undecoded" };
    }
    const expectedNonce = job.params["nonce"];
    if (typeof expectedNonce === "string" && expectedNonce.startsWith("0x")) {
      const termNonce = (term as { nonce?: unknown }).nonce;
      if (typeof termNonce === "string" && termNonce.toLowerCase() !== expectedNonce.toLowerCase()) {
        return { ok: false, functionName, reason: "nonce-mismatch" };
      }
    }
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

export interface SignedRelayTx {
  readonly raw: Hex;
  readonly hash: Hash;
}

export interface RelayTransport {
  getNonce(): Promise<number>;
  send(tx: RelayTxRequest): Promise<Hash>;
  /**
   * Optional two-phase path: sign locally so the raw transaction + hash can be
   * persisted BEFORE broadcast (ambiguous timeouts are then resolvable). When
   * absent the legacy single-phase `send` is used.
   */
  sign?(tx: RelayTxRequest): Promise<SignedRelayTx>;
  sendRaw?(raw: Hex): Promise<Hash>;
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
  const data = params["data"] ?? params["calldata"];
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
 * Lease algorithm (DB-owned, ownership verified):
 *   claim = store.claimRelayLease(key, owner, ttl)
 *     // atomic: queued OR processing-with-expired-lease -> processing
 *     // sets lease_owner/lease_expires_at/version
 *   before any mutation: renewRelayLease(key, owner, ttl) must succeed,
 *     otherwise the worker lost its lease and refuses to mutate (stale owner).
 *   A live lease owned by another worker is never stolen; the legacy
 *   result.leaseAt stamp is still honoured for pre-lease rows.
 *
 * Nonce algorithm (durable, cross-worker):
 *   SponsorNonceCoordinator reserves the next nonce through store.nextSeq,
 *   seeded from the chain pending count only when no reservation exists, and
 *   persists the high-water mark so two workers never reuse a nonce.
 *
 * Tx identity: with a two-phase transport the signed tx (hash + raw) is
 * persisted BEFORE broadcast; an ambiguous timeout leaves the job 'submitted'
 * (never 'failed') and the same signed tx can be rebroadcast.
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
  private readonly sponsorAddress: Address | null;
  private readonly nonce: SponsorNonceCoordinator | null;
  private readonly submittedKeys = new Set<string>();
  private transport: RelayTransport | null;
  private gasClient: GasClient | null;
  private sendChain: Promise<unknown> = Promise.resolve();

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
    // Distinct per instance (not per-process) so two in-process workers cannot
    // masquerade as each other's lease owner.
    this.leaseOwner = `worker-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    this.transport = options.transport ?? null;
    this.gasClient = options.gasClient ?? null;
    const sponsorKey = this.sponsor?.key ?? null;
    this.sponsorAddress = sponsorKey !== null ? privateKeyToAccount(sponsorKey as Hex).address : null;
    this.nonce =
      this.sponsorAddress !== null
        ? new SponsorNonceCoordinator(this.store, () => this.ensureTransport().getNonce())
        : null;
  }

  /** Keys submitted by this processor; fed to reconcileSubmitted each pass. */
  submittedKeysList(): string[] {
    return [...this.submittedKeys];
  }

  /** The worker identity used for lease ownership (owner + version checks). */
  ownerId(): string {
    return this.leaseOwner;
  }

  async process(idempotencyKey: string): Promise<RelayProcessResult> {
    const existing = await this.store.getRelay(idempotencyKey);
    if (!existing) return { status: "missing", txHash: null };

    // (3) Reconcile a persisted tx identity BEFORE building anything new. A
    // job with a known hash is never re-minted; if the receipt is not visible
    // yet the job stays 'submitted' (unresolved), never 'failed'.
    if (existing.txHash && (existing.status === "submitted" || existing.status === "unresolved" || existing.status === "processing")) {
      if (this.reader) {
        const resolved = await this.reconcileOne(existing);
        if (resolved !== null) return resolved;
        // Receipt not visible yet. If the signed tx was persisted, automatically
        // rebroadcast the SAME bytes (same hash) to recover a dropped broadcast.
        const attempt = (existing.result?.["attempt"] ?? null) as { raw?: unknown } | null;
        if (this.sponsor?.key && typeof attempt?.raw === "string") {
          try {
            const rebroadcast = await this.rebroadcast(existing.idempotencyKey);
            if (rebroadcast.status === "submitted") return rebroadcast;
          } catch {
            // Fall through to receipt-pending; a rebroadcast failure is benign.
          }
        }
        return { status: "submitted", txHash: existing.txHash, reason: "receipt-pending" };
      }
      return { status: "already-handled", txHash: existing.txHash };
    }

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

    // Acquire the lease BEFORE evaluating preconditions or mutating state: only
    // the lease owner may mark a job terminal, so a second processor can never
    // mark 'skipped'/'failed' while another worker holds a valid lease.
    const job = await this.claim(existing);
    if (!job) return { status: "already-handled", txHash: existing.txHash, reason: "lease-held" };
    if (job.attempts > this.maxAttempts) {
      await this.retire(job, "failed", "max-attempts-exceeded");
      return { status: "failed", txHash: null, reason: "max-attempts-exceeded" };
    }

    const dealId = job.params["dealId"] as Hash | undefined;
    if (!this.hub || !dealId) {
      await this.retire(job, "failed", "no-hub-or-deal");
      return { status: "failed", txHash: null, reason: "no-hub-or-deal" };
    }

    const pre = await this.check(this.reader, this.hub, job.action, dealId, job.params);
    if (!pre.ok) {
      await this.retire(job, "skipped", pre.reason);
      return { status: "skipped", txHash: null, reason: pre.reason };
    }

    const data = this.build(job.action, dealId, job.params);
    if (!data) {
      await this.retire(job, "failed", "no-calldata");
      return { status: "failed", txHash: null, reason: "no-calldata" };
    }
    const validation = validateRelayJob(job, data, { hub: this.hub });
    if (!validation.ok) {
      const reason = `calldata-mismatch:${validation.reason}:${validation.functionName ?? "?"}`;
      await this.retire(job, "failed", reason);
      return { status: "failed", txHash: null, reason, functionName: validation.functionName };
    }

    // Ownership check: if our lease was lost to another worker (or reaped),
    // refuse to mutate the job — a stale owner must never overwrite state.
    const owned = await this.store.renewRelayLease(idempotencyKey, this.leaseOwner, this.leaseTtlSeconds);
    if (!owned) return { status: "already-handled", txHash: existing.txHash, reason: "lease-lost" };

    // No sponsor => hand back unsigned calldata (operator can submit manually).
    if (!this.sponsor || !this.sponsor.key || !this.sponsor.rpcUrl) {
      const applied = await this.store.finishRelayOwned(idempotencyKey, "unsigned", null, { to: this.hub, data }, this.leaseOwner);
      if (!applied) return { status: "already-handled", txHash: existing.txHash, reason: "lease-lost" };
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
      const applied = await this.store.finishRelayOwned(
        idempotencyKey,
        "unsigned",
        null,
        { to: this.hub, data, reason: "budget-exhausted" },
        this.leaseOwner,
      );
      if (!applied) return { status: "already-handled", txHash: existing.txHash, reason: "lease-lost" };
      return { status: "unsigned", txHash: null, reason: "budget-exhausted" };
    }

    // Legacy daily transaction cap kept for parity with the previous path.
    const sinceIso = new Date((this.now() - 86_400) * 1_000).toISOString();
    const spent = await this.store.countSponsorsSince(sinceIso);
    if (spent >= this.sponsor.dailyCapTxs) {
      const applied = await this.store.finishRelayOwned(
        idempotencyKey,
        "unsigned",
        null,
        { to: this.hub, data, reason: "daily-cap" },
        this.leaseOwner,
      );
      if (!applied) return { status: "already-handled", txHash: existing.txHash, reason: "lease-lost" };
      return { status: "unsigned", txHash: null, reason: "daily-cap" };
    }

    // (6) Reserve sponsorship atomically before send. The reservation is a
    // durable ledger row, so concurrent workers cannot both spend the last
    // unit of budget, and the spend survives a restart.
    const attemptId = `${idempotencyKey}#${job.attempts}`;
    const reservation = await this.store.reserveSponsorship(
      `reserve:${attemptId}`,
      dealIdOf(job),
      job.action,
      this.sponsor.dailyCapTxs,
      sinceIso,
    );
    if (!reservation.granted) {
      const applied = await this.store.finishRelayOwned(
        idempotencyKey,
        "unsigned",
        null,
        { to: this.hub, data, reason: "budget-exhausted" },
        this.leaseOwner,
      );
      if (!applied) return { status: "already-handled", txHash: existing.txHash, reason: "lease-lost" };
      return { status: "unsigned", txHash: null, reason: "budget-exhausted" };
    }

    try {
      const outcome = await this.serializeSend(async () => {
        const nonce = this.nonce ? await this.nonce.allocate(this.sponsorAddress as Address) : 0;
        const request: RelayTxRequest = {
          ...this.txRequest(this.hub as Address, data, nonce),
          gas: estimate.gasLimit,
          ...(estimate.maxFeePerGas !== undefined ? { maxFeePerGas: estimate.maxFeePerGas } : {}),
          ...(estimate.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: estimate.maxPriorityFeePerGas } : {}),
        };
        const transport = this.ensureTransport();
        if (typeof transport.sign === "function") {
          const signed = await transport.sign(request);
          const attempt = {
            id: attemptId,
            sponsor: this.sponsorAddress,
            nonce,
            txHash: signed.hash,
            raw: signed.raw,
            gas: estimate.gasLimit.toString(),
            maxFeePerGas: estimate.maxFeePerGas?.toString() ?? null,
            maxPriorityFeePerGas: estimate.maxPriorityFeePerGas?.toString() ?? null,
            reservedAt: this.now(),
            costWei: estimate.costWei.toString(),
          };
          // Persist identity + raw signed tx BEFORE broadcast.
          await this.store.finishRelayOwned(
            idempotencyKey,
            "submitted",
            signed.hash,
            { to: this.hub, data, attempt },
            this.leaseOwner,
          );
          if (typeof transport.sendRaw === "function") {
            try {
              const broadcast = await transport.sendRaw(signed.raw);
              if (broadcast !== signed.hash) {
                await this.store.finishRelayOwned(
                  idempotencyKey,
                  "submitted",
                  broadcast,
                  { to: this.hub, data, attempt: { ...attempt, txHash: broadcast, rebroadcastHash: signed.hash } },
                  this.leaseOwner,
                );
                return { status: "submitted" as const, txHash: broadcast, unresolved: false };
              }
            } catch (error) {
              // Ambiguous transport failure: the tx may be on-chain. Keep the
              // persisted hash and stay 'submitted'; never mark 'failed'.
              return { status: "submitted" as const, txHash: signed.hash, unresolved: true };
            }
          }
          return { status: "submitted" as const, txHash: signed.hash, unresolved: false };
        }
        // Legacy single-phase transport: send, then persist the outcome.
        const txHash = await transport.send(request);
        return { status: "submitted" as const, txHash, unresolved: false, nonce };
      });

      if (outcome.unresolved) {
        this.submittedKeys.add(idempotencyKey);
        auditLog({
          actor: "relay",
          action: `relay.${job.action}.unresolved`,
          ...(dealIdOf(job) !== null ? { dealId: dealIdOf(job)! } : {}),
          details: { txHash: outcome.txHash, attemptId },
        });
        return { status: "submitted", txHash: outcome.txHash, reason: "unresolved" };
      }

      if ((outcome as { nonce?: number }).nonce === undefined) {
        // Two-phase path already persisted the job as submitted.
        this.submittedKeys.add(idempotencyKey);
      } else {
        await this.store.finishRelayOwned(
          idempotencyKey,
          "submitted",
          outcome.txHash,
          {
            to: this.hub,
            data,
            sponsor: this.sponsorAddress,
            attempt: { id: attemptId, nonce: (outcome as { nonce?: number }).nonce ?? null },
          },
          this.leaseOwner,
        );
        this.submittedKeys.add(idempotencyKey);
      }
      if (this.budget) this.budget.record(outcome.txHash, estimate.costWei, this.now());
      auditLog({
        actor: "relay",
        action: `relay.${job.action}.submitted`,
        ...(dealIdOf(job) !== null ? { dealId: dealIdOf(job)! } : {}),
        details: { txHash: outcome.txHash, gasLimit: estimate.gasLimit.toString(), fallback: estimate.fallback },
      });
      return { status: "submitted", txHash: outcome.txHash };
    } catch (error) {
      // A synchronous pre-broadcast failure (signing/validation) may retry;
      // ambiguous/timeouts are unresolved and never auto-resubmitted.
      if (this.isUnresolved(error)) {
        auditLog({
          actor: "relay",
          action: `relay.${job.action}.unresolved`,
          ...(dealIdOf(job) !== null ? { dealId: dealIdOf(job)! } : {}),
          details: { reason: error instanceof Error ? error.message : "unresolved" },
        });
        return { status: "unresolved", txHash: job.txHash };
      }
      const reason = error instanceof Error ? error.message : "send-failed";
      return this.retryOrFail(job, reason);
    }
  }

  /**
   * Rebroadcast the SAME persisted signed transaction (no new nonce, no new
   * signature). Safe after an ambiguous timeout: the hash is unchanged.
   */
  async rebroadcast(idempotencyKey: string): Promise<RelayProcessResult> {
    const job = await this.store.getRelay(idempotencyKey);
    if (!job) return { status: "missing", txHash: null };
    const attempt = (job.result?.["attempt"] ?? null) as { raw?: string; txHash?: string } | null;
    if (!attempt || typeof attempt.raw !== "string") {
      return { status: "no-signed-tx", txHash: job.txHash };
    }
    const transport = this.ensureTransport();
    if (typeof transport.sendRaw !== "function") {
      return { status: "no-raw-support", txHash: job.txHash };
    }
    try {
      const hash = await transport.sendRaw(attempt.raw as Hex);
      await this.store.finishRelay(idempotencyKey, "submitted", hash, job.result);
      this.submittedKeys.add(idempotencyKey);
      return { status: "submitted", txHash: hash };
    } catch (error) {
      return {
        status: "unresolved",
        txHash: job.txHash,
        reason: error instanceof Error ? error.message : "rebroadcast-failed",
      };
    }
  }

  private isUnresolved(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return /timeout|timed out|etimedout|econnreset|socket hang up|already known|not known|replacement transaction|nonce too low|underpriced|network|503|502|429/.test(
      message,
    );
  }

  private async reconcileOne(job: RelayJob): Promise<RelayProcessResult | null> {
    if (!this.reader || !job.txHash) return null;
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await this.reader.getTransactionReceipt(job.txHash as Hash);
    } catch {
      receipt = null;
    }
    if (receipt === null) return null;
    if (!receipt.status) {
      // A revert is only terminal once it cannot be reorged away.
      if ((await receiptFinality(this.reader, receipt)) === "confirmed") return null;
      const result = {
        ...(job.result ?? {}),
        reason: "receipt-reverted",
        blockNumber: receipt.blockNumber.toString(),
      };
      await this.store.finishRelay(job.idempotencyKey, "reverted", job.txHash, result);
      return { status: "reverted", txHash: job.txHash };
    }
    const finality = await receiptFinality(this.reader, receipt);
    const status = finality === "finalized" ? "finalized" : "confirmed";
    const result = {
      ...(job.result ?? {}),
      reason: `receipt-${status}`,
      blockNumber: receipt.blockNumber.toString(),
    };
    await this.store.finishRelay(job.idempotencyKey, status, job.txHash, result);
    return { status, txHash: job.txHash };
  }

  private abuseKey(job: RelayJob): string {
    const dealId = dealIdOf(job);
    return dealId === null ? job.idempotencyKey : `${job.action}:${dealId}`;
  }

  private async retire(job: RelayJob, status: string, reason: string): Promise<void> {
    // Ownership-guarded: a stale worker must not finalize a job it no longer owns.
    const applied = await this.store.finishRelayOwned(
      job.idempotencyKey,
      status,
      null,
      { reason },
      this.leaseOwner,
    );
    if (!applied) return;
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
    const applied = await this.store.finishRelayOwned(job.idempotencyKey, "queued", null, result, this.leaseOwner);
    if (!applied) return { status: "already-handled", txHash: null, reason: "lease-lost" };
    const dealId = dealIdOf(job);
    auditLog({
      actor: "relay",
      action: `relay.${job.action}.retry`,
      ...(dealId !== null ? { dealId } : {}),
      details: { reason, attempts: job.attempts, retryInSeconds: backoff },
    });
    return { status: "retrying", txHash: null, reason };
  }

  /**
   * Lease acquisition for this worker (owner + expiry + version live on the
   * job row). A live lease means another worker owns it; a missing/expired
   * lease is reclaimed via `claimRelayLease`. The legacy `result.leaseAt`
   * stamp is still honoured so pre-lease rows recover the same way.
   */
  private async claim(existing: RelayJob): Promise<RelayJob | null> {
    const key = existing.idempotencyKey;
    if (existing.status === "processing" && existing.leaseOwner === this.leaseOwner) {
      const renewed = await this.store.renewRelayLease(key, this.leaseOwner, this.leaseTtlSeconds);
      if (renewed) return { ...existing, leaseExpiresAt: new Date(Date.now() + this.leaseTtlSeconds * 1_000).toISOString() };
    }
    if (existing.status === "processing" && existing.leaseOwner !== this.leaseOwner) {
      const expiry = existing.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : null;
      if (expiry !== null && Number.isFinite(expiry) && expiry > this.now() * 1_000) return null;
      const legacyAt = leaseAtOf(existing);
      if (expiry === null && legacyAt !== null && this.now() - legacyAt < this.leaseTtlSeconds) return null;
    }
    return this.store.claimRelayLease(key, this.leaseOwner, this.leaseTtlSeconds);
  }

  private txRequest(to: Address, data: Hash, nonce: number): RelayTxRequest {
    return { to, data: data as Hex, nonce };
  }

  private async estimate(
    _job: RelayJob,
    data: Hash,
  ): Promise<{
    gasLimit: bigint;
    fallback: boolean;
    costWei: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }> {
    const client = this.ensureGasClient();
    let estimate: GasEstimate;
    if (client) {
      estimate = await estimateGasWithBuffer(client, { to: this.hub as Address, data: data as Hex });
    } else {
      const fallbackLimit = BigInt(envInt("GAS_FALLBACK", 400_000));
      estimate = { gasLimit: fallbackLimit, fallback: true };
    }
    const fee = estimate.maxFeePerGas ?? 0n;
    return {
      gasLimit: estimate.gasLimit,
      fallback: estimate.fallback,
      costWei: estimate.gasLimit * fee,
      ...(estimate.maxFeePerGas !== undefined ? { maxFeePerGas: estimate.maxFeePerGas } : {}),
      ...(estimate.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: estimate.maxPriorityFeePerGas }
        : {}),
    };
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

  /** Serialize all sponsored sends; one in-flight tx at a time. */
  private async serializeSend<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => fn();
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
    async sign(tx: RelayTxRequest): Promise<SignedRelayTx> {
      const url = pickUrl();
      const wallet = createWalletClient({ account, chain: base, transport: http(url) });
      const request = await wallet.prepareTransactionRequest({
        account,
        chain: base,
        to: tx.to,
        data: tx.data,
        nonce: tx.nonce,
        ...(tx.gas !== undefined ? { gas: tx.gas } : {}),
        ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas } : {}),
        ...(tx.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
      });
      const raw = await wallet.signTransaction(request);
      return { raw, hash: keccak256(raw) };
    },
    async sendRaw(raw: Hex): Promise<Hash> {
      const url = pickUrl();
      const client = createPublicClient({ chain: base, transport: http(url) });
      try {
        return await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (error) {
        if (rpcPool) rpcPool.markFailure(url);
        throw error;
      }
    },
  };
}

/**
 * Classify a receipt's finality. A single receipt is only a *tentative*
 * confirmation: it becomes terminal ('finalized') only once its block is at or
 * below the chain's finalized head. Without finality support (reader lacking
 * getBlockByTag, or pre-finality chains) the job stays 'confirmed' and is
 * re-checked on the next pass, so a reorg can still orphan it.
 */
async function receiptFinality(
  reader: ChainReader,
  receipt: TransactionReceipt,
): Promise<"confirmed" | "finalized" | "unknown"> {
  // A reader with no finality provider cannot distinguish "not yet final" from
  // "final"; report 'unknown' so callers stop waiting on a signal that will
  // never arrive (but still never claim a success above a known final head).
  if (typeof reader.getBlockByTag !== "function") return "unknown";
  try {
    const finalized = await reader.getBlockByTag("finalized");
    if (finalized !== null && receipt.blockNumber <= finalized.number) return "finalized";
    return "confirmed";
  } catch {
    return "unknown";
  }
}

// ---- Receipt reconciliation ----

export type ReconcileStatus = "finalized" | "confirmed" | "reverted" | "orphaned" | "pending";

export interface ReconcileOutcome {
  readonly key: string;
  readonly txHash: string;
  readonly status: ReconcileStatus;
  readonly reason: string;
}

// 'orphaned' is re-listed so a reorg-reverted-then-reincluded tx is recovered;
// only 'finalized'/'failed'/'unsigned' are genuinely terminal.
const RECONCILE_STATUSES = ["submitted", "confirmed", "unresolved", "orphaned"] as const;
const RECONCILE_LIMIT = 500;

/**
 * Resolve submitted (and tentatively confirmed) jobs against chain receipts.
 *
 *   success below the finalized head -> 'finalized' (terminal)
 *   success above the finalized head  -> 'confirmed' (tentative; re-checked)
 *   reverted                         -> 'reverted'  (terminal)
 *   no receipt now but was confirmed -> 'orphaned'  (reorg corrected)
 *   no receipt yet                   -> left 'submitted' (unknown outcome)
 *
 * A single receipt never permanently confirms a job: 'confirmed' rows are
 * re-listed on every pass and only 'finalized' is terminal. Jobs are
 * discovered through the mandatory `store.listRelayByStatus` query plus any
 * explicitly supplied keys.
 */
export async function reconcileSubmitted(
  store: Store,
  reader: ChainReader | null,
  keys: readonly string[] = [],
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  if (!reader) return outcomes;

  const jobs: RelayJob[] = [];
  for (const status of RECONCILE_STATUSES) {
    jobs.push(...(await store.listRelayByStatus(status, RECONCILE_LIMIT)));
  }
  for (const key of keys) {
    const job = await store.getRelay(key);
    if (job && job.txHash && (RECONCILE_STATUSES as readonly string[]).includes(job.status)) jobs.push(job);
  }

  const seen = new Set<string>();
  for (const job of jobs) {
    if (!job.txHash || seen.has(job.idempotencyKey)) continue;
    seen.add(job.idempotencyKey);
    const txHash = job.txHash;
    let receipt: TransactionReceipt | null = null;
    let readFailed = false;
    try {
      receipt = await reader.getTransactionReceipt(txHash as Hash);
    } catch {
      // An RPC exception is UNKNOWN, not proof the receipt disappeared.
      readFailed = true;
      receipt = null;
    }
    if (receipt === null) {
      if (readFailed) {
        outcomes.push({ key: job.idempotencyKey, txHash, status: "pending", reason: "rpc-unavailable" });
        continue;
      }
      if (job.status === "confirmed" || job.status === "orphaned") {
        // Verified absence: previously mined, now gone -> reorg corrected.
        const result = { ...(job.result ?? {}), reason: "receipt-disappeared" };
        await store.finishRelay(job.idempotencyKey, "orphaned", txHash, result);
        const dealId = dealIdOf(job);
        auditLog({
          actor: "reconcile",
          action: `relay.${job.action}.orphaned`,
          ...(dealId !== null ? { dealId } : {}),
          details: { txHash },
        });
        outcomes.push({ key: job.idempotencyKey, txHash, status: "orphaned", reason: "receipt-disappeared" });
      } else {
        outcomes.push({ key: job.idempotencyKey, txHash, status: "pending", reason: "no-receipt" });
      }
      continue;
    }
    if (!receipt.status) {
      // A reverted receipt is NOT terminal until its block is finalized: until
      // then it may still be reorged away, so keep it recoverable.
      const finality = await receiptFinality(reader, receipt);
      // 'confirmed' = above a known final head (may reorg): keep recoverable.
      // 'finalized'/'unknown' = no further deferral is possible.
      if (finality === "confirmed") {
        outcomes.push({ key: job.idempotencyKey, txHash, status: "pending", reason: "reverted-pending-finality" });
        continue;
      }
      const result = {
        ...(job.result ?? {}),
        reason: "receipt-reverted",
        blockNumber: receipt.blockNumber.toString(),
        blockLinkedAt: new Date().toISOString(),
      };
      await store.finishRelay(job.idempotencyKey, "reverted", txHash, result);
      outcomes.push({ key: job.idempotencyKey, txHash, status: "reverted", reason: "receipt-reverted" });
      continue;
    }
    const finality = await receiptFinality(reader, receipt);
    const finalStatus: ReconcileStatus = finality === "finalized" ? "finalized" : "confirmed";
    const reason = `receipt-${finalStatus}`;
    const result = {
      ...(job.result ?? {}),
      reason,
      blockNumber: receipt.blockNumber.toString(),
      blockLinkedAt: new Date().toISOString(),
    };
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

/**
 * Recovery snapshot: every non-terminal relay status discoverable through the
 * mandatory `listRelayByStatus` query. Used by health/ops surfaces so recovery
 * work is never silently hidden when a capability probe is absent.
 */
export async function relayRecoverySnapshot(store: Store): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const status of ["queued", "processing", "submitted", "unresolved", "failed"]) {
    counts[status] = (await store.listRelayByStatus(status, RECONCILE_LIMIT)).length;
  }
  return counts;
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
