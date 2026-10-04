"use client";

import { use, useEffect, useState } from "react";
import { getQuote, postSignature, ApiError, type QuoteResult } from "../../../../lib/api";
import { formatUSDC } from "../../../../lib/money";
import { CHAIN_ID, HUB_ADDRESS, getAccount, getWalletClient, signAcceptance } from "../../../../lib/wallet";
import { isHexAddress } from "../../../../lib/deal";
import {
  acceptInvitationAsCounterparty,
  clearInviteFromLocation,
  readInviteToken,
} from "../../../../lib/invite";
import { getSession } from "../../../../lib/session";
import { useDeal } from "../../../components/useDeal";
import Money from "../../../components/Money";
import { button, card, error, mono, nav, ok, page, secondaryButton, warning } from "../../../components/styles";

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: routeId } = use(params);
  const draftId = decodeURIComponent(routeId);
  const view = useDeal(draftId);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [sessionWallet, setSessionWallet] = useState<string | null>(null);
  const [sessionExpiry, setSessionExpiry] = useState<number | null>(null);
  const [acceptAddress, setAcceptAddress] = useState("");
  const [signing, setSigning] = useState<"buyer" | "seller" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [partial, setPartial] = useState<QuoteResult | null>(null);
  // UI-only dispute-risk acknowledgement (localStorage; never sent, never a
  // substitute for reading the terms). Sign buttons stay disabled until set.
  const [acked, setAcked] = useState(false);

  useEffect(() => {
    try {
      setAcked(window.localStorage.getItem(`midman-dispute-ack-${draftId}`) === "1");
    } catch {
      setAcked(false);
    }
  }, [draftId]);

  function setAck(checked: boolean) {
    setAcked(checked);
    try {
      if (checked) window.localStorage.setItem(`midman-dispute-ack-${draftId}`, "1");
      else window.localStorage.removeItem(`midman-dispute-ack-${draftId}`);
    } catch {
      // UI-only; ignore storage failures.
    }
  }

  useEffect(() => {
    // Invitation token is read from the URL fragment only: it is never logged
    // and never sent to any endpoint except the explicit accept POST.
    setInviteToken(readInviteToken(window.location.hash));
    let cancelled = false;
    (async () => {
      try {
        const session = await getSession();
        if (!cancelled && session.authenticated) {
          setSessionWallet(session.wallet);
          setSessionExpiry(session.expiresAt);
        }
      } catch {
        // No session yet; the accept flow will sign in.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function accept() {
    setMessage(null);
    setFailure(null);
    try {
      if (!inviteToken) throw new Error("No invitation token in the URL fragment — open the private invite link.");
      const account = await getAccount();
      if (isHexAddress(acceptAddress) && acceptAddress.toLowerCase() !== account.toLowerCase()) {
        throw new Error("The entered address does not match the connected wallet.");
      }
      const wallet = getWalletClient();
      const signer = {
        address: account,
        signMessage: (m: string) => wallet.signMessage({ account, message: m }),
      };
      await acceptInvitationAsCounterparty({
        draftId,
        token: inviteToken,
        signer,
        chainId: Number(view.terms?.chainId ?? CHAIN_ID),
      });
      // Remove the token from the visible URL only AFTER the server accepted it.
      clearInviteFromLocation(window.location, window.history);
      setMessage("Invitation accepted with a signed wallet session. Now collect both signatures below.");
      window.location.reload();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }

  async function sign(role: "buyer" | "seller") {
    setMessage(null);
    setFailure(null);
    setSigning(role);
    try {
      if (!view.terms) throw new Error("Terms not loaded");
      const expected = (role === "buyer" ? view.terms.buyer : view.terms.seller) as `0x${string}`;
      const account = await getAccount();
      if (account.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Connected wallet ${account} is not the ${role} (${expected})`);
      }
      const signature = await signAcceptance({
        dealId: view.terms.dealId as `0x${string}`,
        principalUnits: view.terms.principalUnits,
        quotedFeeUnits: view.terms.quotedFeeUnits,
        buyer: view.terms.buyer as `0x${string}`,
        seller: view.terms.seller as `0x${string}`,
        chainId: Number(view.terms.chainId ?? CHAIN_ID),
        hub: (view.terms.hub ?? HUB_ADDRESS) as `0x${string}`,
      });
      await postSignature(draftId, role, signature);
      setMessage(`${role} signature collected (off-chain; pending until funded on-chain).`);
      window.location.reload();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(null);
    }
  }

  async function previewHalf() {
    setFailure(null);
    try {
      if (!view.terms) throw new Error("Terms not loaded");
      const half = (BigInt(view.terms.principalUnits) / 2n).toString();
      setPartial(await getQuote(draftId, half));
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }

  function download() {
    if (!view.terms) return;
    const blob = new Blob([JSON.stringify({ terms: view.terms, signatures: view.signatures }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `midman-terms-${view.terms.dealId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (view.loading) {
    return (
      <main style={page}>
        <p>Loading terms…</p>
      </main>
    );
  }
  if (!view.terms) {
    return (
      <main style={page}>
        <h1>Review</h1>
        <div style={error}>{view.error ?? "Draft not found."}</div>
        <p style={nav}>
          <a href="/">← Home</a>
        </p>
      </main>
    );
  }
  const terms = view.terms;

  return (
    <main style={page}>
      <h1>Review & sign</h1>
      <p style={nav}>
        <a href={`/deals/${routeId}`}>← Dashboard</a>
      </p>

      {inviteToken ? (
        <div style={ok}>Private invite link detected. It is kept in the URL fragment and sent only to the accept endpoint.</div>
      ) : (
        <div style={warning}>
          No invite token in the URL fragment. You can still review, but acceptance requires the private invite link.
        </div>
      )}

      <div style={card}>
        <h2>Wallet session</h2>
        {sessionWallet ? (
          <p style={{ fontSize: 14 }}>
            Signed in as <span style={mono}>{sessionWallet}</span>
            {sessionExpiry ? ` · session expires ${new Date(sessionExpiry * 1_000).toISOString()}` : ""}. Wallet
            connection alone is not authentication — this session came from a personal_sign challenge.
          </p>
        ) : (
          <p style={{ fontSize: 14 }}>
            Not signed in. Accepting the invitation will issue a sign-in challenge and sign it with your wallet.
          </p>
        )}
      </div>

      <div style={card}>
        <h2>Agreement summary (built from signed terms + exact quote)</h2>
        <ul>
          <li>
            Deal: <span style={mono}>{terms.dealId}</span>
          </li>
          <li>
            Buyer: <span style={mono}>{terms.buyer}</span>
          </li>
          <li>
            Seller: <span style={mono}>{terms.seller}</span>
          </li>
          <li>
            Principal: <Money units={terms.principalUnits} /> · Quoted fee: <Money units={terms.quotedFeeUnits} />
          </li>
          <li>
            Buyer prepaid fee: <Money units={terms.prepaidBuyerFeeUnits} /> ·{" "}
            <strong>
              Total funding: <Money units={terms.fundedUnits} />
            </strong>
          </li>
          <li>
            Delivery {Number(terms.deliverySeconds)}s, inspection {Number(terms.inspectionSeconds)}s, category{" "}
            {terms.category}
          </li>
          <li>
            Fee formula: earned = floor(quoted × award ÷ principal); buyer part = floor(earned ×{" "}
            {terms.buyerFeeBps} ÷ 10000); seller part = earned − buyer part. Odd-unit fee remainder goes to the
            seller share.
          </li>
        </ul>
        {view.quote ? (
          <p>
            Full-release preview: buyer <Money units={view.quote.buyerClaim} />, seller{" "}
            <Money units={view.quote.sellerClaim} />, fee <Money units={view.quote.earnedFee} />.
            <button type="button" style={secondaryButton} onClick={() => void previewHalf()}>
              Preview 50% award
            </button>
          </p>
        ) : null}
        {partial ? (
          <p>
            50% award preview: buyer <Money units={partial.buyerClaim} />, seller{" "}
            <Money units={partial.sellerClaim} />, fee <Money units={partial.earnedFee} />.
          </p>
        ) : null}
      </div>

      <div style={warning}>
        <strong>Dispute economics.</strong> One free dispute freeze per deal. Escalation requires a real 5
        USDC-minimum bond per contesting party. Catastrophic escape (60 days from first dispute, properly escalated
        deals only) splits principal 50/50 with the odd unit to the buyer and zero fees. Unilateral release/refund
        returns both bonds in full.
      </div>

      <div style={card}>
        <h2>Before funding: dispute consequences</h2>
        <ul style={{ fontSize: 14 }}>
          <li>
            <strong>Lapse consequence.</strong> If nobody escalates with a bond inside the 24h escalation window, the
            dispute lapses and the deal resumes the normal timeout path — the consumed free freeze is not refunded.
          </li>
          <li>
            <strong>One free dispute.</strong> Opening a dispute permanently consumes the deal&apos;s single free
            freeze (`disputeUsed`). There is no second freeze.
          </li>
          <li>
            <strong>Bond minimums.</strong> Escalation and respondent bonds are real funds with a 5 USDC minimum each;
            partial rulings apportion bond costs by award share (P-03).
          </li>
          <li>
            <strong>50/50 escape.</strong> Only properly escalated deals can reach catastrophic escape (60 days after
            the first dispute): principal splits 50/50, odd unit to the buyer, zero fees.
          </li>
        </ul>
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>
          <input type="checkbox" checked={acked} onChange={(e) => setAck(e.target.checked)} /> I understand the
          dispute consequences above (UI-only checkbox, stored in this browser&apos;s localStorage — it is not sent
          anywhere and does not alter the on-chain terms).
        </label>
      </div>

      <div style={card}>
        <h2>Accept (counterparty)</h2>
        <p style={{ fontSize: 14 }}>
          Reads the invitation token from the URL fragment, authenticates the intended wallet with a signed session,
          and POSTs the token to the accept endpoint. The server rejects expired, revoked, consumed, or wrong-wallet
          tokens. Must match the counterparty hint, if set.
        </p>
        <input
          value={acceptAddress}
          onChange={(e) => setAcceptAddress(e.target.value)}
          placeholder="0x… (confirm the connected counterparty wallet)"
          style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
        />
        <div>
          <button type="button" style={button} disabled={!inviteToken} onClick={() => void accept()}>
            Accept invitation
          </button>
          <button type="button" style={secondaryButton} onClick={download}>
            Download terms JSON
          </button>
        </div>
      </div>

      <div style={card}>
        <h2>Signatures (off-chain EIP-712, pending until funded)</h2>
        <p>Buyer: {view.signatures["buyer"] ? "signed ✓" : "missing"}</p>
        <p>Seller: {view.signatures["seller"] ? "signed ✓" : "missing"}</p>
        {!acked ? (
          <p style={{ fontSize: 14 }}>Tick the dispute-consequences checkbox above to enable signing.</p>
        ) : null}
        <button type="button" style={button} disabled={signing !== null || !acked} onClick={() => void sign("buyer")}>
          {signing === "buyer" ? "Signing…" : "Sign as buyer"}
        </button>
        <button
          type="button"
          style={secondaryButton}
          disabled={signing !== null || !acked}
          onClick={() => void sign("seller")}
        >
          {signing === "seller" ? "Signing…" : "Sign as seller"}
        </button>
      </div>

      {message ? <div style={ok}>{message}</div> : null}
      {failure ? <div style={error}>{failure}</div> : null}

      <p style={nav}>
        <a href={`/deals/${routeId}/fund`}>Continue to funding →</a>
      </p>
    </main>
  );
}
