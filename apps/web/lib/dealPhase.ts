// Plain-language presentation of where a deal is: one label, one tone, the
// progress step, and whose move it is. Chain phase (authoritative once
// funded) wins over the off-chain draft status.
//
// Erasable TypeScript only (Node 24 imports it directly in tests).

export type DealTone = "neutral" | "info" | "teal" | "warning" | "violet" | "success" | "danger";
export type DealRole = "buyer" | "seller" | "creator";

/** The five-step happy path shown in the progress bar. */
export const DEAL_STEPS = ["Agree", "Fund", "Deliver", "Inspect", "Complete"] as const;

export interface DealStage {
  readonly label: string;
  readonly tone: DealTone;
  /** Index into DEAL_STEPS of the step in progress. */
  readonly step: number;
  /** True when the deal left the happy path (dispute, arbitration, deadlock). */
  readonly attention: boolean;
  /** One sentence: what is happening now. */
  readonly summary: string;
  /** Who acts next, when anyone does. */
  readonly nextActor: "buyer" | "seller" | "both" | "panel" | "anyone" | null;
}

const CHAIN: Record<string, DealStage> = {
  AWAITING_DELIVERY: {
    label: "Awaiting delivery",
    tone: "info",
    step: 2,
    attention: false,
    summary: "Funds are locked in escrow. The seller delivers and marks the deal delivered.",
    nextActor: "seller",
  },
  DELIVERED: {
    label: "Inspecting",
    tone: "teal",
    step: 3,
    attention: false,
    summary: "The seller marked delivery. The buyer inspects, then releases payment or opens a dispute.",
    nextActor: "buyer",
  },
  SELF_RESOLUTION: {
    label: "Disputed",
    tone: "warning",
    step: 3,
    attention: true,
    summary: "The buyer froze the deal. Both sides have 24 hours to agree on a settlement.",
    nextActor: "both",
  },
  AWAITING_ESCALATION: {
    label: "Escalation window",
    tone: "warning",
    step: 3,
    attention: true,
    summary: "No settlement yet. The buyer can escalate to arbitration (5 USDC bond) within 24 hours.",
    nextActor: "buyer",
  },
  EVIDENCE: {
    label: "Collecting evidence",
    tone: "violet",
    step: 3,
    attention: true,
    summary: "Arbitration started. Both sides upload evidence before the panel reviews.",
    nextActor: "both",
  },
  PRIMARY_REVIEW: {
    label: "Under review",
    tone: "violet",
    step: 3,
    attention: true,
    summary: "An independent panel is reviewing the evidence.",
    nextActor: "panel",
  },
  FALLBACK_REVIEW: {
    label: "Under review (fallback panel)",
    tone: "violet",
    step: 3,
    attention: true,
    summary: "A second, independent panel is reviewing the evidence.",
    nextActor: "panel",
  },
  RULING_PENDING: {
    label: "Ruling pending",
    tone: "violet",
    step: 3,
    attention: true,
    summary: "The panel issued a ruling. It takes effect after a waiting period unless vetoed.",
    nextActor: "anyone",
  },
  DEADLOCK: {
    label: "Deadlocked",
    tone: "danger",
    step: 3,
    attention: true,
    summary: "No ruling was reached. The 60-day escape will split the principal 50/50.",
    nextActor: "anyone",
  },
  SETTLED: {
    label: "Settled",
    tone: "success",
    step: 4,
    attention: false,
    summary: "The deal is settled. Each recipient can claim their payout.",
    nextActor: "anyone",
  },
};

const DRAFT: Record<string, DealStage> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    step: 0,
    attention: false,
    summary: "The deal is drafted. Share the invite link with the other side.",
    nextActor: "both",
  },
  invited: {
    label: "Invite sent",
    tone: "neutral",
    step: 0,
    attention: false,
    summary: "Waiting for the other side to open the invite and accept.",
    nextActor: "both",
  },
  accepted: {
    label: "Signing",
    tone: "info",
    step: 0,
    attention: false,
    summary: "Both sides review and sign the same terms.",
    nextActor: "both",
  },
  signed: {
    label: "Signing",
    tone: "info",
    step: 0,
    attention: false,
    summary: "Both sides review and sign the same terms.",
    nextActor: "both",
  },
  admitted: {
    label: "Ready to fund",
    tone: "info",
    step: 1,
    attention: false,
    summary: "Terms are signed and approved. The buyer funds the escrow.",
    nextActor: "buyer",
  },
};

/** Stage for a deal from its chain phase (when funded) or draft status. */
export function dealStage(chainPhase: string | null | undefined, draftStatus: string | null | undefined): DealStage {
  if (chainPhase && CHAIN[chainPhase]) return CHAIN[chainPhase]!;
  if (draftStatus && DRAFT[draftStatus]) return DRAFT[draftStatus]!;
  return {
    label: "Unknown",
    tone: "neutral",
    step: 0,
    attention: false,
    summary: "This deal's state could not be determined.",
    nextActor: null,
  };
}

/** True when the given role is (one of) the parties expected to act next. */
export function isYourMove(stage: DealStage, role: DealRole): boolean {
  if (stage.nextActor === "both") return role !== "creator";
  return stage.nextActor === role;
}

/** Step states for the progress bar. */
export function stepStates(stage: DealStage): ("done" | "current" | "attention" | "todo")[] {
  return DEAL_STEPS.map((_, i) => {
    if (i < stage.step) return "done";
    if (i === stage.step) {
      if (stage.attention) return "attention";
      return stage.step === DEAL_STEPS.length - 1 ? "done" : "current";
    }
    return "todo";
  });
}

/** Short address for display: 0x1234…abcd. */
export function shortAddress(address: string | null | undefined): string {
  if (!address) return "—";
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Display names for the on-chain category policies. */
export const CATEGORY_LABELS: Record<string, string> = {
  INSTANT_CODE: "Instant code",
  GAME_ITEM: "Game item",
  GAME_CURRENCY: "Game currency",
  DIGITAL_GOOD: "Digital good",
  SERVICE: "Service",
  GAME_ACCOUNT: "Game account",
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "Deal";
  return CATEGORY_LABELS[category] ?? category;
}

export interface NextAction {
  /** Primary call to action for this viewer, or null when they only wait. */
  readonly cta: { readonly label: string; readonly path: "review" | "fund" | "deliver" | "inspect" | "claim" } | null;
  /** What the viewer should know right now. */
  readonly message: string;
}

/**
 * What the viewing party should do next. `path` is relative to /deals/:id.
 * Chain phase wins over draft status once the deal is funded.
 */
export function nextAction(chainPhase: string | null | undefined, draftStatus: string | null | undefined, role: DealRole | null): NextAction {
  const party = role === "buyer" || role === "seller" ? role : null;
  if (!party) {
    return { cta: null, message: "You are viewing this deal but are not the buyer or seller." };
  }
  const other = party === "buyer" ? "seller" : "buyer";
  switch (chainPhase) {
    case "AWAITING_DELIVERY":
      return party === "seller"
        ? { cta: { label: "Mark as delivered", path: "deliver" }, message: "Deliver what you sold, then mark the deal delivered before the delivery window ends." }
        : { cta: null, message: "Your money is safe in escrow. If the seller doesn't deliver in time, you can take a full refund." };
    case "DELIVERED":
      return party === "buyer"
        ? { cta: { label: "Inspect & release", path: "inspect" }, message: "Check what you received. Release payment if it's right, or open a dispute before inspection ends." }
        : { cta: null, message: "Waiting for the buyer to inspect. Payment releases automatically when inspection ends." };
    case "SELF_RESOLUTION":
    case "AWAITING_ESCALATION":
    case "EVIDENCE":
    case "PRIMARY_REVIEW":
    case "FALLBACK_REVIEW":
    case "RULING_PENDING":
    case "DEADLOCK":
      return { cta: { label: "Open dispute center", path: "inspect" }, message: dealStage(chainPhase, null).summary };
    case "SETTLED":
      return { cta: { label: "Claim payout", path: "claim" }, message: "The deal is settled. Claim whatever you are owed." };
    default:
      break;
  }
  switch (draftStatus) {
    case "draft":
    case "invited":
      return { cta: { label: "Review terms", path: "review" }, message: `Waiting for the ${other} to accept the invite.` };
    case "accepted":
    case "signed":
      return { cta: { label: "Review & sign", path: "review" }, message: "Both sides sign the exact same terms before funding." };
    case "admitted":
      return party === "buyer"
        ? { cta: { label: "Fund escrow", path: "fund" }, message: "Deposit the price into escrow. The seller can deliver once it's funded." }
        : { cta: null, message: "Waiting for the buyer to fund the escrow." };
    default:
      return { cta: null, message: "This deal's state could not be determined." };
  }
}
