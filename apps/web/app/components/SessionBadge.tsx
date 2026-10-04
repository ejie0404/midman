"use client";

// Compact wallet-session badge: shows the signed-in wallet + expiry, offers
// sign-in (challenge -> personal_sign -> verify) and logout. Wallet connection
// alone never authenticates. Used on pages that need private data.

import { useSession } from "./useSession";
import { button, card, error, mono, secondaryButton, warning } from "./styles";

export default function SessionBadge({ title = "Wallet session" }: { title?: string }) {
  const { session, loading, error: sessionError, connect, disconnect, refresh } = useSession();

  return (
    <div style={card}>
      <h2>{title}</h2>
      {loading ? <p style={{ fontSize: 13 }}>Checking session…</p> : null}
      {sessionError ? <div style={error}>{sessionError}</div> : null}
      {session ? (
        <div>
          <p style={{ fontSize: 14 }}>
            Signed in as <span style={mono}>{session.wallet}</span>
            {` · expires ${new Date(session.expiresAt * 1_000).toISOString()}`}
          </p>
          <button type="button" style={secondaryButton} onClick={() => void refresh()}>
            Refresh session
          </button>
          <button type="button" style={secondaryButton} onClick={() => void disconnect()}>
            Sign out
          </button>
        </div>
      ) : (
        <div>
          <div style={warning}>
            Wallet connection alone is not authentication. Sign a one-time login message (no funds authorized) to
            open a session for private deal data.
          </div>
          <button type="button" style={button} onClick={() => void connect().catch(() => undefined)}>
            Connect & sign in
          </button>
        </div>
      )}
    </div>
  );
}
