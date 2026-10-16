"use client";

// Deal room: one place that says where the deal stands, what you should do
// next, and the exact money and deadlines. Detailed actions live on the
// sub-pages (review, fund, deliver, inspect, claim) that the next-action card
// links to.

import { use } from "react";
import { useDeal } from "../../components/useDeal";
import { useSession } from "../../components/useSession";
import { formatAmount, formatSpan, formatUnixDate } from "../../../lib/money";
import {
  DEAL_STEPS,
  categoryLabel,
  dealStage,
  nextAction,
  shortAddress,
  stepStates,
  type DealRole,
} from "../../../lib/dealPhase";
import Countdown from "../../components/Countdown";
import TxStatus from "../../components/TxStatus";
import FallbackNotice from "../../components/FallbackNotice";
import EvidenceSection from "../../components/EvidenceSection";
import DisputeProgress from "../../components/DisputeProgress";
import MessagesThread from "../../components/MessagesThread";
import { Button, ButtonLink, Callout, Card, Chip, Icon, KeyValues } from "../../components/ui";

function Party({ label, address, you }: { label: string; address: string; you: boolean }) {
  return (
    <div className="row spread">
      <span className="muted">{label}</span>
      <span className="row" style={{ gap: 8 }}>
        <span className="mono" title={address}>
          {shortAddress(address)}
        </span>
        {you ? <Chip tone="info">You</Chip> : null}
      </span>
    </div>
  );
}

export default function DealRoom({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = decodeURIComponent(rawId);
  const view = useDeal(id);
  const { session, loading: sessionLoading, connect } = useSession();

  if (view.loading || sessionLoading) {
    return (
      <main className="container page stack">
        <div className="skeleton" style={{ height: 40, width: 280 }} />
        <div className="skeleton" style={{ height: 140 }} />
        <div className="skeleton" style={{ height: 220 }} />
      </main>
    );
  }

  if (!view.terms && !view.dealStatus) {
    const needsAuth = !session && /401|auth/i.test(view.error ?? "");
    return (
      <main className="container container-narrow page stack">
        {needsAuth ? (
          <div className="card" style={{ textAlign: "center", padding: 32 }}>
            <span className="feature-icon" style={{ margin: "0 auto 12px" }}>
              <Icon name="lock" />
            </span>
            <h1 style={{ fontSize: "1.5rem" }}>Sign in to view this deal</h1>
            <p className="muted">Deal details are private to the buyer and seller. Sign in with the wallet named in the deal.</p>
            <Button onClick={() => void connect().then(() => window.location.reload()).catch(() => undefined)}>
              Sign in with wallet
            </Button>
          </div>
        ) : (
          <>
            <h1>Deal not found</h1>
            <Callout tone="danger">{view.error ?? "We couldn't find a deal with this ID."}</Callout>
            <ButtonLink href="/deals" variant="secondary">
              Back to my deals
            </ButtonLink>
          </>
        )}
      </main>
    );
  }

  const terms = view.terms;
  const chainPhase = view.dealStatus && view.dealStatus.source !== "draft" ? (view.dealStatus.phase ?? null) : null;
  const stage = dealStage(chainPhase, view.draftStatus);
  const me = session?.wallet.toLowerCase() ?? "";
  const role: DealRole | null =
    terms && me ? (terms.buyer.toLowerCase() === me ? "buyer" : terms.seller.toLowerCase() === me ? "seller" : null) : null;
  const action = nextAction(chainPhase, view.draftStatus, role);
  const base = `/deals/${encodeURIComponent(id)}`;
  const title = terms?.["title"] || categoryLabel(terms?.category);
  const agreementText = terms?.["agreementText"];
  const states = stepStates(stage);

  return (
    <main className="container page">
      <div className="row spread" style={{ alignItems: "flex-end", marginBottom: 20 }}>
        <div style={{ minWidth: 0 }}>
          <a href="/deals" className="small">
            ← My deals
          </a>
          <h1 style={{ margin: "6px 0 6px" }}>{title}</h1>
          <div className="row" style={{ gap: 8 }}>
            <Chip tone={stage.tone}>{stage.label}</Chip>
            <span className="small muted">
              {categoryLabel(terms?.category)}
              {role ? ` · you are the ${role}` : ""}
            </span>
          </div>
        </div>
        {terms ? (
          <div style={{ textAlign: "right" }}>
            <div className="amount amount-lg">{formatAmount(terms.principalUnits)}</div>
            <div className="small muted">USDC</div>
          </div>
        ) : null}
      </div>

      <ol className="stepper" aria-label="Deal progress" style={{ marginBottom: 20 }}>
        {DEAL_STEPS.map((label, i) => (
          <li key={label} data-state={states[i]} aria-current={states[i] === "current" ? "step" : undefined}>
            {label}
          </li>
        ))}
      </ol>

      <div className="grid-2" style={{ alignItems: "start", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))" }}>
        <div className="stack">
          <section className="card" style={{ borderColor: action.cta ? "var(--primary)" : undefined }}>
            <span className="eyebrow">{action.cta ? "Your next step" : "Status"}</span>
            <p style={{ margin: "8px 0 14px", fontSize: 16 }}>{action.message}</p>
            {!session ? (
              <Button onClick={() => void connect().then(() => window.location.reload()).catch(() => undefined)}>
                Sign in to act on this deal
              </Button>
            ) : action.cta ? (
              <ButtonLink href={`${base}/${action.cta.path}`} size="lg">
                {action.cta.label} <Icon name="arrow-right" size={16} />
              </ButtonLink>
            ) : null}
            {view.dealStatus?.disputeUsed === true && chainPhase === "DELIVERED" ? (
              <div style={{ marginTop: 12 }}>
                <Callout tone="warning">The one free dispute for this deal has already been used.</Callout>
              </div>
            ) : null}
          </section>

          {agreementText ? (
            <Card title="Agreement">
              <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{agreementText}</p>
              <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
                Both parties sign the hash of this text as part of the deal terms.
              </p>
            </Card>
          ) : null}

          {view.dealId && chainPhase ? (
            <DisputeProgress
              dealId={view.dealId}
              fundedAt={view.dealStatus?.fundedAt}
              deliveredAt={view.dealStatus?.deliveredAt}
              disputeOpenedAt={view.dealStatus?.disputeOpenedAt}
              disputeUsed={view.dealStatus?.disputeUsed}
            />
          ) : null}

          {view.dealId && chainPhase ? (
            <>
              <MessagesThread dealId={view.dealId} />
              <EvidenceSection dealId={view.dealId} />
            </>
          ) : (
            <Card title="Messages & evidence">
              <p className="small muted" style={{ margin: 0 }}>
                Messages and evidence open once the buyer funds the escrow.
              </p>
            </Card>
          )}
        </div>

        <div className="stack">
          {terms ? (
            <Card title="Money">
              <KeyValues
                rows={[
                  { label: "Price", value: `${formatAmount(terms.principalUnits)} USDC` },
                  { label: "Platform fee", value: `${formatAmount(terms.quotedFeeUnits)} USDC` },
                  { label: "Buyer deposits", value: `${formatAmount(terms.fundedUnits)} USDC` },
                  ...(view.quote
                    ? [{ label: "Seller receives on release", value: `${formatAmount(view.quote.sellerClaim)} USDC`, total: true }]
                    : []),
                ]}
              />
            </Card>
          ) : null}

          {terms ? (
            <Card title="Timeline">
              <KeyValues
                rows={[
                  { label: "Delivery window", value: formatSpan(Number(terms.deliverySeconds)) },
                  { label: "Inspection window", value: formatSpan(Number(terms.inspectionSeconds)) },
                  ...(view.dealStatus?.fundedAt ? [{ label: "Funded", value: formatUnixDate(view.dealStatus.fundedAt) }] : []),
                  ...(view.dealStatus?.deliveredAt ? [{ label: "Delivered", value: formatUnixDate(view.dealStatus.deliveredAt) }] : []),
                  ...(view.dealStatus?.disputeOpenedAt
                    ? [{ label: "Dispute opened", value: formatUnixDate(view.dealStatus.disputeOpenedAt) }]
                    : []),
                  ...(!chainPhase
                    ? [{ label: "Must be funded within", value: <Countdown targetUnix={terms.fundingDeadline} /> }]
                    : []),
                ]}
              />
            </Card>
          ) : null}

          {terms ? (
            <Card title="Parties">
              <div className="stack" style={{ gap: 10 }}>
                <Party label="Buyer" address={terms.buyer} you={role === "buyer"} />
                <Party label="Seller" address={terms.seller} you={role === "seller"} />
              </div>
            </Card>
          ) : null}

          {view.dealId ? <FallbackNotice dealId={view.dealId} /> : null}

          <details className="card">
            <summary style={{ cursor: "pointer", fontWeight: 560 }}>Technical details</summary>
            <div className="stack small" style={{ gap: 8, marginTop: 12 }}>
              {view.draftId ? (
                <div>
                  Draft ID <span className="mono">{view.draftId}</span>
                </div>
              ) : null}
              {view.dealId ? (
                <div style={{ wordBreak: "break-all" }}>
                  Deal ID <span className="mono">{view.dealId}</span>
                </div>
              ) : null}
              <div>
                Chain confirmation:{" "}
                {view.confirmation ? <TxStatus level={view.confirmation.level} /> : "not yet on chain"}
              </div>
              <div className="muted">
                Only what is included on chain counts. Pending transactions and off-chain signatures can still change.
              </div>
            </div>
          </details>
        </div>
      </div>

      {session && action.cta ? (
        <div className="action-bar">
          <div className="container">
            <ButtonLink href={`${base}/${action.cta.path}`} block size="lg">
              {action.cta.label}
            </ButtonLink>
          </div>
        </div>
      ) : null}
    </main>
  );
}
