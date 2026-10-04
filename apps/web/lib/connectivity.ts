// Central connectivity configuration, chain enforcement, wallet lifecycle,
// polling, and request tracing for apps/web (Next.js 15, React 19, viem 2.9.0).
//
// Only erasable TypeScript is used so Node 24 can import this file directly
// in tests (same convention as lib/requestAuth.ts and lib/evidence.ts).
//
// Adoption notes:
// - api.ts has a single fetch choke point (`request()`); it wires
//   withRequestId() there. Nothing else in api.ts changed.
// - TxStatus (app/components/TxStatus.tsx) is purely presentational and does
//   not poll; useDeal.ts does one-shot loads. No component was rewritten —
//   status/confirmation polling should adopt createPoller() when a polling UI
//   is introduced.
// - Env names: NEXT_PUBLIC_API_URL, NEXT_PUBLIC_RPC_URLS (comma-separated),
//   NEXT_PUBLIC_CHAIN_ID, NEXT_PUBLIC_REQUEST_TIMEOUT_MS. There are no secrets
//   here, so diagnostics redact nothing.

import { useSyncExternalStore } from "react";

// ---- 1. Central config ----

export const DEFAULT_API_BASE = "http://localhost:3001";
export const DEFAULT_RPC_URLS: readonly string[] = ["https://mainnet.base.org"];
export const DEFAULT_CHAIN_ID = 8453;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

function requireHttpUrl(raw: string, envName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`connectivity: ${envName} is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`connectivity: ${envName} must be an http(s) URL: ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

/** Base URL of the Midman API. Validated http(s) URL, no trailing slash. */
export function apiBase(): string {
  const raw = readEnv("NEXT_PUBLIC_API_URL") ?? DEFAULT_API_BASE;
  return requireHttpUrl(raw, "NEXT_PUBLIC_API_URL");
}

/** RPC endpoint list from NEXT_PUBLIC_RPC_URLS (comma-separated). */
export function rpcUrls(): string[] {
  const raw = readEnv("NEXT_PUBLIC_RPC_URLS");
  const list = (raw === undefined ? [...DEFAULT_RPC_URLS] : raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))
    .map((url) => requireHttpUrl(url, "NEXT_PUBLIC_RPC_URLS"));
  if (list.length === 0) throw new Error("connectivity: NEXT_PUBLIC_RPC_URLS must list at least one URL");
  return list;
}

function parsePositiveInt(raw: string, envName: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`connectivity: ${envName} must be a positive integer: ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`connectivity: ${envName} must be a positive integer: ${raw}`);
  }
  return value;
}

/** Expected chain id (Base mainnet 8453 by default). */
export function expectedChainId(): number {
  const raw = readEnv("NEXT_PUBLIC_CHAIN_ID") ?? String(DEFAULT_CHAIN_ID);
  return parsePositiveInt(raw, "NEXT_PUBLIC_CHAIN_ID");
}

/** Per-request timeout in ms for API/RPC reads (default 15000). */
export function requestTimeoutMs(): number {
  const raw = readEnv("NEXT_PUBLIC_REQUEST_TIMEOUT_MS") ?? String(DEFAULT_REQUEST_TIMEOUT_MS);
  return parsePositiveInt(raw, "NEXT_PUBLIC_REQUEST_TIMEOUT_MS");
}

export interface ConnectivityConfig {
  readonly apiBase: string;
  readonly rpcUrls: readonly string[];
  readonly expectedChainId: number;
  readonly requestTimeoutMs: number;
}

const _config = {
  get apiBase(): string {
    return apiBase();
  },
  get rpcUrls(): readonly string[] {
    return rpcUrls();
  },
  get expectedChainId(): number {
    return expectedChainId();
  },
  get requestTimeoutMs(): number {
    return requestTimeoutMs();
  },
};

/** Frozen live view of the connectivity config (getters re-read env). */
export const CONFIG: ConnectivityConfig = Object.freeze(_config);

export interface ConnectivityDiagnostics extends ConnectivityConfig {}

/** Snapshot of the effective connectivity config for diagnostics display. */
export function describeConnectivity(): ConnectivityDiagnostics {
  return Object.freeze({
    apiBase: apiBase(),
    rpcUrls: rpcUrls(),
    expectedChainId: expectedChainId(),
    requestTimeoutMs: requestTimeoutMs(),
  });
}

// ---- 2. Chain enforcement ----

export class ChainMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Wrong network: wallet is on chain ${actual}, expected ${expected}`);
    this.name = "ChainMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class UserRejectedError extends Error {
  constructor(message = "User rejected the request") {
    super(message);
    this.name = "UserRejectedError";
  }
}

/** Minimal wallet-client surface needed for chain checks (stub-friendly). */
export interface ChainClient {
  getChainId(): Promise<number>;
  request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

export interface SwitchChainOptions {
  readonly rpcUrls?: readonly string[];
}

function toHexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

function providerErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

/** Throw ChainMismatchError unless the wallet is on the expected chain. */
export async function ensureChainId(client: ChainClient, expected: number): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expected) throw new ChainMismatchError(expected, actual);
}

/**
 * Switch the wallet to the expected chain. Falls back to
 * wallet_addEthereumChain with Base params on error 4902 (unknown chain).
 * User rejection (4001) surfaces as UserRejectedError.
 */
export async function switchChainSafely(
  client: ChainClient,
  expected?: number,
  opts?: SwitchChainOptions,
): Promise<void> {
  if (typeof client.request !== "function") throw new Error("switchChainSafely: client does not support request");
  const target = expected ?? expectedChainId();
  const chainIdHex = toHexChainId(target);
  try {
    await client.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    return;
  } catch (error) {
    const code = providerErrorCode(error);
    if (code === 4001) throw new UserRejectedError("User rejected the network switch");
    if (code !== 4902) throw error;
  }
  const urls = opts?.rpcUrls !== undefined ? [...opts.rpcUrls] : rpcUrls();
  try {
    await client.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: urls,
          blockExplorerUrls: ["https://basescan.org"],
        },
      ],
    });
  } catch (error) {
    if (providerErrorCode(error) === 4001) throw new UserRejectedError("User rejected adding the Base network");
    throw error;
  }
}

// ---- 3. Wallet lifecycle ----

export interface WalletState {
  readonly address: string | null;
  readonly chainId: number | null;
}

export type WalletListener = (state: WalletState) => void;

/** Minimal EIP-1193 provider surface (stub-friendly). */
export interface EthereumProvider {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
}

let _walletState: WalletState = { address: null, chainId: null };
const _walletListeners = new Set<WalletListener>();
let _attachedProvider: EthereumProvider | null = null;
let _attachedHandlers: Readonly<Record<string, (...args: never[]) => void>> | null = null;

/** Current wallet store snapshot (same reference until the next update). */
export function getWalletState(): WalletState {
  return _walletState;
}

function setWalletState(next: WalletState): void {
  _walletState = next;
  for (const listener of [..._walletListeners]) listener(_walletState);
}

/** Subscribe to wallet store updates. Returns an unsubscribe function. */
export function subscribe(listener: WalletListener): () => void {
  _walletListeners.add(listener);
  return () => {
    _walletListeners.delete(listener);
  };
}

/** Remove a previously added wallet store listener. */
export function unsubscribe(listener: WalletListener): void {
  _walletListeners.delete(listener);
}

/** Test/utility reset: clears the store, listeners, and provider wiring. */
export function resetWalletStore(): void {
  detachProvider();
  _walletListeners.clear();
  _walletState = { address: null, chainId: null };
}

function parseChainId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw !== "") {
    const value = raw.startsWith("0x") || raw.startsWith("0X") ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function onAccountsChanged(accounts: unknown): void {
  const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? (accounts[0] as string) : null;
  setWalletState({ address: first, chainId: _walletState.chainId });
}

function onChainChanged(chain: unknown): void {
  setWalletState({ address: _walletState.address, chainId: parseChainId(chain) });
}

function onDisconnect(): void {
  setWalletState({ address: null, chainId: null });
}

function attachProvider(provider: EthereumProvider): void {
  if (typeof provider.on !== "function") {
    _attachedProvider = provider;
    _attachedHandlers = null;
    return;
  }
  const handlers = {
    accountsChanged: ((...args: never[]) => {
      onAccountsChanged(args[0]);
    }) as (...args: never[]) => void,
    chainChanged: ((...args: never[]) => {
      onChainChanged(args[0]);
    }) as (...args: never[]) => void,
    disconnect: (() => {
      onDisconnect();
    }) as (...args: never[]) => void,
  };
  provider.on("accountsChanged", handlers["accountsChanged"]);
  provider.on("chainChanged", handlers["chainChanged"]);
  provider.on("disconnect", handlers["disconnect"]);
  _attachedProvider = provider;
  _attachedHandlers = handlers;
}

function detachProvider(): void {
  const provider = _attachedProvider;
  const handlers = _attachedHandlers;
  _attachedProvider = null;
  _attachedHandlers = null;
  if (provider !== null && handlers !== null && typeof provider.removeListener === "function") {
    for (const event of Object.keys(handlers)) {
      const handler = handlers[event];
      if (handler !== undefined) provider.removeListener(event, handler);
    }
  }
}

function defaultProvider(): EthereumProvider {
  if (typeof window !== "undefined" && window.ethereum !== undefined) {
    const candidate = window.ethereum as unknown as EthereumProvider;
    if (typeof candidate.request === "function") return candidate;
  }
  throw new Error("No browser wallet found (window.ethereum is missing)");
}

/**
 * Connect via eth_requestAccounts, snapshot address + chain id, and wire
 * accountsChanged/chainChanged/disconnect events into the store.
 */
export async function connectWallet(provider?: EthereumProvider): Promise<WalletState> {
  const active = provider ?? defaultProvider();
  const accounts = (await active.request({ method: "eth_requestAccounts" })) as unknown;
  const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? (accounts[0] as string) : null;
  let chainId: number | null = null;
  try {
    chainId = parseChainId(await active.request({ method: "eth_chainId" }));
  } catch {
    chainId = null;
  }
  detachProvider();
  attachProvider(active);
  setWalletState({ address, chainId });
  return _walletState;
}

/** Clear the store and detach provider event listeners. */
export function disconnectWallet(): void {
  detachProvider();
  setWalletState({ address: null, chainId: null });
}

/** React 19 hook returning the wallet store snapshot. */
export function useWalletLifecycle(): WalletState {
  return useSyncExternalStore(subscribe, getWalletState);
}

// ---- 4. Polling ----

export type PollFn = (signal: AbortSignal) => Promise<unknown>;

export interface PollerOptions {
  readonly intervalMs: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface Poller {
  readonly start: () => void;
  readonly stop: () => void;
  readonly pollNow: () => void;
  readonly isRunning: () => boolean;
}

const POLL_BACKOFF_BASE_MS = 1000;
const POLL_BACKOFF_FACTOR = 2;
const POLL_BACKOFF_CAP_MS = 30000;

export function createPoller(fn: PollFn, options: PollerOptions): Poller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let failures = 0;
  let running = false;
  const external = options.signal;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay: number): void {
    clearTimer();
    if (!running) return;
    timer = setTimeout(() => {
      void tick();
    }, delay);
  }

  async function runOnce(): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;
    if (external !== undefined && external.aborted) controller.abort();
    const onExternalAbort = (): void => controller.abort();
    if (external !== undefined) external.addEventListener("abort", onExternalAbort, { once: true });
    try {
      await fn(controller.signal);
      failures = 0;
      schedule(options.intervalMs);
    } catch {
      failures += 1;
      const backoff = Math.min(
        POLL_BACKOFF_CAP_MS,
        POLL_BACKOFF_BASE_MS * POLL_BACKOFF_FACTOR ** (failures - 1),
      );
      // Jitter is UI-only: it spreads retry thundering-herd for status
      // displays and must never drive consensus, settlement, or fee timing.
      const jitter = Math.floor(Math.random() * 250);
      schedule(backoff + jitter);
    } finally {
      if (external !== undefined) external.removeEventListener("abort", onExternalAbort);
      if (inFlight === controller) inFlight = null;
    }
  }

  async function tick(): Promise<void> {
    if (!running || inFlight !== null) return;
    if (external !== undefined && external.aborted) {
      stop();
      return;
    }
    await runOnce();
  }

  function start(): void {
    if (running) return;
    running = true;
    if (options.timeoutMs !== undefined) {
      if (deadline !== null) clearTimeout(deadline);
      deadline = setTimeout(stop, options.timeoutMs);
    }
    if (external !== undefined) {
      if (external.aborted) {
        stop();
        return;
      }
      external.addEventListener("abort", stop, { once: true });
    }
    void tick();
  }

  function stop(): void {
    running = false;
    clearTimer();
    if (deadline !== null) {
      clearTimeout(deadline);
      deadline = null;
    }
    if (external !== undefined) external.removeEventListener("abort", stop);
    inFlight?.abort();
    inFlight = null;
  }

  function pollNow(): void {
    if (inFlight !== null) return;
    if (external !== undefined && external.aborted) {
      stop();
      return;
    }
    void runOnce();
  }

  function isRunning(): boolean {
    return running;
  }

  return { start, stop, pollNow, isRunning };
}

// ---- 5. Tracing ----

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** New random request id (crypto.randomUUID with a getRandomValues fallback). */
export function newRequestId(): string {
  const uuid = (globalThis.crypto as unknown as { randomUUID?: unknown }).randomUUID;
  if (typeof uuid === "function") return (uuid as () => string).call(globalThis.crypto);
  return fallbackUuid();
}

/**
 * Merge headers, ensuring an x-request-id is present (existing value wins,
 * matched case-insensitively).
 */
export function withRequestId(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers !== undefined) {
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        out[key] = value;
      });
    } else if (Array.isArray(headers)) {
      for (const [key, value] of headers) out[key] = value;
    } else {
      for (const key of Object.keys(headers)) out[key] = (headers as Record<string, string>)[key] as string;
    }
  }
  const has = Object.keys(out).some((key) => key.toLowerCase() === "x-request-id");
  if (!has) out["x-request-id"] = newRequestId();
  return out;
}
