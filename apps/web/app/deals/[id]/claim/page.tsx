"use client";

import { use, useState } from "react";
import { getRecovery, getRelayJob, relaySubmit, ApiError, type RecoveryPackage } from "../../../../lib/api";
import { HUB_ADDRESS, getAccount, sendDirect, waitForInclusion } from "../../../../lib/wallet";
import { CLAIM_KINDS } from "../../../../lib/deal";
import { useDeal } from "../../../components/useDeal";
import TxStatus from "../../../components/TxStatus";
import { button, card, error, mono, nav, ok, page, secondaryButton, warning } from "../../../components/styles";

export default function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const rawId = decodeURIComponent(id);
  const view = useDeal(rawId);
  const [kind, setKind] = useState(0);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryPackage | null>(null);

  async function loadRecovery(): Promise<RecoveryPackage> {
    if (recovery) return recovery;
    if (!view.dealId) throw new Error("Deal not loaded");
    const r = await getRecovery(view.dealId);
    setRecovery(r);
    return r;
  }

  async function relayClaim() {
    setWorking(true);
    setMessage(null);
    setFailure(null);
    try {
      if (!view.dealId) throw new Error("Deal not loaded");
      const account = await getAccount();
      const key = `claim-${view.dealId.slice(0, 12)}-${kind}-${Date.now()}`;
      const res = await relaySubmit(key, "claimFor", { dealId: view.dealId, kind, claimant: account });
      setMessage(`Relay ${res.status} (key ${res.idempotencyKey}) — pending until included.`);
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        try {
          const job = await getRelayJob(key);
          if (job.txHash) {
            setTxHash(job.txHash);
            setMessage(`Relay tx ${job.txHash} — status ${job.status}.`);
            if (job.status === "confirmed" || job.status === "succeeded") break;
          }
        } catch {
          // keep polling
        }
      }
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function directClaim() {
    setWorking(true);
    setMessage(null);
    setFailure(null);
    try {
      if (!view.dealId) throw new Error("Deal not loaded");
      const r = await loadRecovery();
      const selected = CLAIM_KINDS.find((c) => c.kind === kind);
      if (!selected) throw new Error("Unknown claim kind");
      const data = r.emergencyCalldata[selected.calldataKey];
      if (!data) throw new Error(`No emergency calldata for ${selected.calldataKey}`);
      const hub = (r.hub ?? HUB_ADDRESS) as `0x${string}`;
      const hash = await sendDirect(hub, data as `0x${string}`);
      setTxHash(hash);
      setMessage(`Direct claim tx sent (${hash}) — pending until included.`);
      await waitForInclusion(hash);
      setMessage(`Direct claim included (${hash}). Funds move to the fixed on-chain recipient.`);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  if (view.loading) {
    return (
      <main style={page}>
        <p>Loading claim panel…</p>
      </main>
    );
  }
  if (!view.dealId) {
    return (
      <main style={page}>
        <h1>Claim</h1>
        <div style={error}>{view.error ?? "Deal not loaded."}</div>
        <p style={nav}>
          <a href={`/deals/${id}`}>← Dashboard</a>
        </p>
      </main>
    );
  }

  return (
    <main style={page}>
      <h1>Claim / recovery</h1>
      <p style={nav}>
        <a href={`/deals/${id}`}>← Dashboard</a>
      </p>

      <div style={warning}>
        <strong>Fixed recipients.</strong> Every claim kind pays a predetermined on-chain address (seller payout,
        buyer refund, bond refund, fee recipients). Claims cannot be redirected from this UI — a claim for one
        beneficiary never touches another&apos;s entitlement.
      </div>

      <div style={card}>
        <h2>Claim kind</h2>
        <select
          value={String(kind)}
          onChange={(e) => setKind(Number(e.target.value))}
          style={{ width: "100%", padding: 8 }}
        >
          {CLAIM_KINDS.map((c) => (
            <option key={c.kind} value={String(c.kind)}>
              {c.kind}: {c.name}
            </option>
          ))}
        </select>
        <div>
          <button type="button" style={button} disabled={working} onClick={() => void relayClaim()}>
            {working ? "Working…" : "Relay: submit claim"}
          </button>
          <button type="button" style={secondaryButton} disabled={working} onClick={() => void directClaim()}>
            Direct wallet: send claim (recovery calldata)
          </button>
        </div>
        {txHash ? <p style={mono}>tx: {txHash} — pending until included.</p> : null}
      </div>

      {message ? <div style={ok}>{message}</div> : null}
      {failure ? <div style={error}>{failure}</div> : null}

      <div style={card}>
        <h2>Recovery package (relayer-free)</h2>
        <button
          type="button"
          style={secondaryButton}
          onClick={() =>
            loadRecovery()
              .then(() => setMessage("Recovery package loaded."))
              .catch((e: unknown) =>
                setFailure(e instanceof Error ? e.message : String(e)),
              )
          }
        >
          Load recovery package
        </button>
        {recovery ? (
          <div>
            <p style={{ fontSize: 14 }}>{recovery.note}</p>
            <p style={mono}>chain {recovery.chainId} · hub {recovery.hub} · usdc {recovery.usdc}</p>
            {Object.entries(recovery.emergencyCalldata).map(([name, data]) => (
              <div key={name} style={{ margin: "8px 0" }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{name}</div>
                <div style={mono}>to: {recovery.hub}</div>
                <div style={mono}>data: {data}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={card}>
        <h2>Status</h2>
        {view.confirmation ? (
          <TxStatus level={view.confirmation.level} />
        ) : (
          <p style={{ fontSize: 14 }}>Confirmation unavailable — verify inclusion before acting.</p>
        )}
      </div>
    </main>
  );
}
