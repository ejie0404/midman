"use client";

// Shared wallet session. One provider (app/layout.tsx) owns the session so the
// header and every page agree on who is signed in. Wallet connection alone is
// NOT authentication — `connect` performs the full SIWE challenge / sign /
// verify flow (lib/session.ts) before any private data is requested.

import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getAccount, getWalletClient } from "../../lib/wallet";
import { getSession, isUnauthorized, logout as endSession, signIn, type AuthSession } from "../../lib/session";

export interface UseSession {
  readonly session: AuthSession | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly connect: () => Promise<AuthSession>;
  readonly disconnect: () => Promise<void>;
  /** True when an error is a 401 (prompt re-auth). */
  readonly isUnauthorized: typeof isUnauthorized;
}

function useSessionState(): UseSession {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const state = await getSession();
      setSession(state.authenticated ? state : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setError(null);
    try {
      const address = await getAccount();
      const wallet = getWalletClient();
      const established = await signIn({
        address,
        signMessage: (message) => wallet.signMessage({ account: address, message }),
      });
      setSession(established);
      return established;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  const disconnect = useCallback(async () => {
    await endSession();
    setSession(null);
  }, []);

  return { session, loading, error, refresh, connect, disconnect, isUnauthorized };
}

const SessionContext = createContext<UseSession | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const value = useSessionState();
  return createElement(SessionContext.Provider, { value }, children);
}

/** The shared session (SessionProvider wraps every page in app/layout.tsx). */
export function useSession(): UseSession {
  const shared = useContext(SessionContext);
  if (!shared) throw new Error("useSession must be used inside <SessionProvider>");
  return shared;
}
