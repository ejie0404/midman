"use client";

import { useEffect, useState } from "react";
import { getRecovery, type RecoveryPackage } from "../../lib/api";
import { card, mono, warning } from "./styles";

/**
 * Relayer-free fallback: links the recovery export and displays unsigned
 * emergency calldata so every direct path stays reachable without the relayer.
 */
export default function FallbackNotice({ dealId }: { dealId: string }) {
  const [recovery, setRecovery] = useState<RecoveryPackage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getRecovery(dealId)
      .then((r) => {
        if (!cancelled) setRecovery(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  return (
    <div style={card}>
      <strong>Relayer-free fallback</strong>
      <p style={{ fontSize: 14 }}>
        Every action on this page can be completed without the relayer. Fetch the recovery package and submit the
        calldata directly from your wallet. Pending transactions are not included until they appear on-chain.
      </p>
      <p style={{ fontSize: 14 }}>
        <a href={`/deals/${dealId}/claim`}>Open recovery / claim panel</a>
        {" · "}
        <button type="button" onClick={() => setOpen((v) => !v)} style={{ fontSize: 14 }}>
          {open ? "Hide" : "Show"} unsigned emergency calldata
        </button>
      </p>
      {error ? <div style={warning}>Recovery unavailable: {error}</div> : null}
      {open && recovery ? (
        <div>
          {Object.entries(recovery.emergencyCalldata).map(([name, data]) => (
            <div key={name} style={{ margin: "8px 0" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{name}</div>
              <div style={mono}>to: {recovery.hub}</div>
              <div style={mono}>data: {data}</div>
            </div>
          ))}
          <p style={{ fontSize: 13 }}>{recovery.note}</p>
        </div>
      ) : null}
    </div>
  );
}
