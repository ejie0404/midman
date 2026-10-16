"use client";

// Shared wallet session. One provider (app/layout.tsx) owns the session so the
// header and every page agree on who is signed in. Wallet connection alone is
// NOT authentication — `connect` performs the full SIWE challenge / sign /
// verify flow (lib/session.ts) before any private data is requested.

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getAccount, getWalletClient } from "../../lib/wallet";
import { getSession, isUnauthorized, logout as endSession, signIn, type AuthSession } from "../../lib/session";
import { canResolveProvider, clearWalletSelection, hasSelectedWallet, selectWallet } from "../../lib/providers";
import WalletPicker from "./WalletPicker";

export interface UseSession {
  readonly session: AuthSession | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly connect: () => Promise<AuthSession>;
  readonly disconnect: () => Promise<void>;
  /** Make sure a wallet is selected before signing (opens the picker if needed). */
  readonly ensureWallet: () => Promise<void>;
  /** True when an error is a 401 (prompt re-auth). */
  readonly isUnauthorized: typeof isUnauthorized;
}

function useSessionState(): UseSession & {
  pickerOpen: boolean;
  onPick: (id: string) => Promise<void>;
  onClosePicker: () => void;
} {
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

  // Wallet choice: the first sign-in opens the picker; the promise resolves
  // once the user picks (and their wallet is selected) or rejects on cancel.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

  const chooseWallet = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.current = { resolve, reject };
        setPickerOpen(true);
      }),
    [],
  );

  const onPick = useCallback(async (id: string) => {
    await selectWallet(id);
    setPickerOpen(false);
    pending.current?.resolve();
    pending.current = null;
  }, []);

  const onClosePicker = useCallback(() => {
    setPickerOpen(false);
    pending.current?.reject(new Error("No wallet selected"));
    pending.current = null;
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    try {
      if (!hasSelectedWallet()) await chooseWallet();
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

  const ensureWallet = useCallback(async () => {
    if (!canResolveProvider()) await chooseWallet();
  }, [chooseWallet]);

  const disconnect = useCallback(async () => {
    await endSession();
    await clearWalletSelection();
    setSession(null);
  }, []);

  return { session, loading, error, refresh, connect, disconnect, ensureWallet, isUnauthorized, pickerOpen, onPick, onClosePicker };
}

const SessionContext = createContext<UseSession | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { pickerOpen, onPick, onClosePicker, ...value } = useSessionState();
  return createElement(
    SessionContext.Provider,
    { value },
    children,
    createElement(WalletPicker, { open: pickerOpen, onPick, onClose: onClosePicker }),
  );
}

/** The shared session (SessionProvider wraps every page in app/layout.tsx). */
export function useSession(): UseSession {
  const shared = useContext(SessionContext);
  if (!shared) throw new Error("useSession must be used inside <SessionProvider>");
  return shared;
}
