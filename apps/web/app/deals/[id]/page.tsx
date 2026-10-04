"use client";

import { use } from "react";
import { useDeal } from "../../components/useDeal";
import { formatFeePct, formatUSDC, formatUnixDate } from "../../../lib/money";
import Countdown from "../../components/Countdown";
import TxStatus from "../../components/TxStatus";
import FallbackNotice from "../../components/FallbackNotice";
import Money from "../../components/Money";
import { PROGRESS_STEPS } from "../../../lib/deal";
import { button, card, error, mono, nav, ok, page, warning } from "../../components/styles";
import EvidenceSection from "../../components/EvidenceSection";
import DisputeProgress from "../../components/DisputeProgress";
import MessagesThread from "../../components/MessagesThread";

function stepIndex(view: ReturnType<typeof useDeal>): number {
  const phase = view.dealStatus?.phase;
  if (phase === "SETTLED") return 8;
  if (phase && ["SELF_RESOLUTION", "AWAITING_ESCALATION", "EVIDENCE", "PRIMARY_REVIEW", "FALLBACK_REVIEW", "RULING_PENDING", "DEADLOCK"].includes(phase)) return 7;
  if (phase === "DELIVERED") return 6;
  if (phase === "AWAITING_DELIVERY") return 5;
  if (view.draftStatus === "admitted") return 4;
  if (view.draftStatus === "signed") return 3;
  if (view.draftStatus === "accepted") return 2;
  if (view.draftStatus === "invited") return 1;
  return 0;
}

export default function DealDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const view = useDeal(decodeURIComponent(id));

  if (view.loading) {
    return (
      <main style={page}>
        <p>Loading deal…</p>
      </main>
    );
  }
  if (!view.terms && !view.dealStatus) {
    return (
      <main style={page}>
        <h1>Deal not found</h1>
        <div style={error}>{view.error ?? "Unknown deal."}</div>
        <p style={nav}>
          <a href="/">← Home</a>
        </p>
      </main>
    );
  }

  const terms = view.terms;
  const current = stepIndex(view);
  const phase = view.dealStatus?.phase ?? view.draftStatus ?? "DRAFT";
  const exhausted = view.dealStatus?.disputeUsed === true;

  return (
    <main style={page}>
      <h1>Deal dashboard</h1>
      <p style={nav}>
        <a href="/">← Home</a>
      </p>

      <div style={card}>
        <h2>
          Phase: {phase} <span style={{ fontSize: 13 }}>(source: {view.dealStatus?.source ?? "draft"})</span>
        </h2>
        {view.confirmation ? (
          <p>
            Chain confirmation: <TxStatus level={view.confirmation.level} />
          </p>
        ) : (
          <p style={{ fontSize: 14 }}>
            Confirmation: unavailable{view.confirmationError ? ` (${view.confirmationError})` : ""} — treat all
            off-chain state as pending until included.
          </p>
        )}
        {exhausted ? (
          <div style={warning}>
            <strong>Dispute exhausted.</strong> This deal&apos;s single free dispute freeze has been used
            (`disputeUsed`). No further freeze is possible; only escalation, settlement, or escape paths remain.
          </div>
        ) : null}
        {phase === "DELIVERED" || phase === "SELF_RESOLUTION" ? (
          <div style={warning}>
            Inspection clock is running. The buyer&apos;s one free freeze is still available — freezing stops the
            timeout path.
          </div>
        ) : null}
      </div>

      {view.dealId ? (
        <DisputeProgress
          dealId={view.dealId}
          fundedAt={view.dealStatus?.fundedAt}
          deliveredAt={view.dealStatus?.deliveredAt}
          disputeOpenedAt={view.dealStatus?.disputeOpenedAt}
          disputeUsed={view.dealStatus?.disputeUsed}
        />
      ) : null}

      <div style={card}>
        <h2>Progress</h2>
        <ol>
          {PROGRESS_STEPS.map((step, i) => (
            <li key={step} style={{ fontWeight: i === current ? 700 : 400 }}>
              {step}
              {i === current ? " ← current" : ""}
              {i < current ? " ✓" : ""}
            </li>
          ))}
        </ol>
      </div>

      {terms ? (
        <div style={card}>
          <h2>Exact amounts & deadlines</h2>
          <ul>
            <li>
              Deal ID: <span style={mono}>{terms.dealId}</span>
            </li>
            <li>
              Buyer: <span style={mono}>{terms.buyer}</span>
            </li>
            <li>
              Seller: <span style={mono}>{terms.seller}</span>
            </li>
            <li>
              Principal: <Money units={terms.principalUnits} />
            </li>
            <li>
              Quoted fee: <Money units={terms.quotedFeeUnits} /> (buyer share{" "}
              {formatFeePct(Number(terms.buyerFeeBps) / 100)} of earned fee; prepaid{" "}
              <Money units={terms.prepaidBuyerFeeUnits} />)
            </li>
            <li>
              <strong>
                Total funding: <Money units={terms.fundedUnits} />
              </strong>
            </li>
            <li>Delivery: {Number(terms.deliverySeconds)}s · Inspection: {Number(terms.inspectionSeconds)}s</li>
            <li>
              Funding deadline: {formatUnixDate(terms.fundingDeadline)} (<Countdown targetUnix={terms.fundingDeadline} />)
            </li>
            <li>Category: {terms.category}</li>
          </ul>
          {view.quote ? (
            <div style={ok}>
              Full-release preview (S = P): buyer gets <Money units={view.quote.buyerClaim} />, seller gets{" "}
              <Money units={view.quote.sellerClaim} />, earned fee <Money units={view.quote.earnedFee} /> (source:{" "}
              {view.quote.source}).
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={card}>
        <h2>Transaction status (pending vs included)</h2>
        <ul>
          <li>
            Buyer signature: {view.signatures["buyer"] ? "collected (off-chain — not a chain transaction)" : "missing"}
          </li>
          <li>
            Seller signature: {view.signatures["seller"] ? "collected (off-chain — not a chain transaction)" : "missing"}
          </li>
          <li>
            Deal confirmation:{" "}
            {view.confirmation ? <TxStatus level={view.confirmation.level} /> : "unknown (no RPC or not indexed)"}
          </li>
          {view.dealStatus?.fundedAt ? <li>Funded at: {formatUnixDate(view.dealStatus.fundedAt)}</li> : null}
          {view.dealStatus?.deliveredAt ? <li>Delivered at: {formatUnixDate(view.dealStatus.deliveredAt)}</li> : null}
          {view.dealStatus?.disputeOpenedAt ? (
            <li>Dispute opened at: {formatUnixDate(view.dealStatus.disputeOpenedAt)}</li>
          ) : null}
        </ul>
      </div>

      {view.dealId ? <FallbackNotice dealId={view.dealId} /> : null}

      {view.dealId ? (
        <>
          <EvidenceSection dealId={view.dealId} />
          <MessagesThread dealId={view.dealId} />
        </>
      ) : (
        <div style={card}>
          <h2>Evidence & messages</h2>
          <p style={{ fontSize: 14 }}>
            Evidence and messages unlock once the deal has an on-chain deal ID (after funding is indexed).
          </p>
        </div>
      )}

      <div style={card}>
        <h2>Next actions</h2>
        <p style={nav}>
          <a href={`/deals/${id}/review`} style={{ ...button, textDecoration: "none", display: "inline-block" }}>
            Review & sign
          </a>
          <a href={`/deals/${id}/fund`} style={{ ...button, textDecoration: "none", display: "inline-block" }}>
            Fund
          </a>
          <a
            href={`/deals/${id}/deliver`}
            style={{ ...button, textDecoration: "none", display: "inline-block" }}
          >
            Deliver
          </a>
          <a
            href={`/deals/${id}/inspect`}
            style={{ ...button, textDecoration: "none", display: "inline-block" }}
          >
            Inspect / dispute
          </a>
          <a href={`/deals/${id}/claim`} style={{ ...button, textDecoration: "none", display: "inline-block" }}>
            Claim / recovery
          </a>
        </p>
      </div>
    </main>
  );
}
