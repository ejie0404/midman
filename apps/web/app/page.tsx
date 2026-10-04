"use client";

import { useState } from "react";
import { page, card, input, button, label, nav } from "./components/styles";

// Phase 3 shell facts preserved: minimums state, and clicks never move funds.
export default function Home() {
  const [lookup, setLookup] = useState("");

  return (
    <main style={page}>
      <h1>Midman Escrow — private-link USDC on Base</h1>
      <ul>
        <li>Asset: native USDC on Base. Minimum principal 5.00 USDC. Minimum quoted fee 0.50 USDC.</li>
        <li>Funding collects exactly P + buyer fee share. No partial funding.</li>
        <li>One free buyer dispute freeze per deal; escalation needs a real 5 USDC-minimum bond.</li>
        <li>Catastrophic escape: fixed 60 days from first dispute, properly escalated deals only, 50/50 principal, zero fees.</li>
      </ul>
      <p>Pending transactions are shown separately from included chain state; inclusion is the only truth.</p>

      <div style={card}>
        <h2>Start a new deal</h2>
        <p>Create an off-chain draft, share the private invite link, then review and sign.</p>
        <a href="/deals/new" style={{ ...button, textDecoration: "none", display: "inline-block" }}>
          Create deal
        </a>
      </div>

      <div style={card}>
        <h2>Look up a deal</h2>
        <p>Enter a draft ID (draft_…) or a deal ID (0x… bytes32).</p>
        <label style={label} htmlFor="lookup">
          Deal or draft ID
        </label>
        <input
          id="lookup"
          style={input}
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
          placeholder="draft_… or 0x…"
        />
        <a
          href={lookup.trim() ? `/deals/${encodeURIComponent(lookup.trim())}` : "#"}
          style={{ ...button, textDecoration: "none", display: "inline-block" }}
        >
          Open dashboard
        </a>
      </div>

      <p style={nav}>
        <a href="/deals/new">New deal</a>
      </p>
    </main>
  );
}
