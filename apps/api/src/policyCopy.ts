// Static user-facing policy copy for agreement summaries and exports.
// Sources: specs/policy-register.md P-01..P-15 (APPROVED 2026-10-03) and
// specs/contract-spec.json constants. This copy is display-only; the
// contract + registered policy IDs are authoritative at funding time.

// P-01 (quote CEIL) + financial-ledger L-NORMAL + P-04 (buyer-floor split):
// earned fee is proportional floor, buyer share floors again, seller takes
// the remainder so conservation holds exactly in integer units.
export const FEE_FORMULA_COPY =
  "Earned platform fee = floor(quotedFee * sellerAward / principal). " +
  "Buyer fee share = floor(earnedFee * buyerFeeBps / 10000); the seller share is the remainder " +
  "(earnedFee - buyerFee). Quote uses CEIL (P-01: F = max(500000, ceil(P * rateBps / 10000))); " +
  "all settlements use FLOOR with the seller-remainder rule, so buyer + seller + fee always conserve.";

// P-05 arbitration tiers (principal ranges select quorum/delay strength).
export const QUORUM_TIERS_COPY =
  "T1 standard (5-1,000 USDC): 2-of-3 primary, 2-of-3 fallback (disjoint reviewer set). " +
  "T2 large (>1,000-10,000 USDC): 3-of-5 primary, 3-of-5 fallback (disjoint). " +
  "T3 whale (>10,000 USDC): 3-of-5 / 3-of-5 (disjoint) + veto no-objection before execution. " +
  "Minimum 2-of-3 everywhere (P-05).";

// P-06 review durations + tiered execution delays (worst case ~24.5d < 60d escape).
export const EXECUTION_DELAYS_COPY =
  "Respondent evidence 24h after escalation; primary review 7 days; fallback review 7 days. " +
  "Ruling execution delays: T1 24h, T2 48h, T3 72h (P-06/P-05).";

// P-02 catastrophic split dust: odd unit to buyer; P-04/L-CATASTROPHIC: zero fee.
export const CATASTROPHIC_SPLIT_COPY = "50/50, odd unit to buyer";
export const CATASTROPHIC_FEES_COPY = "zero";

// P-09 fixed cutoff: escapeAt = disputeOpenedAt + 5,184,000s (60 days), never adjusted.
export const CATASTROPHIC_DAYS = 60;

// P-05/P-06 dispute windows (hours, for display).
export const NEGOTIATION_HOURS = 24;
export const ESCALATION_HOURS = 24;

// contract-spec.json constants.minimumBondUnits ("5000000" = 5 USDC).
export const MIN_BOND_UNITS = "5000000";

// Warnings shown on every agreement summary (P-12/P-15 agreement clarity):
// one-use exhaustion (single free buyer freeze), lapse consequence
// (SELF_RESOLUTION/AWAITING_ESCALATION -> lapse to DELIVERED), and
// no-warranty notes (game-account + digital-goods post-settlement).
export const AGREEMENT_WARNINGS: readonly string[] = [
  "One free dispute only: opening a dispute consumes the single free buyer freeze. " +
    "A second dispute requires escalation with a separately collateralized bond (min 5 USDC each side).",
  "If negotiation lapses without escalation within the 24h negotiation + 24h escalation windows, " +
    "the dispute lapses back to DELIVERED and the seller timeout path may finalize payment to the seller.",
  "No warranty: game-account transfers and digital goods carry no post-settlement warranty. " +
    "Post-settlement reports go to the support channel only and do not reopen the deal.",
  "Never share secrets on-platform: passwords, keys, recovery phrases and full codes must not enter " +
    "chat, tickets, evidence previews or on-chain commitments; delivery commitments use hashes only.",
];
