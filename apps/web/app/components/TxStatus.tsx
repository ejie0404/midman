import type { Confirmation } from "../../lib/api";

type Level = Confirmation["level"];

const COLORS: Record<Level, string> = {
  pending: "#e3b341",
  included: "#6cb6ff",
  safe: "#7ee787",
  finalized: "#7ee787",
};

/**
 * Pending-vs-included labeling. A signed/relayed transaction is PENDING until
 * chain inclusion; only safe/finalized is ready for irreversible off-chain shipment.
 */
export default function TxStatus({ level, txHash }: { level: Level; txHash?: string | null }) {
  const shipNote =
    level === "safe" || level === "finalized"
      ? "Safe to ship irreversible off-chain delivery."
      : level === "included"
        ? "Included on L2 but not yet batch-backed: do NOT treat as final for irreversible shipment."
        : "Pending: signed or relayed, NOT included on-chain. Contract state has not moved.";
  return (
    <span
      style={{
        display: "inline-block",
        border: `1px solid ${COLORS[level]}`,
        color: COLORS[level],
        borderRadius: 12,
        padding: "2px 10px",
        fontSize: 13,
        fontWeight: 600,
      }}
      title={shipNote}
    >
      {level.toUpperCase()}
      {txHash ? ` · ${txHash.slice(0, 10)}…` : ""}
      {" — "}
      <span style={{ fontWeight: 400 }}>{shipNote}</span>
    </span>
  );
}
