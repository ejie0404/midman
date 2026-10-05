"use client";

// Header wallet button — EIP-1193 connect/disconnect with live
// account + chain tracking (MetaMask, Coinbase Wallet, Rabby, Brave…).
// Wallet connection alone is NOT authentication; deal pages run the
// SIWE challenge flow separately (SessionBadge / useSession).

import { useState } from "react";
import { connectWallet, disconnectWallet, useWalletLifecycle } from "../../lib/wallet";
import { walletBtn, walletError } from "./styles";

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function WalletButton() {
  const { address, chainId } = useWalletLifecycle();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expected = Number(process.env["NEXT_PUBLIC_CHAIN_ID"] ?? "8453");
  const onExpectedChain = chainId !== null && chainId === expected;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await connectWallet();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!address) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy}
          style={walletBtn}
          title="Connect a browser wallet (MetaMask, Coinbase Wallet, Rabby…)"
        >
          {busy ? "Connecting…" : "Connect wallet"}
        </button>
        {error ? (
          <span style={walletError} title={error}>
            {" "}
            ⚠
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => disconnectWallet()}
      style={walletBtn}
      title={`${address} — connected to chain ${chainId ?? "unknown"}. Click to disconnect.`}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: onExpectedChain ? "var(--accent)" : "var(--warn)",
          display: "inline-block",
          flex: "none",
        }}
        title={
          onExpectedChain
            ? `On expected chain ${expected}`
            : `Wrong network: wallet is on chain ${chainId ?? "?"}, expected ${expected}. Switch in your wallet.`
        }
      />
      {short(address)}
    </button>
  );
}
