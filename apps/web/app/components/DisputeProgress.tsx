"use client";

import { useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  disputeStages,
  exhaustedRightsNote,
  fetchEscalation,
  type DisputeStageState,
  type EscalationInfo,
} from "../../lib/review";
import Countdown from "./Countdown";
import { card, mono, warning } from "./styles";

function stateLabel(state: DisputeStageState): string {
  switch (state) {
    case "done":
      return "done ✓";
    case "active":
      return "active";
    case "lapsed":
      return "LAPSED ✗";
    case "unknown":
      return "unknown (endpoint pending)";
    case "upcoming":
      return "upcoming";
  }
}

/**
 * Dispute stage timeline: negotiation 24h → escalation window → evidence
 * cutoff → primary 7d → fallback 7d → ruling delay → escape 60d. Each stage
 * shows a live countdown or its done state from unix timestamps. Purely
 * informational: it never submits transactions. Escalation bounds are fetched
 * read-only (unsigned) and tolerated when the endpoint is not deployed yet.
 */
export default function DisputeProgress({
  dealId,
  fundedAt,
  deliveredAt,
  disputeOpenedAt,
  escalatedAt,
  disputeUsed,
}: {
  dealId: string;
  fundedAt?: string | number | undefined;
  deliveredAt?: string | number | undefined;
  disputeOpenedAt?: string | number | undefined;
  escalatedAt?: string | number | undefined;
  disputeUsed?: boolean | undefined;
}) {
  const [escalation, setEscalation] = useState<EscalationInfo | null>(null);
  const [escalationError, setEscalationError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1_000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchEscalation(dealId)
      .then((info) => {
        if (!cancelled) setEscalation(info);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setEscalationError(e instanceof ApiError ? `escalation endpoint: ${e.message}` : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  const num = (value: string | number | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    return Number.isInteger(n) ? n : undefined;
  };

  const stages = disputeStages(
    {
      fundedAtUnix: num(fundedAt),
      deliveredAtUnix: num(deliveredAt),
      disputeOpenedAtUnix: num(disputeOpenedAt),
      escalatedAtUnix: num(escalatedAt),
      negotiationEndUnix: escalation && escalation.negotiationEndUnix > 0 ? escalation.negotiationEndUnix : undefined,
      escalationEndUnix: escalation && escalation.escalationEndUnix > 0 ? escalation.escalationEndUnix : undefined,
      disputeUsed,
    },
    now,
  );
  const exhausted = exhaustedRightsNote(
    {
      disputeOpenedAtUnix: num(disputeOpenedAt),
      escalatedAtUnix: num(escalatedAt),
      negotiationEndUnix: escalation && escalation.negotiationEndUnix > 0 ? escalation.negotiationEndUnix : undefined,
      escalationEndUnix: escalation && escalation.escalationEndUnix > 0 ? escalation.escalationEndUnix : undefined,
      disputeUsed,
    },
    now,
  );
  const escalationStage = stages.find((s) => s.id === "escalation");

  return (
    <div style={card}>
      <h2>Dispute progress</h2>
      <ol style={{ fontSize: 14 }}>
        {stages.map((stage) => (
          <li key={stage.id} style={{ marginBottom: 6 }}>
            <strong>
              {stage.label} ({stage.window})
            </strong>{" "}
            — {stateLabel(stage.state)}
            {stage.deadlineUnix !== null && (stage.state === "active" || stage.state === "upcoming") ? (
              <span>
                {" "}
                (<Countdown targetUnix={stage.deadlineUnix} /> left)
              </span>
            ) : null}
            <div style={{ fontSize: 13 }}>{stage.detail}</div>
          </li>
        ))}
      </ol>
      {escalation && (escalation.claimantBondUnits !== "0" || escalation.respondentBondUnits !== "0") ? (
        <p style={{ fontSize: 13 }}>
          Bonds — claimant <span style={mono}>{escalation.claimantBondUnits}</span> · respondent{" "}
          <span style={mono}>{escalation.respondentBondUnits}</span>
          {escalation.estimated ? " (estimated, not yet posted)" : " (posted)"}
        </p>
      ) : null}
      {escalationError ? <p style={{ fontSize: 13 }}>Escalation window unknown ({escalationError}).</p> : null}
      {exhausted ? (
        <div style={warning}>
          <strong>Exhausted rights.</strong> {exhausted}
        </div>
      ) : null}
      {escalationStage?.state === "lapsed" ? (
        <div style={warning}>
          <strong>Missing escalation consequences.</strong> No escalation bond was posted inside the window, so the
          dispute lapsed: the deal resumes the normal timeout path and the consumed free freeze is not refunded. Only
          mutual settlement or the 60-day catastrophic escape (properly escalated deals only) remain.
        </div>
      ) : null}
      <div style={{ fontSize: 13, marginTop: 8 }}>
        <strong>Catastrophic escape.</strong> 60 days after the first dispute, properly escalated deals only: principal
        splits 50/50 with the odd unit to the buyer and zero fees. Inspection lapses, un-escalated disputes, and
        unilateral release/refund paths never trigger it.
      </div>
    </div>
  );
}
