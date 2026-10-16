// Wallet provider selection. Every signing/transaction helper (lib/wallet.ts,
// lib/connectivity.ts) talks to ONE EIP-1193 provider: whichever the user
// picked. Sources:
//   - Browser wallets announced via EIP-6963 (MetaMask, Rabby, Coinbase
//     extension, Brave, ...), so several installed wallets no longer fight
//     over window.ethereum;
//   - WalletConnect (mobile wallets via QR / deep link), when
//     NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set;
//   - Coinbase Wallet SDK (Coinbase Smart Wallet with passkeys, or the app);
//   - window.ethereum as a last-resort legacy fallback.
// The WalletConnect and Coinbase SDKs are loaded on demand so they never
// weigh on pages where nobody connects.
//
// Erasable TypeScript only (Node 24 imports it directly in tests).

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
  disconnect?(): Promise<void>;
}

export interface WalletOption {
  /** Stable id: EIP-6963 rdns, or "walletconnect" / "coinbase" / "injected". */
  readonly id: string;
  readonly name: string;
  /** data: URI icon from EIP-6963, when announced. */
  readonly icon: string | null;
  readonly kind: "injected" | "walletconnect" | "coinbase";
}

interface Announced {
  readonly info: { uuid: string; name: string; icon: string; rdns: string };
  readonly provider: Eip1193Provider;
}

const STORAGE_KEY = "midman-wallet";
const announced = new Map<string, Announced>();
const listeners = new Set<() => void>();
let active: { id: string; provider: Eip1193Provider } | null = null;
let discoveryStarted = false;

function env(name: string): string {
  return (typeof process !== "undefined" && process.env[name]) || "";
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Start EIP-6963 discovery (idempotent; browser only). */
export function startDiscovery(): void {
  if (discoveryStarted || typeof window === "undefined") return;
  discoveryStarted = true;
  window.addEventListener("eip6963:announceProvider", (event: Event) => {
    const detail = (event as CustomEvent<Announced>).detail;
    if (!detail || !detail.info || typeof detail.provider?.request !== "function") return;
    announced.set(detail.info.rdns || detail.info.uuid, detail);
    notify();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** Subscribe to the wallet list changing (new announcements). */
export function subscribeWallets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Wallets the user can pick right now. */
export function listWalletOptions(): WalletOption[] {
  const options: WalletOption[] = [...announced.entries()].map(([id, a]) => ({
    id,
    name: a.info.name,
    icon: a.info.icon || null,
    kind: "injected",
  }));
  const hasCoinbaseExtension = options.some((o) => o.id === "com.coinbase.wallet");
  if (options.length === 0 && typeof window !== "undefined" && (window as { ethereum?: unknown }).ethereum) {
    options.push({ id: "injected", name: "Browser wallet", icon: null, kind: "injected" });
  }
  if (!hasCoinbaseExtension) options.push({ id: "coinbase", name: "Coinbase Wallet", icon: null, kind: "coinbase" });
  if (walletConnectProjectId()) options.push({ id: "walletconnect", name: "WalletConnect", icon: null, kind: "walletconnect" });
  return options;
}

export function walletConnectProjectId(): string {
  return env("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID");
}

function chainId(): number {
  return Number(env("NEXT_PUBLIC_CHAIN_ID") || "8453");
}

function appUrl(): string {
  return typeof window !== "undefined" ? window.location.origin : "https://midman.app";
}

async function createWalletConnect(): Promise<Eip1193Provider> {
  const projectId = walletConnectProjectId();
  if (!projectId) throw new Error("WalletConnect is not configured (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID)");
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId,
    chains: [chainId()],
    showQrModal: true,
    metadata: {
      name: "Midman",
      description: "USDC escrow on Base",
      url: appUrl(),
      icons: [`${appUrl()}/icon.svg`],
    },
  });
  await provider.connect();
  return provider as unknown as Eip1193Provider;
}

async function createCoinbase(): Promise<Eip1193Provider> {
  const { createCoinbaseWalletSDK } = await import("@coinbase/wallet-sdk");
  const sdk = createCoinbaseWalletSDK({
    appName: "Midman",
    appChainIds: [chainId()],
    preference: { options: "all" },
  });
  return sdk.getProvider() as unknown as Eip1193Provider;
}

/** Resolve (and remember) the provider for a wallet option. */
export async function selectWallet(id: string): Promise<Eip1193Provider> {
  let provider: Eip1193Provider;
  if (id === "walletconnect") provider = await createWalletConnect();
  else if (id === "coinbase") provider = await createCoinbase();
  else if (id === "injected") provider = legacyInjected();
  else {
    const found = announced.get(id);
    if (!found) throw new Error("That wallet is no longer available. Reload and try again.");
    provider = found.provider;
  }
  active = { id, provider };
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // remembered for this page view only
  }
  notify();
  return provider;
}

function legacyInjected(): Eip1193Provider {
  const injected = typeof window !== "undefined" ? (window as { ethereum?: Eip1193Provider }).ethereum : undefined;
  if (!injected || typeof injected.request !== "function") {
    throw new Error("No wallet selected. Choose a wallet to continue.");
  }
  return injected;
}

/**
 * The provider every helper should use: the selected wallet, else the
 * remembered EIP-6963 wallet, else window.ethereum (legacy single wallet).
 */
export function getActiveProvider(): Eip1193Provider {
  if (active) return active.provider;
  try {
    const remembered = localStorage.getItem(STORAGE_KEY);
    const found = remembered ? announced.get(remembered) : undefined;
    if (remembered && found) {
      active = { id: remembered, provider: found.provider };
      return found.provider;
    }
  } catch {
    // storage unavailable
  }
  return legacyInjected();
}

/** True when getActiveProvider() would resolve without asking the user. */
export function canResolveProvider(): boolean {
  try {
    getActiveProvider();
    return true;
  } catch {
    return false;
  }
}

/** True once the user has picked a wallet in this page view. */
export function hasSelectedWallet(): boolean {
  return active !== null;
}

/** Forget the selection (sign-out). Disconnects WalletConnect sessions. */
export async function clearWalletSelection(): Promise<void> {
  const previous = active;
  active = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  if (previous && previous.id === "walletconnect" && typeof previous.provider.disconnect === "function") {
    await previous.provider.disconnect().catch(() => undefined);
  }
  notify();
}

/** Test hook: reset module state. */
export function __resetProvidersForTests(): void {
  announced.clear();
  listeners.clear();
  active = null;
  discoveryStarted = false;
}
