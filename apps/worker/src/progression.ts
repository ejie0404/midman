// Permissionless progression: enqueue due housekeeping/terminal calls.
// Convenience only — users and third parties can always submit directly, and
// the contract enforces exact deadlines (originals here use a 1h margin so
// outage-extended deadlines never trigger premature sponsored submissions).
import type { Address, Hash } from "viem";
import type { ChainReader } from "@midman/chain";
import type { Store } from "@midman/store";
import { listKnownDealIds } from "@midman/store";

const MARGIN = 3_600;

const num = (value: bigint | string | boolean | number | undefined): number => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
};

function dayWindow(nowSeconds: number): number {
  return Math.floor(nowSeconds / 86_400);
}

export async function progressionPass(params: {
  store: Store;
  reader: ChainReader;
  hub: Address;
  nowSeconds: number;
}): Promise<string[]> {
  const enqueued: string[] = [];
  const dealIds = await listKnownDealIds(params.store);
  for (const dealId of dealIds) {
    let deal: Record<string, bigint | string | boolean | number>;
    try {
      deal = await params.reader.getDeal(params.hub, dealId as Hash);
    } catch {
      continue;
    }
    if (deal["funded"] !== true || Number(deal["phase"]) === 9) continue;
    // Prefer the contract's authoritative outage-adjusted deadlines when the
    // reader exposes the view; otherwise fall back to original + margin.
    let deadlines: EffectiveDeadlines | null = null;
    if (typeof params.reader.effectiveDeadlines === "function") {
      try {
        deadlines = await params.reader.effectiveDeadlines(params.hub, dealId as Hash);
      } catch {
        deadlines = null;
      }
    }
    const action = dueAction(deal, params.nowSeconds, deadlines);
    if (!action) continue;
    const key = `${dealId.toLowerCase()}:${action}:${dayWindow(params.nowSeconds)}`;
    const { inserted } = await params.store.enqueueRelay({
      idempotencyKey: key,
      queue: "relay",
      action,
      params: { dealId },
      status: "queued",
      attempts: 0,
      txHash: null,
      result: null,
    });
    if (inserted) enqueued.push(key);
  }
  return enqueued;
}

/** Authoritative outage-adjusted deadlines as returned by `effectiveDeadlines`. */
export interface EffectiveDeadlines {
  readonly delivery: bigint;
  readonly inspection: bigint;
  readonly negotiation: bigint;
  readonly escalation: bigint;
  readonly evidence: bigint;
  readonly primary: bigint;
  readonly fallbackEnd: bigint;
  readonly available: boolean;
}

/**
 * Derive the due housekeeping action. When the contract's `effectiveDeadlines`
 * view is available it is used directly (no margin): a deadline that is already
 * outage-adjusted must not be padded. When the view reports `available=false`
 * the clocks are UNKNOWN, so NO time-derived action is enqueued. With no view
 * at all, fall back to original deadlines + a 1h margin.
 */
export function dueAction(
  deal: Record<string, bigint | string | boolean | number>,
  nowSeconds: number,
  deadlines?: EffectiveDeadlines | null,
): string | null {
  const phase = Number(deal["phase"]);
  const at = (field: string, period: string): number => num(deal[field]) + num(deal[period]);
  if (deadlines && !deadlines.available) return null;
  const end = (authoritative: bigint | undefined, fallback: number): number =>
    deadlines && authoritative !== undefined ? Number(authoritative) : fallback;
  switch (phase) {
    case 0: {
      const target = end(deadlines?.delivery, at("fundedAt", "deliveryPeriod") + MARGIN);
      if (target > 0 && nowSeconds >= target) return "refundForNonDelivery";
      return null;
    }
    case 1: {
      const target = end(deadlines?.inspection, at("deliveredAt", "inspectionPeriod") + MARGIN);
      if (target > 0 && nowSeconds >= target) return "finalizeAfterTimeout";
      return null;
    }
    case 2:
    case 3: {
      const target = end(deadlines?.escalation, num(deal["disputeOpenedAt"]) + 172_800 + MARGIN);
      if (target > 0 && nowSeconds >= target) return "lapseDispute";
      return null;
    }
    case 4: {
      const target = end(deadlines?.evidence, num(deal["escalatedAt"]) + 86_400 + MARGIN);
      if (target > 0 && nowSeconds >= target) return "advanceToPrimary";
      return null;
    }
    case 5: {
      const fallback = num(deal["escalatedAt"]) + 86_400 + 604_800 + MARGIN;
      const target = end(deadlines?.primary, fallback);
      if (target > 0 && nowSeconds >= target) return "activateFallback";
      return null;
    }
    case 6: {
      if (deal["rulingQueued"] === true) return null;
      const started = num(deal["fallbackStartedAt"]);
      const target = end(deadlines?.fallbackEnd, started + 604_800 + MARGIN);
      if (started > 0 && target > 0 && nowSeconds >= target) return "markDeadlock";
      return null;
    }
    case 7: {
      if (nowSeconds >= num(deal["rulingExecuteAt"])) return "executeRuling";
      return null;
    }
    case 8:
      return null;
    default:
      return null;
  }
}

/** Catastrophic-escape scan (no margin: fixed cutoff, always safe to surface). */
export async function escapePass(params: {
  store: Store;
  reader: ChainReader;
  hub: Address;
  nowSeconds: number;
}): Promise<string[]> {
  const enqueued: string[] = [];
  for (const dealId of await listKnownDealIds(params.store)) {
    let deal: Record<string, bigint | string | boolean | number>;
    try {
      deal = await params.reader.getDeal(params.hub, dealId as Hash);
    } catch {
      continue;
    }
    if (deal["funded"] !== true) continue;
    const phase = Number(deal["phase"]);
    if (![4, 5, 6, 7, 8].includes(phase)) continue;
    if (num(deal["escalatedAt"]) === 0) continue;
    if (params.nowSeconds >= num(deal["disputeOpenedAt"]) + 5_184_000) {
      const key = `${dealId.toLowerCase()}:catastrophicEscape:${dayWindow(params.nowSeconds)}`;
      const { inserted } = await params.store.enqueueRelay({
        idempotencyKey: key,
        queue: "relay",
        action: "catastrophicEscape",
        params: { dealId },
        status: "queued",
        attempts: 0,
        txHash: null,
        result: null,
      });
      if (inserted) enqueued.push(key);
    }
  }
  return enqueued;
}
