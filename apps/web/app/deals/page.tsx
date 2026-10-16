"use client";

// My deals: every deal the signed-in wallet is party to, with where it stands
// and whether it is waiting on you.

import { useEffect, useMemo, useState } from "react";
import { getMyDeals, type MyDeal } from "../../lib/api";
import { formatAmount } from "../../lib/money";
import { categoryLabel, dealStage, isYourMove, shortAddress } from "../../lib/dealPhase";
import { useSession } from "../components/useSession";
import { Button, ButtonLink, Callout, Chip, Icon, Segmented } from "../components/ui";

type Filter = "all" | "action" | "active" | "done";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "action", label: "Needs you" },
  { value: "active", label: "In progress" },
  { value: "done", label: "Completed" },
];

function DealRow({ deal }: { deal: MyDeal }) {
  const stage = dealStage(deal.chainPhase, deal.status);
  const yourMove = isYourMove(stage, deal.role);
  return (
    <a href={`/deals/${encodeURIComponent(deal.draftId)}`} className="card card-link">
      <div className="row spread" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <h3 style={{ margin: 0 }}>{categoryLabel(deal.category)}</h3>
            <Chip tone={stage.tone}>{stage.label}</Chip>
            {yourMove ? <Chip tone="info">Your move</Chip> : null}
          </div>
          <p className="small muted" style={{ margin: "6px 0 0" }}>
            You are the {deal.role === "creator" ? "creator" : deal.role} · with{" "}
            <span className="mono">{shortAddress(deal.counterparty)}</span>
          </p>
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            {stage.summary}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="amount" style={{ fontSize: "1.15rem" }}>
            {deal.principalUnits ? formatAmount(deal.principalUnits) : "—"}
          </div>
          <div className="small muted">USDC</div>
        </div>
      </div>
    </a>
  );
}

function OpenById() {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const valid = /^(draft_[A-Za-z0-9_-]+|0x[0-9a-fA-F]{64})$/.test(trimmed);
  return (
    <form
      className="row"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) window.location.href = `/deals/${encodeURIComponent(trimmed)}`;
      }}
    >
      <input
        aria-label="Deal or draft ID"
        placeholder="Open a deal by ID (draft_… or 0x…)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ flex: "1 1 260px", width: "auto" }}
      />
      <Button type="submit" variant="secondary" disabled={!valid}>
        Open
      </Button>
    </form>
  );
}

export default function MyDealsPage() {
  const { session, loading, connect } = useSession();
  const [deals, setDeals] = useState<MyDeal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    if (!session) return;
    setDeals(null);
    setError(null);
    getMyDeals()
      .then(setDeals)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [session]);

  const visible = useMemo(() => {
    if (!deals) return [];
    return deals.filter((deal) => {
      const stage = dealStage(deal.chainPhase, deal.status);
      if (filter === "action") return isYourMove(stage, deal.role);
      if (filter === "done") return deal.chainPhase === "SETTLED";
      if (filter === "active") return deal.chainPhase !== "SETTLED";
      return true;
    });
  }, [deals, filter]);

  const waiting = deals?.filter((d) => isYourMove(dealStage(d.chainPhase, d.status), d.role)).length ?? 0;

  return (
    <main className="container page stack" style={{ gap: 20 }}>
      <div className="row spread">
        <div>
          <h1>My deals</h1>
          {session && deals ? (
            <p className="muted" style={{ margin: 0 }}>
              {deals.length === 0
                ? "No deals yet."
                : waiting > 0
                  ? `${waiting} ${waiting === 1 ? "deal is" : "deals are"} waiting on you.`
                  : "Nothing is waiting on you right now."}
            </p>
          ) : null}
        </div>
        <ButtonLink href="/deals/new">
          <Icon name="plus" size={16} /> New deal
        </ButtonLink>
      </div>

      {loading ? (
        <div className="stack">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 96 }} />
          ))}
        </div>
      ) : !session ? (
        <div className="card" style={{ textAlign: "center", padding: 32 }}>
          <span className="feature-icon" style={{ margin: "0 auto 12px" }}>
            <Icon name="wallet" />
          </span>
          <h2>Sign in to see your deals</h2>
          <p className="muted" style={{ maxWidth: "46ch", margin: "0 auto 16px" }}>
            Connect your wallet and sign a one-time login message. It proves you own the wallet and authorizes no funds.
          </p>
          <Button onClick={() => void connect().catch(() => undefined)}>Sign in with wallet</Button>
        </div>
      ) : (
        <>
          <Segmented label="Filter deals" value={filter} options={FILTERS} onChange={setFilter} />
          {error ? <Callout tone="danger" title="Couldn't load your deals">{error}</Callout> : null}
          {deals === null && !error ? (
            <div className="stack">
              {[0, 1].map((i) => (
                <div key={i} className="skeleton" style={{ height: 96 }} />
              ))}
            </div>
          ) : visible.length > 0 ? (
            <div className="stack" style={{ gap: 12 }}>
              {visible.map((deal) => (
                <DealRow key={deal.draftId} deal={deal} />
              ))}
            </div>
          ) : deals && deals.length === 0 ? (
            <div className="card" style={{ textAlign: "center", padding: 32 }}>
              <h2>Start your first deal</h2>
              <p className="muted">Draft the terms, then send the invite link to the other side.</p>
              <ButtonLink href="/deals/new">Create a deal</ButtonLink>
            </div>
          ) : (
            <p className="muted">No deals match this filter.</p>
          )}
        </>
      )}

      <div className="card">
        <h3>Have a deal ID?</h3>
        <OpenById />
      </div>
    </main>
  );
}
