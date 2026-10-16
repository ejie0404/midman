// Turn wallet, contract and API failures into one sentence a user can act
// on. Contract custom errors mirror packages/contracts/src/DealTypes.sol.
//
// Erasable TypeScript only (Node 24 imports it directly in tests).

const CONTRACT_ERRORS: Record<string, string> = {
  Paused: "New deals are paused right now. Existing deals are not affected.",
  BadTerms: "The contract rejected these terms. Refresh the deal and try again.",
  AlreadyFunded: "This deal is already funded.",
  Revoked: "These terms were revoked and can no longer be funded.",
  Expired: "This approval expired. Start the action again to get a fresh one.",
  BadSig: "The signature didn't match the expected wallet. Make sure you're using the wallet named in the deal.",
  BadNonce: "This action was already submitted.",
  BadPhase: "That action isn't available at this stage of the deal. Refresh to see the latest state.",
  TooEarly: "Too early: the deadline for this action hasn't passed yet.",
  TooLate: "Too late: the window for this action has closed.",
  DisputeExhausted: "The one free dispute for this deal has already been used.",
  NoQuorum: "The ruling doesn't have enough panel signatures.",
  BadAward: "The proposed split isn't valid for this deal.",
  OutageUnknown:
    "Base recently had a network outage and deadlines are being recalculated. Try again in a few minutes.",
  NotRole: "Your wallet isn't allowed to do this.",
  NothingToRescue: "There is nothing to rescue.",
  NoClaim: "There's nothing left to claim for this payout.",
};

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const withShort = error as Error & { shortMessage?: string; details?: string };
    return [withShort.shortMessage, withShort.message, withShort.details].filter(Boolean).join(" | ");
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function codeOf(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "number") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** One actionable sentence for any failure. */
export function friendlyError(error: unknown): string {
  const text = messageOf(error);
  const code = codeOf(error);

  if (code === 4001 || /user (rejected|denied)|rejected the request|request rejected/i.test(text)) {
    return "You cancelled the request in your wallet.";
  }
  for (const [name, friendly] of Object.entries(CONTRACT_ERRORS)) {
    if (new RegExp(`\\b${name}\\(\\)|error ["']?${name}\\b|reverted with.*\\b${name}\\b`).test(text)) return friendly;
  }
  if (/transfer amount exceeds (balance|allowance)|ERC20InsufficientBalance/i.test(text)) {
    return "Not enough USDC in your wallet for this deposit.";
  }
  if (/insufficient funds/i.test(text)) return "Your wallet doesn't have enough ETH to pay network fees.";
  if (/wrong network|chain mismatch|ChainMismatch|expected chain/i.test(text)) {
    return "Your wallet is on the wrong network. Switch it to Base and try again.";
  }
  if (/No wallet selected|No browser wallet/i.test(text)) return "Choose a wallet to continue.";

  const status = statusOf(error);
  if (status === 401) return "Your session expired. Sign in again to continue.";
  if (status === 403) return "Your wallet isn't allowed to do this on this deal.";
  if (status === 404) return "We couldn't find that deal.";
  if (status === 429) return "Too many requests. Wait a minute and try again.";
  if (status !== null && status >= 500) return "Something went wrong on our side. Try again in a moment.";
  if (/Network unreachable|Failed to fetch|NetworkError/i.test(text)) return "Can't reach Midman right now. Check your connection.";

  const first = text.split(" | ")[0] ?? text;
  return first.length > 200 ? `${first.slice(0, 197)}…` : first || "Something went wrong.";
}
