"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, relaySubmit } from "../../lib/api";
import type { RequestSigner } from "../../lib/requestAuth";
import {
  acceptSettlementProposal,
  buildMutualSettlementTypedData,
  expectedPhaseForName,
  fetchEscalation,
  isReviewMissing,
  listSettlementProposals,
  normalizeTypedDataMessage,
  previewAward,
  proposeSettlement,
  relayKeyOf,
  signTypedDataWithWallet,
  type QueueRulingResult,
  type SettlementProposal,
} from "../../lib/review";
import { parseUSDC } from "../../lib/money";
import { getAccount, getWalletClient, sendDirect } from "../../lib/wallet";
import { connectEvidenceAuth } from "./evidenceAuth";
import Money from "./Money";
import { button, card, error, mono, ok, secondaryButton, warning } from "./styles";

/**
 * Settlement proposals (additive panel for the inspect page). Propose a
 * bounded award S with auto-derived P-03 bond costs and an automatic
 * expectedPhase; countersign incoming proposals with a client-side
 * MutualSettlement signature, then submit via relay or direct send.
 * All signatures are produced in the browser wallet — the server only
 * receives signature bytes.
 */
export default function SettlementProposals({
  dealId,
  agreementDigest,
  hub,
  chainId,
  principalUnits,
  quotedFeeUnits,
  buyerFeeBps,
  phase,
}: {
  dealId: string;
  agreementDigest: string;
  hub: `0x${string}`;
  chainId: number;
  principalUnits: string;
  quotedFeeUnits: string;
  buyerFeeBps: 0 | 5000 | 10000;
  phase: string;
}) {
  const [auth, setAuth] = useState<RequestSigner | null>(null);
  const [claimantBond, setClaimantBond] = useState("5000000");
  const [respondentBond, setRespondentBond] = useState("5000000");
  const [awardUsdc, setAwardUsdc] = useState("");
  const [proposals, setProposals] = useState<readonly SettlementProposal[]>([]);
  const [pending, setPending] = useState<{ proposalId: string; result: QueueRulingResult } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [missing, setMissing] = useState(false);

  const expectedPhase = expectedPhaseForName(phase);

  const refresh = useCallback(
    async (signer: RequestSigner) => {
      try {
        setProposals(await listSettlementProposals(dealId, signer));
      } catch (e) {
        if (isReviewMissing(e)) setMissing(true);
        else throw e;
      }
      try {
        const escalation = await fetchEscalation(dealId, signer);
        if (/^\d+$/.test(escalation.claimantBondUnits)) setClaimantBond(escalation.claimantBondUnits);
        if (/^\d+$/.test(escalation.respondentBondUnits)) setRespondentBond(escalation.respondentBondUnits);
      } catch {
        // Bonds stay at the 5 USDC minimum default; endpoint may be pending.
      }
    },
    [dealId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const signer = await connectEvidenceAuth();
        if (cancelled) return;
        setAuth(signer);
        await refresh(signer);
      } catch {
        // Wallet not connected yet — form still renders, actions need connect.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function connect() {
    setFailure(null);
    try {
      const signer = await connectEvidenceAuth();
      setAuth(signer);
      await refresh(signer);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    }
  }

  const preview = (() => {
    if (awardUsdc.trim() === "") return null;
    try {
      return previewAward({
        principalUnits,
        quotedFeeUnits,
        buyerFeeBps,
        sellerAwardUnits: parseUSDC(awardUsdc),
        claimantBondUnits: claimantBond,
        respondentBondUnits: respondentBond,
      });
    } catch {
      return null;
    }
  })();

  async function propose() {
    if (!auth) {
      await connect();
      return;
    }
    setWorking(true);
    setMessage(null);
    setFailure(null);
    try {
      if (awardUsdc.trim() === "") throw new Error("Enter S in USDC.");
      const sellerAwardUnits = parseUSDC(awardUsdc);
      if (BigInt(sellerAwardUnits) > BigInt(principalUnits)) {
        throw new Error("S exceeds principal P — proposals are bounded to [0, P].");
      }
      const costs = preview ?? previewAward({
        principalUnits,
        quotedFeeUnits,
        buyerFeeBps,
        sellerAwardUnits,
        claimantBondUnits: claimantBond,
        respondentBondUnits: respondentBond,
      });
      await proposeSettlement(
        dealId,
        {
          sellerAwardUnits,
          buyerCostUnits: costs.buyerCostUnits,
          sellerCostUnits: costs.sellerCostUnits,
          expectedPhase,
        },
        auth,
      );
      setMessage("Proposal submitted.");
      setAwardUsdc("");
      await refresh(auth);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function countersign(proposal: SettlementProposal) {
    if (!auth) {
      await connect();
      return;
    }
    setWorking(true);
    setMessage(null);
    setFailure(null);
    setPending(null);
    try {
      const envelope = proposal.typedData ?? (proposal.settlementNonce
        ? buildMutualSettlementTypedData({
            chainId,
            hub,
            dealId,
            agreementDigest,
            sellerAwardUnits: proposal.sellerAwardUnits,
            buyerCostUnits: proposal.buyerCostUnits,
            sellerCostUnits: proposal.sellerCostUnits,
            expectedPhase: proposal.expectedPhase,
            settlementNonce: proposal.settlementNonce,
            expiresAt: proposal.expiresAt ?? Math.floor(Date.now() / 1_000) + 3_600,
          })
        : null);
      if (!envelope) {
        throw new Error("Proposal carries no typed-data and no settlement nonce — cannot countersign yet.");
      }
      const account = await getAccount();
      const client = getWalletClient();
      const signature = await signTypedDataWithWallet(
        { signTypedData: (args) => (client.signTypedData as (a: unknown) => Promise<string>)(args) },
        account,
        { ...envelope, message: normalizeTypedDataMessage(envelope) },
      );
      const result = await acceptSettlementProposal(proposal.id, signature, auth);
      setPending({ proposalId: proposal.id, result });
      setMessage(`Countersigned ${proposal.id} — choose relay or direct submit below. Nothing is on-chain yet.`);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function submitPending(direct: boolean) {
    if (!pending) return;
    setWorking(true);
    setMessage(null);
    setFailure(null);
    try {
      if (direct) {
        const hash = await sendDirect(hub, pending.result.calldata as `0x${string}`);
        setMessage(`Direct mutualSettlement sent (${hash}) — pending until included.`);
      } else {
        const payload = pending.result.relayPayload;
        const res = await relaySubmit(relayKeyOf(payload), payload.action, payload.params);
        setMessage(`Relay ${res.status} (key ${res.idempotencyKey}) — pending until included.`);
      }
      setPending(null);
      if (auth) await refresh(auth);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div style={card}>
      <h2>Settlement proposals</h2>
      <p style={{ fontSize: 14 }}>
        Propose a split (bounded S in [0, P]) with exact fee/bond previews, or countersign an incoming proposal. Both
        sides sign MutualSettlement typed-data in their own wallets; funds move only when the countersigned calldata
        is submitted (relay or direct).
      </p>
      {missing ? (
        <div style={warning}>
          Settlement-proposal backend unavailable (404/503) — the endpoint is not deployed yet. Unilateral
          release/refund above still works.
        </div>
      ) : null}
      {!auth ? (
        <button type="button" style={secondaryButton} onClick={() => void connect()}>
          Connect wallet for proposals
        </button>
      ) : null}

      <h3 style={{ fontSize: 15 }}>Propose</h3>
      <label style={{ display: "block", fontSize: 14 }}>
        Seller award S (USDC):
        <input
          value={awardUsdc}
          onChange={(e) => setAwardUsdc(e.target.value)}
          placeholder="e.g. 50"
          inputMode="decimal"
          style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
        />
      </label>
      <p style={{ fontSize: 13 }}>
        Bond inputs (5 USDC minimums; auto-filled from escalation when available): claimant{" "}
        <input value={claimantBond} onChange={(e) => setClaimantBond(e.target.value)} style={{ width: 120 }} /> ·
        respondent <input value={respondentBond} onChange={(e) => setRespondentBond(e.target.value)} style={{ width: 120 }} />
      </p>
      {preview ? (
        <div style={ok}>
          <ul style={{ fontSize: 14, margin: 0 }}>
            <li>
              Seller <Money units={preview.sellerClaimUnits} /> · Buyer <Money units={preview.buyerClaimUnits} /> ·
              earned fee <Money units={preview.earnedFeeUnits} />
            </li>
            <li>
              Costs — buyer <Money units={preview.buyerCostUnits} /> · seller{" "}
              <Money units={preview.sellerCostUnits} />
            </li>
            <li>Expected phase: auto ({phase || "unknown"} → {expectedPhase})</li>
          </ul>
        </div>
      ) : null}
      <button type="button" style={button} disabled={working} onClick={() => void propose()}>
        Submit proposal
      </button>

      <h3 style={{ fontSize: 15 }}>Incoming proposals ({proposals.length})</h3>
      {proposals.length === 0 ? (
        <p style={{ fontSize: 14 }}>No proposals yet.</p>
      ) : (
        <ul style={{ fontSize: 14 }}>
          {proposals.map((proposal) => (
            <li key={proposal.id} style={{ marginBottom: 8 }}>
              <span style={mono}>{proposal.id}</span>: S = <Money units={proposal.sellerAwardUnits} />, buyer cost{" "}
              <Money units={proposal.buyerCostUnits} />, seller cost <Money units={proposal.sellerCostUnits} />
              {proposal.proposer ? (
                <span>
                  {" "}
                  · proposer <span style={mono}>{proposal.proposer}</span>
                </span>
              ) : null}
              {proposal.status ? <span> · {proposal.status}</span> : null}
              <div>
                <button
                  type="button"
                  style={secondaryButton}
                  disabled={working}
                  onClick={() => void countersign(proposal)}
                >
                  Countersign & accept
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <div style={warning}>
          <p style={{ fontSize: 14 }}>
            Proposal <span style={mono}>{pending.proposalId}</span> countersigned. Calldata:{" "}
            <span style={mono}>{pending.result.calldata.slice(0, 42)}…</span>
          </p>
          <button type="button" style={button} disabled={working} onClick={() => void submitPending(false)}>
            Submit via relay
          </button>
          <button type="button" style={secondaryButton} disabled={working} onClick={() => void submitPending(true)}>
            Submit direct (wallet send)
          </button>
        </div>
      ) : null}

      {message ? <div style={ok}>{message}</div> : null}
      {failure ? <div style={error}>{failure}</div> : null}
    </div>
  );
}
