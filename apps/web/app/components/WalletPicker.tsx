"use client";

// Wallet chooser: installed browser wallets (EIP-6963), Coinbase Wallet
// (Smart Wallet with passkeys, no extension needed) and WalletConnect for
// mobile wallets. Rendered by SessionProvider when sign-in needs a wallet.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listWalletOptions, startDiscovery, subscribeWallets, type WalletOption } from "../../lib/providers";
import { Button, Icon } from "./ui";

const HELP: Record<WalletOption["kind"], string> = {
  injected: "Installed in this browser",
  coinbase: "Smart Wallet with a passkey, or the Coinbase app",
  walletconnect: "Scan with a mobile wallet",
};

let snapshot: WalletOption[] = [];
let snapshotKey = "";

function getSnapshot(): WalletOption[] {
  const next = listWalletOptions();
  const key = next.map((o) => o.id).join("|");
  if (key !== snapshotKey) {
    snapshotKey = key;
    snapshot = next;
  }
  return snapshot;
}

const empty: WalletOption[] = [];

export default function WalletPicker({
  open,
  onPick,
  onClose,
}: {
  open: boolean;
  onPick: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const options = useSyncExternalStore(subscribeWallets, getSnapshot, () => empty);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    startDiscovery();
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      setError(null);
      el.showModal();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="wallet-picker-title"
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: 0,
        width: "min(420px, calc(100vw - 32px))",
        background: "var(--surface)",
        color: "var(--text)",
        boxShadow: "var(--shadow)",
      }}
    >
      <div style={{ padding: 20 }}>
        <div className="row spread" style={{ marginBottom: 4 }}>
          <h2 id="wallet-picker-title" style={{ margin: 0 }}>
            Choose a wallet
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="small muted">You&apos;ll sign a login message next. It authorizes no funds.</p>
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="btn btn-secondary btn-block"
              style={{ justifyContent: "flex-start", minHeight: 56, gap: 12, textAlign: "left" }}
              disabled={busy !== null}
              onClick={() => {
                setBusy(option.id);
                setError(null);
                onPick(option.id)
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(null));
              }}
            >
              {option.icon ? (
                <img src={option.icon} alt="" width={28} height={28} style={{ borderRadius: 6 }} />
              ) : (
                <span className="feature-icon" style={{ width: 28, height: 28, margin: 0 }}>
                  <Icon name="wallet" size={16} />
                </span>
              )}
              <span>
                <span style={{ display: "block", fontWeight: 600 }}>{option.name}</span>
                <span className="small muted">{busy === option.id ? "Waiting for your wallet…" : HELP[option.kind]}</span>
              </span>
            </button>
          ))}
        </div>
        {error ? (
          <p className="field-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </p>
        ) : null}
        <p className="small muted" style={{ marginTop: 16, marginBottom: 0 }}>
          New to crypto wallets? Coinbase Wallet lets you create one with a passkey in under a minute.
        </p>
        <div style={{ marginTop: 12 }}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </dialog>
  );
}
