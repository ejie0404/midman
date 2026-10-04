"use client";

// Session lifecycle hook for pages that need private data. Wallet connection
// alone is NOT authentication — `connect` performs the full SIWE challenge /
// sign / verify flow (lib/session.ts) before any private data is requested.

import { useCallback, useEffect, useState } from "react";
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

export function useSession(): UseSession {
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
