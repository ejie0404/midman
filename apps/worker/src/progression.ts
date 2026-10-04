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
    const action = dueAction(deal, params.nowSeconds);
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

/** Original-deadline derivation (contract applies outage adjustments). */
export function dueAction(
  deal: Record<string, bigint | string | boolean | number>,
  nowSeconds: number,
): string | null {
  const phase = Number(deal["phase"]);
  const at = (field: string, period: string): number => num(deal[field]) + num(deal[period]);
  switch (phase) {
    case 0: {
      if (nowSeconds >= at("fundedAt", "deliveryPeriod") + MARGIN) return "refundForNonDelivery";
      return null;
    }
    case 1: {
      if (nowSeconds >= at("deliveredAt", "inspectionPeriod") + MARGIN) return "finalizeAfterTimeout";
      return null;
    }
    case 2:
    case 3: {
      const opened = num(deal["disputeOpenedAt"]);
      if (nowSeconds >= opened + 172_800 + MARGIN) return "lapseDispute";
      return null;
    }
    case 4: {
      if (nowSeconds >= num(deal["escalatedAt"]) + 86_400 + MARGIN) return "advanceToPrimary";
      return null;
    }
    case 5: {
      // Primary end derives from the evidence end; recompute conservatively.
      const evidenceEnd = num(deal["escalatedAt"]) + 86_400;
      if (nowSeconds >= evidenceEnd + 604_800 + MARGIN) return "activateFallback";
      return null;
    }
    case 6: {
      if (deal["rulingQueued"] === true) return null;
      const started = num(deal["fallbackStartedAt"]);
      if (started > 0 && nowSeconds >= started + 604_800 + MARGIN) return "markDeadlock";
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
