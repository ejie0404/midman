"use client";

// Inspect & settle. The buyer releases payment or opens the one free dispute;
// the seller can refund voluntarily; during a dispute both sides can agree a
// split (settlement proposals) while the dispute timeline runs.

import { use, useState } from "react";
import type { Address, Hash } from "viem";
import { relaySubmit } from "../../../../lib/api";
import {
  encodeApproveSeller,
  encodeRefundBuyer,
  getAccount,
  randomBytes32,
  sendDirect,
  signSettle,
  waitForInclusion,
} from "../../../../lib/wallet";
import { formatAmount, formatUnixDate } from "../../../../lib/money";
import { friendlyError } from "../../../../lib/errors";
import { useDeal } from "../../../components/useDeal";
import { useSession } from "../../../components/useSession";
import DealShell, { chainPhaseOf, roleOf } from "../../../components/DealShell";
import Countdown from "../../../components/Countdown";
import DisputeButton from "../../../components/DisputeButton";
import DisputeProgress from "../../../components/DisputeProgress";
import SettlementProposals from "../../../components/SettlementProposals";
import { Button, ButtonLink, Callout, Card } from "../../../components/ui";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const DISPUTE_PHASES = new Set([
  "SELF_RESOLUTION",
  "AWAITING_ESCALATION",
  "EVIDENCE",
  "PRIMARY_REVIEW",
  "FALLBACK_REVIEW",
  "RULING_PENDING",
  "DEADLOCK",
]);

export default function InspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = decodeURIComponent(rawId);
  const view = useDeal(id);
  const { session, ensureWallet } = useSession();
  const [confirming, setConfirming] = useState<"approveSeller" | "refundBuyer" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const role = roleOf(view, session?.wallet);
  const phase = chainPhaseOf(view);
  const terms = view.terms;
  const digest = terms?.["agreementDigest"] as Hash | undefined;
  const inspectionEnds =
    view.dealStatus?.deliveredAt && terms ? Number(view.dealStatus.deliveredAt) + Number(terms.inspectionSeconds) : null;

  async function settle(kind: "approveSeller" | "refundBuyer", direct: boolean) {
    setBusy(kind + (direct ? "-direct" : ""));
    setFailure(null);
    try {
      if (!terms || !view.dealId || !digest) throw new Error("Deal data is incomplete. Reload the page.");
      await ensureWallet();
      const account = (await getAccount()) as Address;
      const actor = (kind === "approveSeller" ? terms.buyer : terms.seller) as Address;
      if (account.toLowerCase() !== actor.toLowerCase()) {
        throw new Error(`Switch your wallet to the ${kind === "approveSeller" ? "buyer" : "seller"} address on this deal.`);
      }
      const hub = terms.hub as Address;
      const dealId = view.dealId as Hash;
      const nonce = randomBytes32();
      const expiresAt = BigInt(Math.floor(Date.now() / 1_000) + 3_600);
      if (direct) {
        // Sent by the actor itself: the contract needs no signature.
        const data =
          kind === "approveSeller"
            ? encodeApproveSeller(dealId, ZERO_HASH, nonce, expiresAt, "0x")
            : encodeRefundBuyer(dealId, ZERO_HASH, nonce, expiresAt, "0x");
        const hash = await sendDirect(hub, data);
        await waitForInclusion(hash);
      } else {
        const sig = await signSettle(kind, hub, Number(terms.chainId), {
          dealId,
          agreementDigest: digest,
          actor,
          terminalPolicyVersion: ZERO_HASH,
          nonce,
          expiresAt,
        });
        await relaySubmit(`${kind}-${dealId.slice(2, 14)}-${Date.now()}`, kind, {
          dealId,
          terminalPolicyVersion: ZERO_HASH,
          nonce,
          expiresAt: expiresAt.toString(),
          sig,
        });
      }
      setDone(
        kind === "approveSeller"
          ? "Payment released. The seller can now claim it."
          : "Refund issued. The buyer can now claim it.",
      );
      setConfirming(null);
    } catch (e) {
      setFailure(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  const inDispute = phase !== null && DISPUTE_PHASES.has(phase);
  const back = `/deals/${encodeURIComponent(id)}`;

  return (
    <DealShell
      id={id}
      view={view}
      title={inDispute ? "Dispute center" : role === "seller" ? "Inspection" : "Inspect & release"}
    >
      {done ? (
        <Card>
          <Callout tone="success">{done}</Callout>
          <div style={{ marginTop: 12 }}>
            <ButtonLink href={`${back}/claim`}>Go to payouts</ButtonLink>
          </div>
        </Card>
      ) : !role ? (
        <Callout tone="neutral">Sign in as the buyer or seller to act on this deal.</Callout>
      ) : phase === null || phase === "AWAITING_DELIVERY" ? (
        <Callout tone="info">Inspection starts once the seller marks the deal delivered.</Callout>
      ) : phase === "SETTLED" ? (
        <Card>
          <Callout tone="success">This deal is settled.</Callout>
          <div style={{ marginTop: 12 }}>
            <ButtonLink href={`${back}/claim`}>Go to payouts</ButtonLink>
          </div>
        </Card>
      ) : (
        <>
          {phase === "DELIVERED" && inspectionEnds ? (
            <Callout tone={role === "buyer" ? "warning" : "info"}>
              Inspection ends {formatUnixDate(inspectionEnds)} (<Countdown targetUnix={String(inspectionEnds)} />).{" "}
              {role === "buyer"
                ? "If you do nothing, payment releases to the seller automatically."
                : "Payment releases to you automatically then, unless the buyer disputes."}
            </Callout>
          ) : null}

          {inDispute && view.dealId ? (
            <DisputeProgress
              dealId={view.dealId}
              fundedAt={view.dealStatus?.fundedAt}
              deliveredAt={view.dealStatus?.deliveredAt}
              disputeOpenedAt={view.dealStatus?.disputeOpenedAt}
              disputeUsed={view.dealStatus?.disputeUsed}
            />
          ) : null}

          {role === "buyer" ? (
            <Card title="Happy with what you received?">
              <p className="small muted">
                Releasing pays the seller {terms ? formatAmount(view.quote?.sellerClaim ?? terms.principalUnits) : ""} USDC
                now. This can&apos;t be undone.
              </p>
              {confirming === "approveSeller" ? (
                <div className="row">
                  <Button size="lg" disabled={busy !== null} onClick={() => void settle("approveSeller", false)}>
                    {busy === "approveSeller" ? "Check your wallet…" : "Yes, release payment"}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="row">
                  <Button size="lg" onClick={() => setConfirming("approveSeller")}>
                    Release payment
                  </Button>
                  <Button variant="ghost" disabled={busy !== null} onClick={() => void settle("approveSeller", true)}>
                    Release from my wallet
                  </Button>
                </div>
              )}
            </Card>
          ) : (
            <Card title="Want to cancel the deal?">
              <p className="small muted">Refunding returns the buyer&apos;s full deposit. No fee is charged on refunds.</p>
              {confirming === "refundBuyer" ? (
                <div className="row">
                  <Button variant="danger" disabled={busy !== null} onClick={() => void settle("refundBuyer", false)}>
                    {busy === "refundBuyer" ? "Check your wallet…" : "Yes, refund the buyer"}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setConfirming("refundBuyer")}>
                  Refund the buyer
                </Button>
              )}
            </Card>
          )}

          {role === "buyer" && phase === "DELIVERED" && view.dealId && terms && digest ? (
            <Card title="Something wrong?">
              {view.dealStatus?.disputeUsed ? (
                <Callout tone="warning">You already used this deal&apos;s one free dispute.</Callout>
              ) : (
                <>
                  <p className="small muted">
                    Opening a dispute freezes the deal for free (once per deal). You and the seller then have 24 hours to
                    agree; after that you can escalate to an independent panel with a 5 USDC bond.
                  </p>
                  <DisputeButton dealId={view.dealId as Hash} hub={terms.hub as Address} chainId={Number(terms.chainId)} agreementDigest={digest} />
                </>
              )}
            </Card>
          ) : null}

          {inDispute && view.dealId && terms && digest ? (
            <SettlementProposals
              dealId={view.dealId as Hash}
              agreementDigest={digest}
              hub={terms.hub as Address}
              chainId={Number(terms.chainId)}
              principalUnits={terms.principalUnits}
              quotedFeeUnits={terms.quotedFeeUnits}
              buyerFeeBps={terms.buyerFeeBps === "0" ? 0 : terms.buyerFeeBps === "10000" ? 10000 : 5000}
              phase={phase ?? ""}
              settlementNonce={view.dealStatus?.settlementNonce}
            />
          ) : null}

          {failure ? <Callout tone="danger">{failure}</Callout> : null}
        </>
      )}
    </DealShell>
  );
}
