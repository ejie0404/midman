// Relay worker: idempotent, precondition-checked, budget-capped submission.
// Retries never duplicate: outbox keys are unique, on-chain nonces are
// single-use, and unknown-outcome jobs are NOT auto-resubmitted (an operator
// re-queues explicitly after checking the chain).
import { encodeFunctionData, encodeAbiParameters, keccak256, type Address, type Hash } from "viem";
import { HUB_ABI, type ChainReader } from "@midman/chain";
import type { Store } from "@midman/store";
import { RelayProcessor, type HardeningSponsor, type RelayTransport } from "./reliability/hardening.js";
import type { GasClient } from "./reliability/gas.js";
import type { AbuseControls } from "./reliability/abuse.js";
import type { SponsorshipBudget } from "./reliability/budget.js";
import type { RpcPool } from "./reliability/rpcPool.js";

export interface SponsorConfig {
  readonly key: string | null;
  readonly rpcUrl: string | null;
  readonly dailyCapTxs: number;
}

export function sponsorConfigFromEnv(): SponsorConfig {
  const key = process.env["SPONSOR_KEY"] ?? null;
  const rpcUrl = (process.env["BASE_RPC_URLS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0] ?? null;
  return { key, rpcUrl, dailyCapTxs: Number(process.env["SPONSOR_DAILY_CAP_TXS"] ?? "50") };
}

const hex = (value: unknown, field: string): Hash => {
  if (typeof value !== "string" || !value.startsWith("0x")) throw new Error(`Missing ${field}`);
  return value as Hash;
};

const big = (value: unknown, field: string): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(`Missing ${field}`);
};

const num = (value: unknown, field: string): number => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  throw new Error(`Missing ${field}`);
};

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/// @notice ReserveExistingClaim authorization tuple (8th arg of escalate /
/// postRespondentBond). For fresh-token bonds (collateralSource 0 /
/// useExistingClaim false) the contract never reads it, so an all-zero tuple
/// is supplied. For claim-backed bonds the caller must supply the
/// claim-owner's signed authorization fields.
function reserveTuple(params: Record<string, unknown>): {
  owner: Address;
  sourceClaimId: Hash;
  amount: bigint;
  party: number;
  nonce: Hash;
  expiresAt: bigint;
  signature: Hash;
} {
  const r = (params["reserve"] ?? {}) as Record<string, unknown>;
  return {
    owner: (typeof r["owner"] === "string" ? (r["owner"] as Address) : (ZERO_ADDR as Address)),
    sourceClaimId: (typeof r["sourceClaimId"] === "string" ? (r["sourceClaimId"] as Hash) : (ZERO_HASH as Hash)),
    amount: r["amount"] === undefined ? 0n : big(r["amount"], "reserve.amount"),
    party: r["party"] === undefined ? 0 : num(r["party"], "reserve.party"),
    nonce: (typeof r["nonce"] === "string" ? (r["nonce"] as Hash) : (ZERO_HASH as Hash)),
    expiresAt: r["expiresAt"] === undefined ? 0n : BigInt(num(r["expiresAt"], "reserve.expiresAt")),
    signature: (typeof r["signature"] === "string" ? (r["signature"] as Hash) : ("0x" as Hash)),
  };
}

function buildCalldata(action: string, dealId: Hash, params: Record<string, unknown>): Hash | null {
  try {
    switch (action) {
      case "refundForNonDelivery":
      case "finalizeAfterTimeout":
      case "lapseDispute":
      case "advanceToPrimary":
      case "activateFallback":
      case "executeRuling":
      case "markDeadlock":
      case "catastrophicEscape":
        return encodeFunctionData({ abi: HUB_ABI, functionName: action, args: [dealId] }) as Hash;
      case "claimFor":
        return encodeFunctionData({
          abi: HUB_ABI,
          functionName: "claimFor",
          args: [dealId, num(params["kind"], "kind")],
        }) as Hash;
      case "markDelivered":
        return encodeFunctionData({
          abi: HUB_ABI,
          functionName: "markDelivered",
          args: [dealId, hex(params["manifestHash"], "manifestHash"), hex(params["nonce"], "nonce"), BigInt(num(params["expiresAt"], "expiresAt")), hex(params["sig"], "sig")],
        }) as Hash;
      case "approveSeller":
      case "refundBuyer":
        return encodeFunctionData({
          abi: HUB_ABI,
          functionName: action,
          args: [
            dealId,
            hex(params["terminalPolicyVersion"], "terminalPolicyVersion"),
            hex(params["nonce"], "nonce"),
            BigInt(num(params["expiresAt"], "expiresAt")),
            hex(params["sig"], "sig"),
          ],
        }) as Hash;
      case "mutualSettlement":
        return encodeFunctionData({
          abi: HUB_ABI,
          functionName: "mutualSettlement",
          args: [
            dealId,
            big(params["sellerAward"], "sellerAward"),
            big(params["buyerCost"], "buyerCost"),
            big(params["sellerCost"], "sellerCost"),
            num(params["expectedPhase"], "expectedPhase"),
            hex(params["settlementNonce"], "settlementNonce"),
            BigInt(num(params["expiresAt"], "expiresAt")),
            hex(params["sigBuyer"], "sigBuyer"),
            hex(params["sigSeller"], "sigSeller"),
          ],
        }) as Hash;
      case "escalate":
        return encodeFunctionData({
          abi: HUB_ABI,
          functionName: "escalate",
          args: [
            dealId,
            big(params["collateralAmount"], "collateralAmount"),
            num(params["collateralSource"], "collateralSource"),
            hex(params["claimId"], "claimId"),
            hex(params["nonce"], "nonce"),
            BigInt(num(params["expiresAt"], "expiresAt")),
            hex(params["sig"], "sig"),
            reserveTuple(params),
          ],
        }) as Hash;
      case "postRespondentBond":
        return encodeFunctionData({
          abi: HUB_ABI,
          functionName: "postRespondentBond",
          args: [
            dealId,
            big(params["amount"], "amount"),
            Boolean(params["useExistingClaim"]),
            hex(params["claimId"], "claimId"),
            hex(params["nonce"], "nonce"),
            BigInt(num(params["expiresAt"], "expiresAt")),
            hex(params["sig"], "sig"),
            reserveTuple(params),
          ],
        }) as Hash;
      case "openDispute":
        return encodeFunctionData({
          abi: HUB_ABI,
          functionName: "openDispute",
          args: [
            dealId,
            num(params["reasonCode"] ?? 0, "reasonCode"),
            hex(params["initialCommitment"] ?? "0x0000000000000000000000000000000000000000000000000000000000000000", "initialCommitment"),
            hex(params["nonce"], "nonce"),
            BigInt(num(params["expiresAt"], "expiresAt")),
            hex(params["sig"], "sig"),
          ],
        }) as Hash;
      default:
        // fund, evidence, rulings, vetoes carry complex nested payloads;
        // clients pre-encode and supply `data` (legacy) or `calldata` (API).
        // Both are accepted; the decoded function is validated downstream.
        if (typeof params["data"] === "string" && (params["data"] as string).startsWith("0x")) {
          return params["data"] as Hash;
        }
        if (typeof params["calldata"] === "string" && (params["calldata"] as string).startsWith("0x")) {
          return params["calldata"] as Hash;
        }
        return null;
    }
  } catch {
    return null;
  }
}

/** Light preconditions (the contract is the final arbiter). Null = no check. */
async function checkPreconditions(
  reader: ChainReader | null,
  hub: Address | null,
  action: string,
  dealId: Hash,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; reason: string }> {
  if (!reader || !hub) return { ok: true, reason: "no-reader" };
  let deal: Record<string, bigint | string | boolean | number>;
  try {
    deal = await reader.getDeal(hub, dealId);
  } catch {
    return { ok: false, reason: "deal-unreadable" };
  }
  if (deal["funded"] !== true) {
    return action === "fund" ? { ok: true, reason: "unfunded" } : { ok: false, reason: "not-funded" };
  }
  const phase = Number(deal["phase"]);
  const active = phase !== 9;
  switch (action) {
    case "openDispute":
      return phase === 1 && deal["disputeUsed"] !== true ? { ok: true, reason: "ok" } : { ok: false, reason: "not-disputable" };
    case "markDelivered":
      return phase === 0 ? { ok: true, reason: "ok" } : { ok: false, reason: "wrong-phase" };
    case "finalizeAfterTimeout":
      return phase === 1 ? { ok: true, reason: "ok" } : { ok: false, reason: "wrong-phase" };
    case "approveSeller":
    case "refundBuyer":
    case "mutualSettlement":
      return active ? { ok: true, reason: "ok" } : { ok: false, reason: "settled" };
    case "escalate":
      return phase === 2 || phase === 3 ? { ok: true, reason: "ok" } : { ok: false, reason: "wrong-phase" };
    case "postRespondentBond":
    case "submitEvidenceCommitment":
      return phase === 4 ? { ok: true, reason: "ok" } : { ok: false, reason: "wrong-phase" };
    case "queuePrimaryRuling":
      return phase === 5 ? { ok: true, reason: "ok" } : { ok: false, reason: "wrong-phase" };
    case "queueFallbackRuling":
      return phase === 6 ? { ok: true, reason: "ok" } : { ok: false, reason: "wrong-phase" };
    case "vetoPrimaryRuling":
    case "vetoFallbackRuling":
    case "executeRuling":
      return phase === 7 ? { ok: true, reason: "ok" } : { ok: false, reason: "wrong-phase" };
    case "claimFor": {
      const kind = Number(params["kind"] ?? -1);
      if (!Number.isInteger(kind) || kind < 0 || kind > 5) return { ok: false, reason: "bad-kind" };
      const claimId = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }], [dealId, kind]));
      try {
        const claim = await reader.getClaim(hub, claimId);
        return claim.amount > 0n ? { ok: true, reason: "ok" } : { ok: false, reason: "empty-claim" };
      } catch {
        return { ok: false, reason: "claim-unreadable" };
      }
    }
    default:
      return { ok: true, reason: "contract-arbiter" };
  }
}

export interface ProcessRelayJobParams {
  readonly store: Store;
  readonly reader: ChainReader | null;
  readonly hub: Address | null;
  readonly sponsor: SponsorConfig;
  readonly idempotencyKey: string;
  readonly budget?: SponsorshipBudget | null;
  readonly abuse?: AbuseControls | null;
  readonly rpcPool?: RpcPool | null;
  readonly gasClient?: GasClient | null;
  readonly transport?: RelayTransport | null;
  readonly now?: (() => number) | null;
  readonly leaseTtlSeconds?: number | null;
  readonly maxAttempts?: number | null;
}

/** Construct a hardened processor with the relay-internal build/check helpers. */
export function createRelayProcessor(params: Omit<ProcessRelayJobParams, "idempotencyKey">): RelayProcessor {
  return new RelayProcessor({
    store: params.store,
    reader: params.reader,
    hub: params.hub,
    sponsor: params.sponsor as HardeningSponsor,
    budget: params.budget ?? null,
    abuse: params.abuse ?? null,
    rpcPool: params.rpcPool ?? null,
    gasClient: params.gasClient ?? null,
    transport: params.transport ?? null,
    buildCalldata,
    checkPreconditions,
    now: params.now ?? null,
    leaseTtlSeconds: params.leaseTtlSeconds ?? null,
    maxAttempts: params.maxAttempts ?? null,
  });
}

/**
 * Process one relay job through the hardened RelayProcessor. The build/check
 * helpers defined above are injected so the processor stays free of relay
 * internals. Optional deps default to the historical behaviour (no sponsor ->
 * unsigned, no reader -> contract-arbiter) so existing callers keep working.
 */
export async function processRelayJob(params: ProcessRelayJobParams): Promise<{ status: string; txHash: string | null }> {
  return createRelayProcessor(params).process(params.idempotencyKey);
}
