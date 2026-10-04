// Solvency reconciliation: custody balance vs accounted liabilities.
// Alerts (never state changes) on any mismatch.
import type { Address } from "viem";
import type { ChainReader } from "@midman/chain";
import { auditLog } from "@midman/store";

export interface Reconciliation {
  /** Accounted liabilities; null when the chain read failed (unknown). */
  readonly liabilities: bigint | null;
  /** Custody balance; null when the chain read failed (unknown). */
  readonly balance: bigint | null;
  /** true = solvent, false = shortfall, null = unknown (never defaulted to ok). */
  readonly ok: boolean | null;
  /** balance - liabilities; null when unknown. */
  readonly delta: bigint | null;
  /** Why the result is unknown; null when known. */
  readonly reason: string | null;
}

export async function reconcile(params: {
  reader: ChainReader;
  hub: Address;
  usdc: Address;
}): Promise<Reconciliation> {
  let liabilities: bigint;
  let balance: bigint;
  try {
    [liabilities, balance] = await Promise.all([
      params.reader.getLiabilities(params.hub),
      params.reader.getTokenBalance(params.usdc, params.hub),
    ]);
  } catch (error) {
    // Unknown beats a fabricated "ok": a failed read must be surfaced, not hidden.
    return {
      liabilities: null,
      balance: null,
      ok: null,
      delta: null,
      reason: error instanceof Error ? error.name : "read-failed",
    };
  }
  const ok = balance >= liabilities;
  if (!ok) {
    auditLog({
      actor: "reconciliation",
      action: "solvency.alert",
      details: { liabilities: liabilities.toString(), balance: balance.toString() },
    });
  }
  return { liabilities, balance, ok, delta: balance - liabilities, reason: null };
}
