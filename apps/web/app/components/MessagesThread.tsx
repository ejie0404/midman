"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import type { RequestSigner } from "../../lib/requestAuth";
import {
  MAX_MESSAGE_LEN,
  NO_CREDENTIALS_MESSAGE_COPY,
  REVIEWER_PENDING_COPY,
  fetchMessages,
  isAccessDenied,
  isEndpointMissing,
  postMessage,
  prescreenSecrets,
  type ChatMessage,
} from "../../lib/evidence";
import { connectEvidenceAuth } from "./evidenceAuth";
import { button, card, error, mono, secondaryButton, warning } from "./styles";

type LoadStatus = "connect" | "loading" | "ready" | "missing" | "denied" | "error";

export default function MessagesThread({ dealId }: { dealId: string }) {
  const [status, setStatus] = useState<LoadStatus>("connect");
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const secretHit = prescreenSecrets(draft);
  const overLimit = draft.length > MAX_MESSAGE_LEN;

  const load = useCallback(async () => {
    setLoadError(null);
    let auth: RequestSigner;
    try {
      auth = await connectEvidenceAuth();
    } catch {
      setStatus("connect");
      return;
    }
    setStatus("loading");
    try {
      setMessages(await fetchMessages(dealId, auth));
      setStatus("ready");
    } catch (e) {
      if (isEndpointMissing(e)) {
        setStatus("missing");
      } else if (isAccessDenied(e)) {
        setStatus("denied");
      } else {
        setStatus("error");
        setLoadError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      }
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onPost(): Promise<void> {
    setPosting(true);
    setPostError(null);
    try {
      const auth = await connectEvidenceAuth();
      const posted = await postMessage(dealId, draft, auth);
      setMessages((prev) => [...prev, posted]);
      setDraft("");
    } catch (e) {
      if (isAccessDenied(e)) {
        setPostError(REVIEWER_PENDING_COPY);
      } else {
        setPostError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPosting(false);
    }
  }

  return (
    <div style={card}>
      <h2>Messages</h2>
      <div style={warning}>{NO_CREDENTIALS_MESSAGE_COPY}</div>

      {status === "connect" ? (
        <div style={warning}>
          Connect your deal wallet to load messages (requests are signed with your wallet).
          <div>
            <button type="button" style={button} onClick={() => void load()}>
              Connect + load messages
            </button>
          </div>
        </div>
      ) : null}
      {status === "loading" ? <p>Loading messages…</p> : null}
      {status === "missing" ? (
        <div style={warning}>Message endpoints are not deployed yet (404) — the thread below is unavailable.</div>
      ) : null}
      {status === "denied" ? <div style={warning}>{REVIEWER_PENDING_COPY}</div> : null}
      {status === "error" ? <div style={error}>{loadError ?? "Failed to load messages."}</div> : null}

      {status === "ready" ? (
        <div>
          {messages.length === 0 ? (
            <p style={{ fontSize: 14 }}>No messages yet.</p>
          ) : (
            <ul>
              {messages.map((message) => (
                <li key={message.seq} style={{ marginBottom: 6 }}>
                  <span style={mono}>#{message.seq} {message.author}</span>{" "}
                  <span style={{ fontSize: 13 }}>{message.at}</span>
                  <br />
                  {message.text}
                </li>
              ))}
            </ul>
          )}
          <button type="button" style={secondaryButton} onClick={() => void load()}>
            Refresh
          </button>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <label style={{ display: "block", fontSize: 14 }}>
          New message ({draft.length}/{MAX_MESSAGE_LEN}):
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            style={{ display: "block", width: "100%", padding: 8, boxSizing: "border-box" }}
          />
        </label>
        {secretHit.hit ? (
          <div style={warning}>
            Warning: this looks like it may contain a credential ({secretHit.matched.join(", ")}). Remove secrets
            before posting.
          </div>
        ) : null}
        {overLimit ? <div style={error}>Message exceeds the {MAX_MESSAGE_LEN}-character limit.</div> : null}
        <button
          type="button"
          style={button}
          disabled={posting || draft.trim() === "" || overLimit}
          onClick={() => void onPost()}
        >
          {posting ? "Posting…" : "Sign + post"}
        </button>
        {postError ? <div style={error}>{postError}</div> : null}
      </div>
    </div>
  );
}
