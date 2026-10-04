"use client";

import { use, useState } from "react";
import { relaySubmit, ApiError } from "../../../../lib/api";
import { isHex32 } from "../../../../lib/deal";
import {
  CHAIN_ID,
  HUB_ADDRESS,
  encodeApproveSeller,
  encodeRefundBuyer,
  getAccount,
  randomBytes32,
  sendDirect,
  waitForInclusion,
} from "../../../../lib/wallet";
import { useDeal } from "../../../components/useDeal";
import DisputeButton from "../../../components/DisputeButton";
import SettlementProposals from "../../../components/SettlementProposals";
import FallbackNotice from "../../../components/FallbackNotice";
import Money from "../../../components/Money";
import { button, card, error, mono, nav, ok, page, secondaryButton, warning } from "../../../components/styles";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

export default function InspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const rawId = decodeURIComponent(id);
  const view = useDeal(rawId);
  const [policyVersion, setPolicyVersion] = useState(ZERO_HASH);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function settle(kind: "approveSeller" | "refundBuyer", direct: boolean) {
    setWorking(true);
    setMessage(null);
    setFailure(null);
    try {
      if (!view.terms || !view.dealId) throw new Error("Terms not loaded");
      if (!isHex32(policyVersion)) throw new Error("Terminal policy version must be bytes32");
      const hub = (view.terms.hub ?? HUB_ADDRESS) as `0x${string}`;
      const dealId = view.dealId as `0x${string}`;
      const nonce = randomBytes32();
      const expiresAt = BigInt(Math.floor(Date.now() / 1_000) + 3_600);
      if (direct) {
        // Self-sent settlement needs no signature (contract accepts msg.sender == actor with empty sig).
        const data =
          kind === "approveSeller"
            ? encodeApproveSeller(dealId, policyVersion as `0x${string}`, nonce, expiresAt, "0x")
            : encodeRefundBuyer(dealId, policyVersion as `0x${string}`, nonce, expiresAt, "0x");
        const hash = await sendDirect(hub, data);
        setMessage(`Direct ${kind} sent (${hash}) — pending until included.`);
        await waitForInclusion(hash);
        setMessage(`Direct ${kind} included (${hash}). Payouts are now claimable.`);
      } else {
        const account = await getAccount();
        const key = `settle-${view.dealId.slice(0, 12)}-${Date.now()}`;
        const res = await relaySubmit(key, kind, {
          dealId: view.dealId,
          terminalPolicyVersion: policyVersion,
          nonce,
          expiresAt: expiresAt.toString(),
          submitter: account,
        });
        setMessage(`Relay ${res.status} (key ${res.idempotencyKey}) — pending until included.`);
      }
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  if (view.loading) {
    return (
      <main style={page}>
        <p>Loading inspection panel…</p>
      </main>
    );
  }
  if (!view.terms || !view.dealId) {
    return (
      <main style={page}>
        <h1>Inspect</h1>
        <div style={error}>{view.error ?? "Deal not loaded."}</div>
        <p style={nav}>
          <a href={`/deals/${id}`}>← Dashboard</a>
        </p>
      </main>
    );
  }
  const exhausted = view.dealStatus?.disputeUsed === true;

  return (
    <main style={page}>
      <h1>Inspect (buyer)</h1>
      <p style={nav}>
        <a href={`/deals/${id}`}>← Dashboard</a>
      </p>

      {view.quote ? (
        <div style={card}>
          <h2>Settlement economics</h2>
          <ul>
            <li>
              Release (approve seller, S = P): seller <Money units={view.quote.sellerClaim} />, fee{" "}
              <Money units={view.quote.earnedFee} />. Posted bonds refunded in full.
            </li>
            <li>Refund (seller refunds, S = 0): buyer recovers principal + all prepaid fee. Posted bonds refunded.</li>
            <li>Doing nothing past inspection settles S = P automatically (full award to seller).</li>
          </ul>
        </div>
      ) : null}

      <div style={card}>
        <h2>Release / refund-settle</h2>
        <p style={{ fontSize: 14 }}>
          Terminal policy version (bytes32, from the signed policy set):
        </p>
        <input
          value={policyVersion}
          onChange={(e) => setPolicyVersion(e.target.value)}
          style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
        />
        <div>
          <button type="button" style={button} disabled={working} onClick={() => void settle("approveSeller", false)}>
            Relay: release to seller
          </button>
          <button type="button" style={secondaryButton} disabled={working} onClick={() => void settle("approveSeller", true)}>
            Direct: release to seller
          </button>
        </div>
        <div>
          <button type="button" style={button} disabled={working} onClick={() => void settle("refundBuyer", false)}>
            Relay: seller refund
          </button>
          <button type="button" style={secondaryButton} disabled={working} onClick={() => void settle("refundBuyer", true)}>
            Direct: seller refund
          </button>
        </div>
      </div>

      <SettlementProposals
        dealId={view.dealId as `0x${string}`}
        agreementDigest={(view.terms.agreementHash ?? view.dealId) as `0x${string}`}
        hub={(view.terms.hub ?? HUB_ADDRESS) as `0x${string}`}
        chainId={Number(view.terms.chainId ?? CHAIN_ID)}
        principalUnits={view.terms.principalUnits}
        quotedFeeUnits={view.terms.quotedFeeUnits}
        buyerFeeBps={view.terms.buyerFeeBps === "0" ? 0 : view.terms.buyerFeeBps === "10000" ? 10000 : 5000}
        phase={view.dealStatus?.phase ?? ""}
        settlementNonce={view.dealStatus?.settlementNonce}
      />

      <div style={card}>
        <h2>Dispute — freeze first</h2>
        {exhausted ? (
          <div style={warning}>No freeze left on this deal. Settle, escalate, or use escape paths instead.</div>
        ) : (
          <DisputeButton
            dealId={view.dealId as `0x${string}`}
            hub={(view.terms.hub ?? HUB_ADDRESS) as `0x${string}`}
            chainId={Number(view.terms.chainId ?? CHAIN_ID)}
            agreementDigest={(view.terms.agreementHash ?? ZERO_HASH) as `0x${string}`}
          />
        )}
      </div>

      {message ? <div style={ok}>{message}</div> : null}
      {failure ? <div style={error}>{failure}</div> : null}
      <p style={mono}>Dispute status: {exhausted ? "USED (exhausted)" : "one free freeze available"}</p>

      <FallbackNotice dealId={view.dealId} />
    </main>
  );
}
