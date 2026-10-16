"use client";

// Common frame for the deal action pages (review, fund, deliver, inspect,
// claim): back link to the deal room, page title, deal name, amount and
// status chip, plus loading / not-found / signed-out states.

import type { ReactNode } from "react";
import type { DealView } from "./useDeal";
import { useSession } from "./useSession";
import { formatAmount } from "../../lib/money";
import { categoryLabel, dealStage } from "../../lib/dealPhase";
import { Button, ButtonLink, Callout, Chip, Icon } from "./ui";

export function roleOf(view: DealView, wallet: string | null | undefined): "buyer" | "seller" | null {
  if (!view.terms || !wallet) return null;
  const me = wallet.toLowerCase();
  if (view.terms.buyer.toLowerCase() === me) return "buyer";
  if (view.terms.seller.toLowerCase() === me) return "seller";
  return null;
}

export function chainPhaseOf(view: DealView): string | null {
  return view.dealStatus && view.dealStatus.source !== "draft" ? (view.dealStatus.phase ?? null) : null;
}

export default function DealShell({
  id,
  view,
  title,
  subtitle,
  children,
  allowWithoutTerms,
}: {
  id: string;
  view: DealView;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Render children even when the terms are not readable yet (invite acceptance). */
  allowWithoutTerms?: boolean;
}) {
  const { session, loading, connect } = useSession();
  const back = `/deals/${encodeURIComponent(id)}`;

  if (view.loading || loading) {
    return (
      <main className="container container-narrow page stack">
        <div className="skeleton" style={{ height: 36, width: 240 }} />
        <div className="skeleton" style={{ height: 180 }} />
      </main>
    );
  }

  if (!view.terms && !allowWithoutTerms) {
    return (
      <main className="container container-narrow page stack">
        <a href={back} className="small">
          ← Back to deal
        </a>
        {!session ? (
          <div className="card" style={{ textAlign: "center", padding: 32 }}>
            <span className="feature-icon" style={{ margin: "0 auto 12px" }}>
              <Icon name="lock" />
            </span>
            <h1 style={{ fontSize: "1.5rem" }}>Sign in to continue</h1>
            <p className="muted">Only the buyer and seller can act on this deal.</p>
            <Button onClick={() => void connect().then(() => window.location.reload()).catch(() => undefined)}>
              Sign in with wallet
            </Button>
          </div>
        ) : (
          <>
            <h1>Deal unavailable</h1>
            <Callout tone="danger">{view.error ?? "This deal could not be loaded for your wallet."}</Callout>
            <ButtonLink href="/deals" variant="secondary">
              My deals
            </ButtonLink>
          </>
        )}
      </main>
    );
  }

  const stage = dealStage(chainPhaseOf(view), view.draftStatus);
  return (
    <main className="container container-narrow page stack" style={{ gap: 20 }}>
      <div>
        <a href={back} className="small">
          ← Back to deal
        </a>
        <h1 style={{ margin: "6px 0 6px" }}>{title}</h1>
        {view.terms ? (
          <div className="row" style={{ gap: 8 }}>
            <Chip tone={stage.tone}>{stage.label}</Chip>
            <span className="small muted">
              {view.terms["title"] || categoryLabel(view.terms.category)} · {formatAmount(view.terms.principalUnits)} USDC
            </span>
          </div>
        ) : null}
        {subtitle ? <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>{subtitle}</p> : null}
      </div>
      {children}
    </main>
  );
}
