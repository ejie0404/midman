"use client";

import { useState } from "react";
import {
  button,
  card,
  ctaPanel,
  featureCard,
  featureIcon,
  featureText,
  featureTitle,
  gradientText,
  grid,
  hero,
  heroBadge,
  heroSub,
  hint,
  input,
  page,
  section,
  sectionSub,
  sectionTitle,
  statChip,
  statRow,
  step,
  stepNum,
  stepText,
  stepTitle,
  steps,
} from "./components/styles";

const STATS = [
  "Min principal · 5.00 USDC",
  "Fee from · 0.50 USDC",
  "Inspection · 1h–30d",
  "Escape window · 60 days",
  "Arbitration · 2-of-3",
];

const FEATURES: {
  title: string;
  text: string;
  icon: React.ReactNode;
}[] = [
  {
    title: "Exact funding",
    text: "Collects precisely principal plus the buyer fee share. No partial funding, no rounding surprises.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: "Dual signatures",
    text: "Both parties sign the same cryptographic terms before anything moves on-chain.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    ),
  },
  {
    title: "One-freeze disputes",
    text: "A single free buyer freeze per deal — no bond required to stop the settlement clock.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    ),
  },
  {
    title: "Escalation bonds",
    text: "Contested escalations post real collateral — 5 USDC minimum per actively contesting party.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z" />
      </svg>
    ),
  },
  {
    title: "Permissionless claims",
    text: "Anyone may sponsor a fixed-recipient claim. Payouts are pull-based, never push-based.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
        <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
      </svg>
    ),
  },
  {
    title: "Catastrophic escape",
    text: "Fixed 60-day path from first dispute: 50/50 principal, zero fees, bonds refunded.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    ),
  },
];

const FLOW: { title: string; text: string }[] = [
  { title: "Draft", text: "The creator drafts exact terms off-chain — principal, durations, category, fee split." },
  { title: "Invite & accept", text: "A private invite link goes to the counterparty, who reviews and countersigns the same terms." },
  { title: "Fund atomically", text: "The buyer funds principal plus fee share in one transaction. No partial funding exists." },
  { title: "Deliver & inspect", text: "The seller declares delivery once. The buyer inspects within the category minimum window." },
  { title: "Release or dispute", text: "Release settles to fixed recipients — or freeze once, escalate with a bond, and let the panel rule." },
];

const RULES = [
  "Asset: native USDC on Base. Minimum principal 5.00 USDC; minimum quoted fee 0.50 USDC.",
  "Funding collects exactly principal + buyer fee share — no partial funding.",
  "One free buyer dispute freeze per deal; escalation needs a real 5 USDC-minimum bond.",
  "Catastrophic escape: fixed 60 days from first dispute, properly escalated deals only, 50/50 principal, zero fees.",
  "Pending transactions are shown separately from included chain state; inclusion is the only truth.",
];

function Check() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none", marginTop: 3 }}
      aria-hidden
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export default function Home() {
  const [lookup, setLookup] = useState("");
  const trimmed = lookup.trim();
  const valid = /^(draft_[A-Za-z0-9_-]+|0x[0-9a-fA-F]{64})$/.test(trimmed);
  const open = () => {
    if (valid) window.location.href = `/deals/${encodeURIComponent(trimmed)}`;
  };
  const lookupHint =
    trimmed.length === 0
      ? "Enter a draft ID (draft_…) or a deal ID (0x… bytes32)."
      : valid
        ? "Valid — open the dashboard to view live state."
        : "Expected draft_… or a 0x-prefixed 32-byte deal ID.";

  return (
    <main style={page}>
      {/* Hero */}
      <section style={hero} className="g-fade">
        <span style={heroBadge}>
          <span
            className="g-dot"
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--accent)",
              display: "inline-block",
            }}
          />
          Private-link escrow · Base · native USDC
        </span>
        <h1 style={{ marginTop: 22 }}>
          Value moves when both sides agree.{" "}
          <span style={gradientText}>Nothing moves before.</span>
        </h1>
        <p style={heroSub}>
          Midman is an off-chain draft, an on-chain vault, and a permissionless
          settlement path — bound together by dual signatures and fixed recipients.
        </p>
        <div style={{ marginTop: 28 }}>
          <a href="/deals/new" style={{ ...button, textDecoration: "none", display: "inline-block" }}>
            Create a deal
          </a>
          <a
            href="#lookup"
            style={{ ...button, ...{ background: "transparent", color: "var(--accent)" }, textDecoration: "none", display: "inline-block" }}
          >
            Track a deal
          </a>
        </div>
        <div style={statRow}>
          {STATS.map((s) => (
            <span key={s} style={statChip}>
              {s}
            </span>
          ))}
        </div>
      </section>

      {/* Lookup */}
      <section id="lookup" style={section} className="g-fade">
        <div style={{ ...card, padding: 24 }}>
          <h2>Look up a deal</h2>
          <label style={{ display: "block", fontWeight: 600, margin: "12px 0 4px" }} htmlFor="lookup">
            Deal or draft ID
          </label>
          <input
            id="lookup"
            style={input}
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") open();
            }}
            placeholder="draft_… or 0x…"
            spellCheck={false}
            autoComplete="off"
          />
          <p style={{ ...hint, color: valid ? "var(--accent-2)" : undefined }}>{lookupHint}</p>
          <button type="button" style={button} disabled={!valid} onClick={open}>
            Open dashboard
          </button>
        </div>
      </section>

      {/* Features */}
      <section style={section} className="g-fade">
        <h2 style={sectionTitle}>Built for private exchange</h2>
        <p style={sectionSub}>
          Every rule is enforced by the contract, not by trust in the counterparty
          or the interface.
        </p>
        <div style={grid}>
          {FEATURES.map((f, i) => (
            <div key={f.title} style={{ ...featureCard, animationDelay: `${i * 0.05}s` }} className="g-fade g-card">
              <div style={featureIcon}>{f.icon}</div>
              <h3 style={featureTitle}>{f.title}</h3>
              <p style={featureText}>{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Flow */}
      <section style={section} className="g-fade">
        <h2 style={sectionTitle}>How a deal moves</h2>
        <p style={sectionSub}>Five stages, one cryptographic thread from draft to settlement.</p>
        <ol style={steps}>
          {FLOW.map((s, i) => (
            <li key={s.title} style={step}>
              <span style={stepNum}>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3 style={stepTitle}>{s.title}</h3>
                <p style={stepText}>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Rules */}
      <section style={section} className="g-fade">
        <h2 style={sectionTitle}>Protocol rules, verbatim</h2>
        <p style={sectionSub}>The guarantees that hold even if this interface disappears.</p>
        <div style={{ ...card, padding: 24 }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
            {RULES.map((r) => (
              <li key={r} style={{ display: "flex", gap: 10, fontSize: 14 }}>
                <Check />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* CTA */}
      <section style={section} className="g-fade">
        <div style={ctaPanel}>
          <h2 style={{ marginBottom: 8 }}>Ready when both sides are.</h2>
          <p style={{ color: "var(--muted)", maxWidth: 460, margin: "0 auto 18px" }}>
            Draft a deal, share the private link, and let signatures do the rest.
          </p>
          <a href="/deals/new" style={{ ...button, textDecoration: "none", display: "inline-block" }}>
            Create a deal
          </a>
        </div>
      </section>
    </main>
  );
}
