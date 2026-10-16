"use client";

import { useMemo, useState } from "react";
import { quoteFee } from "@midman/shared";
import { formatAmount, parseUSDC } from "../lib/money";
import { ButtonLink, Card, Chip, Field, Icon, KeyValues, Segmented, type IconName } from "./components/ui";

// Every number on this page mirrors the contracts (Finance.sol, DealTypes.sol,
// MidmanPolicies.sol). Keep them in sync: users rely on these claims.
const FEE_TIERS = [
  { window: "Up to 3 hours", rate: "0.25%" },
  { window: "3 to 24 hours", rate: "0.50%" },
  { window: "1 to 3 days", rate: "0.70%" },
  { window: "3 to 7 days", rate: "1.00%" },
  { window: "Over 7 days", rate: "2.00%" },
];

const DURATIONS = [
  { value: 3 * 3600, label: "3h" },
  { value: 12 * 3600, label: "12h" },
  { value: 3 * 86400, label: "3 days" },
  { value: 7 * 86400, label: "7 days" },
  { value: 14 * 86400, label: "14 days" },
] as const;

const STEPS: { title: string; text: string }[] = [
  { title: "Agree on terms", text: "One side drafts the deal: item, price, delivery and inspection windows. The other side opens a private invite and both sign the exact same terms." },
  { title: "Buyer funds escrow", text: "The buyer deposits the price plus their share of the fee in one transaction. The money sits in the escrow contract, not with Midman." },
  { title: "Seller delivers", text: "The seller delivers and marks the deal delivered. If they never do, the buyer gets a full refund when the delivery window ends." },
  { title: "Buyer inspects", text: "The buyer checks what they received. Releasing pays the seller right away; doing nothing releases automatically when inspection ends." },
  { title: "Paid out", text: "Each side claims their payout to the address fixed in the signed terms. Nobody can redirect it." },
];

const PROTECTIONS: { icon: IconName; title: string; text: string }[] = [
  { icon: "lock", title: "Held by a contract", text: "Funds are locked in the escrow contract on Base. Midman cannot spend them or change where they go." },
  { icon: "pen", title: "Same terms, both signatures", text: "Price, deadlines and payout addresses are signed by both sides before any money moves." },
  { icon: "clock", title: "One free dispute", text: "During inspection the buyer can freeze the deal once, at no cost, and both sides get 24 hours to settle." },
  { icon: "scale", title: "Independent arbitration", text: "Unresolved disputes go to a five-member panel; larger deals need more signatures. A separate panel can veto a ruling." },
  { icon: "shield", title: "60-day escape hatch", text: "If arbitration stalls, an escalated dispute can always exit after 60 days: principal split 50/50, fees refunded." },
  { icon: "check", title: "Pull-based payouts", text: "Payouts are claimed, not pushed, so one failed transfer can never block anyone else's money." },
];

const FAQ: { q: string; a: string }[] = [
  { q: "What happens if the seller never delivers?", a: "When the delivery window ends without a delivery, the buyer can take a full refund, including their prepaid fee. No platform fee is charged on refunds." },
  { q: "What if I'm not happy with what I received?", a: "Open a dispute before inspection ends. It freezes the deal and gives both sides 24 hours to agree. If you don't, the buyer can escalate to arbitration by posting a 5 USDC bond." },
  { q: "Who holds the money?", a: "The escrow smart contract on Base. Payouts go only to the addresses both parties signed. Midman's admin powers are limited to pausing new deals." },
  { q: "What does it cost?", a: "A fee from 0.25% to 2% depending on how long the deal runs (delivery plus inspection), with a 0.50 USDC minimum. The buyer pays by default; you can split it 50/50 or have the seller pay. Fees are only earned on money that reaches the seller." },
  { q: "What can I trade?", a: "Instant codes, game items and currency, game accounts, digital goods and services. Each category has a minimum inspection window, from 1 hour for instant codes to 24 hours for game accounts." },
  { q: "Do I need ETH for gas?", a: "Most actions can be relayed for you: you sign with your wallet and the relayer submits the transaction. It can only do exactly what you signed." },
];

function FeeCalculator() {
  const [amount, setAmount] = useState("250");
  const [duration, setDuration] = useState<number>(3 * 86400);
  const result = useMemo(() => {
    try {
      const units = BigInt(parseUSDC(amount || "0"));
      if (units < 5_000_000n) return { error: "Minimum deal is 5.00 USDC" };
      const fee = quoteFee(units, duration);
      return { fee, total: units + fee };
    } catch {
      return { error: "Enter an amount like 250 or 99.50" };
    }
  }, [amount, duration]);

  return (
    <Card title="Fee calculator">
      <div className="stack">
        <Field label="Deal amount (USDC)" htmlFor="calc-amount">
          <input id="calc-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Delivery + inspection time">
          <Segmented
            label="Deal duration"
            value={duration}
            options={DURATIONS.map((d) => ({ value: d.value, label: d.label }))}
            onChange={setDuration}
          />
        </Field>
        {"error" in result ? (
          <p className="small muted">{result.error}</p>
        ) : (
          <KeyValues
            rows={[
              { label: "Platform fee", value: `${formatAmount(result.fee!)} USDC` },
              { label: "Buyer deposits (buyer pays fee)", value: `${formatAmount(result.total!)} USDC`, total: true },
            ]}
          />
        )}
      </div>
    </Card>
  );
}

function DealPreview() {
  return (
    <div className="card" style={{ boxShadow: "var(--shadow)" }} aria-label="Example deal">
      <div className="row spread">
        <span className="eyebrow">Example deal</span>
        <Chip tone="teal">Inspecting</Chip>
      </div>
      <h3 style={{ margin: "12px 0 2px" }}>Rare skin bundle</h3>
      <p className="small muted">Game item · 72h inspection</p>
      <div className="amount amount-lg" style={{ margin: "12px 0" }}>
        250.00 <span className="muted" style={{ fontSize: "1rem" }}>USDC</span>
      </div>
      <ol className="stepper" aria-label="Progress">
        {["Agree", "Fund", "Deliver", "Inspect", "Complete"].map((label, i) => (
          <li key={label} data-state={i < 3 ? "done" : i === 3 ? "current" : "todo"}>
            {label}
          </li>
        ))}
      </ol>
      <hr className="divider" />
      <div className="row spread small">
        <span className="muted">Auto-release in</span>
        <span className="num" style={{ fontWeight: 600 }}>
          41h 12m
        </span>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main>
      <section className="container hero">
        <div className="grid-2" style={{ alignItems: "center", gap: 40 }}>
          <div className="g-fade">
            <span className="eyebrow">USDC escrow on Base</span>
            <h1 className="hero-title">Get paid. Or get your money back.</h1>
            <p className="hero-sub">
              Midman holds USDC in an on-chain escrow until the deal is done. Both sides sign the same terms, the seller
              delivers, the buyer releases, and an independent panel decides if something goes wrong.
            </p>
            <div className="row">
              <ButtonLink href="/deals/new" size="lg">
                Start a deal <Icon name="arrow-right" size={16} />
              </ButtonLink>
              <ButtonLink href="#how-it-works" size="lg" variant="secondary">
                How it works
              </ButtonLink>
            </div>
            <div className="row small muted" style={{ marginTop: 20, gap: 18 }}>
              <span className="row" style={{ gap: 6 }}>
                <Icon name="check" size={15} /> From 5.00 USDC
              </span>
              <span className="row" style={{ gap: 6 }}>
                <Icon name="check" size={15} /> Fees from 0.25%
              </span>
              <span className="row" style={{ gap: 6 }}>
                <Icon name="check" size={15} /> No account, just your wallet
              </span>
            </div>
          </div>
          <div className="g-fade">
            <DealPreview />
          </div>
        </div>
      </section>

      <section id="how-it-works" className="container" style={{ padding: "40px 16px" }}>
        <span className="eyebrow">How it works</span>
        <h2 style={{ fontSize: "1.6rem", margin: "6px 0 24px" }}>Five steps from handshake to payout</h2>
        <div className="grid-2" style={{ alignItems: "start" }}>
          <ol className="timeline">
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className="num-badge">{i + 1}</span>
                <div>
                  <h3 style={{ marginTop: 5 }}>{step.title}</h3>
                  <p className="muted">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
            {PROTECTIONS.map((p) => (
              <div key={p.title} className="card g-card">
                <span className="feature-icon">
                  <Icon name={p.icon} />
                </span>
                <h3>{p.title}</h3>
                <p className="small muted" style={{ margin: 0 }}>
                  {p.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="fees" className="container" style={{ padding: "40px 16px" }}>
        <span className="eyebrow">Fees</span>
        <h2 style={{ fontSize: "1.6rem", margin: "6px 0 8px" }}>Pay for the time your money is protected</h2>
        <p className="muted" style={{ maxWidth: "60ch", marginBottom: 24 }}>
          The fee depends on the deal&apos;s delivery plus inspection time, with a 0.50 USDC minimum. It is only earned on
          the part of the price that reaches the seller: refunds cost nothing.
        </p>
        <div className="grid-2" style={{ alignItems: "start" }}>
          <Card title="Fee tiers">
            <table>
              <thead>
                <tr>
                  <th>Delivery + inspection</th>
                  <th style={{ textAlign: "right" }}>Fee</th>
                </tr>
              </thead>
              <tbody>
                {FEE_TIERS.map((tier) => (
                  <tr key={tier.window}>
                    <td>{tier.window}</td>
                    <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>
                      {tier.rate}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted" style={{ marginTop: 12 }}>
              Minimum deal 5.00 USDC · minimum fee 0.50 USDC · buyer pays by default, or split 50/50, or seller pays.
            </p>
          </Card>
          <FeeCalculator />
        </div>
      </section>

      <section id="faq" className="container container-narrow" style={{ padding: "40px 16px" }}>
        <span className="eyebrow">FAQ</span>
        <h2 style={{ fontSize: "1.6rem", margin: "6px 0 12px" }}>Questions people ask first</h2>
        {FAQ.map((item) => (
          <details key={item.q} className="faq">
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
        <div className="card" style={{ marginTop: 32, textAlign: "center" }}>
          <h2>Ready when you are</h2>
          <p className="muted">Draft a deal in a minute and send the invite link to the other side.</p>
          <ButtonLink href="/deals/new" size="lg">
            Start a deal
          </ButtonLink>
        </div>
      </section>
    </main>
  );
}
