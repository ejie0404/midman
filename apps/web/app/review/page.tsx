"use client";

import { useCallback, useState } from "react";
import type { RequestSigner } from "../../lib/requestAuth";
import {
  REVIEW_MISSING_COPY,
  REVIEWER_DENIED_COPY,
  REVIEWER_SIGNING_COPY,
  fetchReviewQueue,
  isAssignedToMe,
  isReviewMissing,
  isReviewerDenied,
  type ReviewQueueItem,
} from "../../lib/review";
import { ApiError } from "../../lib/api";
import { connectEvidenceAuth } from "../components/evidenceAuth";
import Countdown from "../components/Countdown";
import { button, card, error, mono, nav, ok, page, secondaryButton, warning } from "../components/styles";

type LoadStatus = "connect" | "loading" | "ready" | "missing" | "denied" | "error";

export default function ReviewConsolePage() {
  const [status, setStatus] = useState<LoadStatus>("connect");
  const [auth, setAuth] = useState<RequestSigner | null>(null);
  const [queue, setQueue] = useState<readonly ReviewQueueItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (signer: RequestSigner) => {
    setStatus("loading");
    setLoadError(null);
    try {
      const items = await fetchReviewQueue(signer);
      setQueue(items);
      setStatus("ready");
    } catch (e) {
      if (isReviewMissing(e)) {
        setStatus("missing");
      } else if (isReviewerDenied(e)) {
        setStatus("denied");
      } else {
        setStatus("error");
        setLoadError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  async function connect() {
    setLoadError(null);
    try {
      const signer = await connectEvidenceAuth();
      setAuth(signer);
      await load(signer);
    } catch (e) {
      setStatus("error");
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  const mine = auth ? queue.filter((item) => isAssignedToMe(item, auth.address)) : [];

  return (
    <main style={page}>
      <h1>Reviewer console</h1>
      <p style={nav}>
        <a href="/">← Home</a>
      </p>

      <div style={warning}>
        <strong>Drill mode.</strong> This console is a rehearsal surface: connect a reviewer wallet, inspect the queue,
        and practice drafting, signing, and queueing rulings. Signatures are real wallet signatures, but nothing moves
        on-chain until you explicitly choose relay or direct submit — and the server never sees your keys.
      </div>

      <div style={card}>
        <h2>Reviewer wallet</h2>
        <p style={{ fontSize: 14 }}>{REVIEWER_SIGNING_COPY}</p>
        {auth ? (
          <p>
            Connected as <span style={mono}>{auth.address}</span> · {mine.length} case(s) assigned to you.
          </p>
        ) : (
          <button type="button" style={button} onClick={() => void connect()}>
            Connect reviewer wallet
          </button>
        )}
        {auth ? (
          <button type="button" style={secondaryButton} onClick={() => void load(auth)}>
            Refresh queue
          </button>
        ) : null}
      </div>

      {status === "missing" ? <div style={warning}>{REVIEW_MISSING_COPY}</div> : null}
      {status === "denied" ? <div style={warning}>{REVIEWER_DENIED_COPY}</div> : null}
      {status === "error" && loadError ? <div style={error}>{loadError}</div> : null}
      {status === "loading" ? <p>Loading review queue…</p> : null}

      {status === "ready" ? (
        <div style={card}>
          <h2>Queue ({queue.length})</h2>
          {queue.length === 0 ? (
            <p style={{ fontSize: 14 }}>Queue is empty — no deals are awaiting review.</p>
          ) : (
            <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Deal</th>
                  <th style={{ textAlign: "left" }}>Phase</th>
                  <th style={{ textAlign: "left" }}>Stage</th>
                  <th style={{ textAlign: "left" }}>Deadline</th>
                  <th style={{ textAlign: "left" }}>Panel</th>
                  <th style={{ textAlign: "left" }}>Mine</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr key={item.dealId}>
                    <td style={mono}>
                      <a href={`/review/${item.dealId}`}>{item.dealId.slice(0, 12)}…</a>
                    </td>
                    <td>
                      <span style={{ border: "1px solid #999", borderRadius: 4, padding: "1px 6px" }}>
                        {item.phase || "—"}
                      </span>
                    </td>
                    <td>{item.stage || "—"}</td>
                    <td>
                      {item.deadlineUnix > 0 ? <Countdown targetUnix={item.deadlineUnix} /> : "—"}
                    </td>
                    <td>{item.panel}</td>
                    <td>{auth && isAssignedToMe(item, auth.address) ? "assigned to me ✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {auth ? (
            <div style={ok}>
              {mine.length} of {queue.length} visible cases are assigned to <span style={mono}>{auth.address}</span>.
              Only open cases assigned to you.
            </div>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
