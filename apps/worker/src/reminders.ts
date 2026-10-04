// Reminders: surface upcoming participant deadlines (delivery, inspection,
// escalation, evidence) within 24h. Conservative original-clock derivation;
// the contract applies outage adjustments. Delivery channel wiring is a
// Phase 10 operations task; records are audit-logged here.
import type { Address, Hash } from "viem";
import type { ChainReader } from "@midman/chain";
import { auditLog, listKnownDealIds, type Store } from "@midman/store";

export interface Reminder {
  readonly dealId: string;
  readonly kind: "delivery" | "inspection" | "escalation" | "evidence";
  readonly deadline: number;
}

const DAY = 86_400;

const num = (value: bigint | string | boolean | number | undefined): number => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
};

export async function remindersPass(params: {
  store: Store;
  reader: ChainReader;
  hub: Address;
  nowSeconds: number;
}): Promise<Reminder[]> {
  const due: Reminder[] = [];
  for (const dealId of await listKnownDealIds(params.store)) {
    let deal: Record<string, bigint | string | boolean | number>;
    try {
      deal = await params.reader.getDeal(params.hub, dealId as Hash);
    } catch {
      continue;
    }
    if (deal["funded"] !== true) continue;
    const phase = Number(deal["phase"]);
    const candidates: Array<{ kind: Reminder["kind"]; deadline: number }> = [];
    if (phase === 0) candidates.push({ kind: "delivery", deadline: num(deal["fundedAt"]) + num(deal["deliveryPeriod"]) });
    if (phase === 1) candidates.push({ kind: "inspection", deadline: num(deal["deliveredAt"]) + num(deal["inspectionPeriod"]) });
    if (phase === 2 || phase === 3) {
      candidates.push({ kind: "escalation", deadline: num(deal["disputeOpenedAt"]) + 172_800 });
    }
    if (phase === 4) candidates.push({ kind: "evidence", deadline: num(deal["escalatedAt"]) + 86_400 });
    for (const candidate of candidates) {
      const remaining = candidate.deadline - params.nowSeconds;
      if (remaining > 0 && remaining <= DAY) {
        due.push({ dealId, kind: candidate.kind, deadline: candidate.deadline });
        auditLog({ actor: "reminders", action: `reminders.${candidate.kind}`, dealId });
      }
    }
  }
  return due;
}
