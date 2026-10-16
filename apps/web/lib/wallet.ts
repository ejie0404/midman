// Wallet helpers (viem 2.9.0). Base chain, the user's selected EIP-1193 wallet (lib/providers.ts).
// All money stays bigint/strings; signatures match the API/contract typed data.

import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  http,
  encodeFunctionData,
  type Address,
  type Hash,
  type Chain,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { HUB_ABI, TYPES as EIP712_TYPES, buildDomain } from "@midman/chain";
import { getActiveProvider } from "./providers.ts";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown }) => Promise<unknown>;
    };
  }
}

export const RPC_URL =
  (typeof process !== "undefined" && process.env["NEXT_PUBLIC_RPC_URL"]) || "https://mainnet.base.org";

export const CHAIN_ID: number = Number(
  (typeof process !== "undefined" && process.env["NEXT_PUBLIC_CHAIN_ID"]) || "8453",
);

export const HUB_ADDRESS = (
  (typeof process !== "undefined" && process.env["NEXT_PUBLIC_HUB_ADDRESS"]) || ""
) as Address;

export const USDC_ADDRESS = (
  (typeof process !== "undefined" && process.env["NEXT_PUBLIC_USDC_ADDRESS"]) ||
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
) as Address;

const baseChain: Chain = CHAIN_ID === base.id ? base : { ...base, id: CHAIN_ID };

export function getPublicClient() {
  return createPublicClient({ chain: baseChain, transport: http(RPC_URL) });
}

/** The wallet the user picked (lib/providers.ts), falling back to window.ethereum. */
function requireEthereum() {
  return getActiveProvider();
}

export function getWalletClient() {
  const ethereum = requireEthereum();
  return createWalletClient({ chain: baseChain, transport: custom(ethereum) });
}

/** Connected wallet address. */
export async function getAccount(): Promise<Address> {
  const client = getWalletClient();
  const addresses = (await client.requestAddresses()) as Address[];
  const first = addresses[0];
  if (!first) throw new Error("Wallet returned no accounts");
  return first;
}

/** Throw unless the wallet is on the expected chain. */
export async function ensureChain(expectedChainId: number): Promise<void> {
  const client = getWalletClient();
  const actual = await client.getChainId();
  if (actual !== expectedChainId) {
    throw new Error(`Wrong network: wallet is on chain ${actual}, expected ${expectedChainId}`);
  }
}

export function randomBytes32(): Hash {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hash;
}

// ---- EIP-712 acceptance (off-chain draft) ----
// Matches apps/api/src/terms.ts acceptanceTypedData:
// domain {name MidmanDraft, version 1, chainId, verifyingContract hub},
// types DealTerms[dealId bytes32, principal uint256, quotedPlatformFee uint256, buyer, seller].

export interface AcceptanceTerms {
  readonly dealId: Hash;
  readonly principalUnits: string;
  readonly quotedFeeUnits: string;
  readonly buyer: Address;
  readonly seller: Address;
  readonly chainId: number;
  readonly hub: Address;
}

export async function signAcceptance(terms: AcceptanceTerms): Promise<Hash> {
  const account = await getAccount();
  const client = getWalletClient();
  return (await client.signTypedData({
    account,
    domain: {
      name: "MidmanDraft",
      version: "1",
      chainId: terms.chainId,
      verifyingContract: terms.hub,
    },
    types: {
      DealTerms: [
        { name: "dealId", type: "bytes32" },
        { name: "principal", type: "uint256" },
        { name: "quotedPlatformFee", type: "uint256" },
        { name: "buyer", type: "address" },
        { name: "seller", type: "address" },
      ],
    },
    primaryType: "DealTerms",
    message: {
      dealId: terms.dealId,
      principal: BigInt(terms.principalUnits),
      quotedPlatformFee: BigInt(terms.quotedFeeUnits),
      buyer: terms.buyer,
      seller: terms.seller,
    },
  })) as Hash;
}

// ---- EIP-712 OpenDispute (contract domain MidmanEscrow v1) ----
// Canonical @midman/chain OpenDispute definition (matches DISPUTE_TYPEHASH).

export interface OpenDisputeIntent {
  readonly dealId: Hash;
  readonly agreementDigest: Hash;
  readonly actor: Address;
  readonly reasonCode: number;
  readonly initialCommitment: Hash;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
}

export async function signOpenDispute(hub: Address, chainId: number, intent: OpenDisputeIntent): Promise<Hash> {
  const account = await getAccount();
  const client = getWalletClient();
  return (await client.signTypedData({
    account,
    domain: { name: "MidmanEscrow", version: "1", chainId, verifyingContract: hub },
    types: {
      OpenDispute: EIP712_TYPES.OpenDispute,
    },
    primaryType: "OpenDispute",
    message: {
      dealId: intent.dealId,
      agreementDigest: intent.agreementDigest,
      actor: intent.actor,
      reasonCode: intent.reasonCode,
      initialCommitment: intent.initialCommitment,
      nonce: intent.nonce,
      expiresAt: intent.expiresAt,
    },
  })) as Hash;
}

// ---- EIP-712 MarkDelivered (seller; contract domain MidmanEscrow v1) ----
// Canonical @midman/chain MarkDelivered definition (matches DELIVER_TYPEHASH).

export interface DeliverIntent {
  readonly dealId: Hash;
  readonly agreementDigest: Hash;
  readonly actor: Address;
  readonly manifestHash: Hash;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
}

export async function signDeliver(hub: Address, chainId: number, intent: DeliverIntent): Promise<Hash> {
  const account = await getAccount();
  const client = getWalletClient();
  return (await client.signTypedData({
    account,
    domain: { name: "MidmanEscrow", version: "1", chainId, verifyingContract: hub },
    types: {
      MarkDelivered: EIP712_TYPES.MarkDelivered,
    },
    primaryType: "MarkDelivered",
    message: {
      dealId: intent.dealId,
      agreementDigest: intent.agreementDigest,
      actor: intent.actor,
      manifestHash: intent.manifestHash,
      nonce: intent.nonce,
      expiresAt: intent.expiresAt,
    },
  })) as Hash;
}

// ---- Direct (relayer-free) transaction submission ----

/** Send a raw transaction from the connected wallet. Returns the tx hash (pending, NOT included). */
export async function sendDirect(to: Address, data: Hash | `0x${string}`): Promise<Hash> {
  const account = await getAccount();
  const client = getWalletClient();
  return (await client.sendTransaction({ account, to, data, chain: baseChain })) as Hash;
}

/** Wait for L2 inclusion receipt (still below safe/finalized — see confirmation API). */
export async function waitForInclusion(hash: Hash): Promise<void> {
  const publicClient = getPublicClient();
  await publicClient.waitForTransactionReceipt({ hash });
}

const MARK_DELIVERED_ABI = [
  {
    type: "function",
    name: "markDelivered",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dealId", type: "bytes32" },
      { name: "manifestHash", type: "bytes32" },
      { name: "nonce", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Direct markDelivered calldata. Empty sig works when the seller sends it themselves. */
export function encodeMarkDelivered(
  dealId: Hash,
  manifestHash: Hash,
  nonce: Hash,
  expiresAt: bigint,
  sig: Hash | `0x${string}`,
): Hash {
  return encodeFunctionData({
    abi: MARK_DELIVERED_ABI,
    functionName: "markDelivered",
    args: [dealId, manifestHash, nonce, expiresAt, sig],
  }) as Hash;
}

/** Direct openDispute calldata (in HUB_ABI). Empty sig works when the buyer sends it themselves. */
export function encodeOpenDispute(
  dealId: Hash,
  reasonCode: number,
  initialCommitment: Hash,
  nonce: Hash,
  expiresAt: bigint,
  sig: Hash | `0x${string}`,
): Hash {
  return encodeFunctionData({
    abi: HUB_ABI,
    functionName: "openDispute",
    args: [dealId, reasonCode, initialCommitment, nonce, expiresAt, sig],
  }) as Hash;
}

const APPROVE_SELLER_ABI = [
  {
    type: "function",
    name: "approveSeller",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dealId", type: "bytes32" },
      { name: "terminalPolicyVersion", type: "bytes32" },
      { name: "nonce", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const REFUND_BUYER_ABI = [
  {
    type: "function",
    name: "refundBuyer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dealId", type: "bytes32" },
      { name: "terminalPolicyVersion", type: "bytes32" },
      { name: "nonce", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** Direct approveSeller calldata. Empty sig works when the buyer sends it themselves. */
export function encodeApproveSeller(
  dealId: Hash,
  terminalPolicyVersion: Hash,
  nonce: Hash,
  expiresAt: bigint,
  sig: Hash | `0x${string}`,
): Hash {
  return encodeFunctionData({
    abi: APPROVE_SELLER_ABI,
    functionName: "approveSeller",
    args: [dealId, terminalPolicyVersion, nonce, expiresAt, sig],
  }) as Hash;
}

/** Direct refundBuyer calldata. Empty sig works when the seller sends it themselves. */
export function encodeRefundBuyer(
  dealId: Hash,
  terminalPolicyVersion: Hash,
  nonce: Hash,
  expiresAt: bigint,
  sig: Hash | `0x${string}`,
): Hash {
  return encodeFunctionData({
    abi: REFUND_BUYER_ABI,
    functionName: "refundBuyer",
    args: [dealId, terminalPolicyVersion, nonce, expiresAt, sig],
  }) as Hash;
}
/** Direct USDC approve calldata (step 1 of relayer-free funding). */
export function encodeApprove(spender: Address, amountUnits: string): Hash {
  return encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender, BigInt(amountUnits)],
  }) as Hash;
}

// ---- Connectivity additions (chain enforcement + wallet lifecycle) ----
// Implemented in ./connectivity.ts; re-exported here for convenience.
// No existing function above was modified.

export {
  ensureChainId,
  switchChainSafely,
  connectWallet,
  disconnectWallet,
  getWalletState,
  subscribe,
  unsubscribe,
  resetWalletStore,
  useWalletLifecycle,
  ChainMismatchError,
  UserRejectedError,
} from "./connectivity.ts";
export type {
  ChainClient,
  SwitchChainOptions,
  WalletState,
  WalletListener,
  EthereumProvider,
} from "./connectivity.ts";

// ---- Finding #6: canonical MidmanEscrow DealTerms signing ----
//
// The hub verifies `agreementDigestOf(DealTerms)` over the FULL 32-field
// struct (packages/contracts/src/MidmanHub.sol). Signing the old 5-field
// MidmanDraft acceptance message recovered to a different signer than the
// contract expects (or produced a digest the hub rejects) — so the web MUST
// sign the canonical `MidmanEscrow` / `DealTerms` typed data below.

export interface DealTermsMessage {
  readonly dealId: Hash;
  readonly termsVersion: number;
  readonly buyerAddress: Address;
  readonly sellerAddress: Address;
  readonly sellerPayoutAddress: Address;
  readonly buyerRefundAddress: Address;
  readonly buyerBondRefundAddress: Address;
  readonly sellerBondRefundAddress: Address;
  readonly token: Address;
  readonly principal: bigint;
  readonly quotedPlatformFee: bigint;
  readonly buyerFeeBps: number;
  readonly agreementHash: Hash;
  readonly feePolicyId: Hash;
  readonly deliveryPeriodSeconds: number;
  readonly inspectionPeriodSeconds: number;
  readonly categoryPolicyId: Hash;
  readonly readinessPolicyId: Hash;
  readonly readinessConsentHash: Hash;
  readonly evidencePolicyId: Hash;
  readonly bondPolicyId: Hash;
  readonly arbitrationPolicyId: Hash;
  readonly outagePolicyId: Hash;
  readonly catastrophicPolicyId: Hash;
  readonly platformFeeRecipient: Address;
  readonly arbitrationCostRecipient: Address;
  readonly fundingDeadline: bigint;
  readonly nonce: Hash;
  readonly salt: Hash;
  readonly factory: Address;
  readonly implementation: Address;
  readonly custodyAddress: Address;
}

/** Sign the canonical 32-field DealTerms struct (domain MidmanEscrow v1). */
export async function signDealTerms(hub: Address, chainId: number, message: DealTermsMessage): Promise<Hash> {
  const account = await getAccount();
  const client = getWalletClient();
  return (await client.signTypedData({
    account,
    domain: buildDomain(chainId, hub),
    types: { DealTerms: EIP712_TYPES.DealTerms },
    primaryType: "DealTerms",
    message,
  })) as Hash;
}

// ---- Canonical FundWithAllowance (direct approve + fund) ----

export interface AllowanceIntentMessage {
  readonly dealId: Hash;
  readonly agreementDigest: Hash;
  readonly payer: Address;
  readonly amount: bigint;
  readonly paymentSalt: Hash;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
}

/** Sign the FundWithAllowance intent consumed by the hub's non-3009 branch. */
export async function signAllowanceIntent(
  hub: Address,
  chainId: number,
  intent: AllowanceIntentMessage,
): Promise<Hash> {
  const account = await getAccount();
  const client = getWalletClient();
  return (await client.signTypedData({
    account,
    domain: buildDomain(chainId, hub),
    types: { FundWithAllowance: EIP712_TYPES.FundWithAllowance },
    primaryType: "FundWithAllowance",
    message: {
      dealId: intent.dealId,
      agreementDigest: intent.agreementDigest,
      payer: intent.payer,
      amount: intent.amount,
      paymentSalt: intent.paymentSalt,
      nonce: intent.nonce,
      expiresAt: intent.expiresAt,
    },
  })) as Hash;
}

// ---- Canonical ReadinessConsent (required readiness policy) ----

export interface ReadinessConsentMessage {
  readonly dealId: Hash;
  readonly agreementDigest: Hash;
  readonly buyer: Address;
  readonly attestedAt: bigint;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
}

/** Sign the buyer ReadinessConsent (only when the readiness policy requires it). */
export async function signReadinessConsent(
  hub: Address,
  chainId: number,
  intent: ReadinessConsentMessage,
): Promise<Hash> {
  const account = await getAccount();
  const client = getWalletClient();
  return (await client.signTypedData({
    account,
    domain: buildDomain(chainId, hub),
    types: { ReadinessConsent: EIP712_TYPES.ReadinessConsent },
    primaryType: "ReadinessConsent",
    message: {
      dealId: intent.dealId,
      agreementDigest: intent.agreementDigest,
      buyer: intent.buyer,
      attestedAt: intent.attestedAt,
      nonce: intent.nonce,
      expiresAt: intent.expiresAt,
    },
  })) as Hash;
}

// ---- Finding #8: exact-tx receipt + expected-event confirmation ----
//
// A relay acceptance, a `getConfirmation(dealId)` level, or an "included"
// label is NOT proof that a specific action happened. Callers must assert
// (1) the EXACT tx receipt status === "success" and (2) the expected event
// with the matching dealId present in that receipt's logs before reporting
// any irreversible outcome (funded / frozen).

export class TxRevertedError extends Error {
  readonly txHash: Hash;
  readonly status: string;
  constructor(txHash: Hash, status = "reverted") {
    super(`Transaction ${txHash} did not succeed (receipt status: ${status})`);
    this.name = "TxRevertedError";
    this.txHash = txHash;
    this.status = status;
  }
}

export class EventNotFoundError extends Error {
  readonly txHash: Hash;
  readonly eventName: string;
  constructor(txHash: Hash, eventName: string) {
    super(`Transaction ${txHash} did not emit ${eventName}`);
    this.name = "EventNotFoundError";
    this.txHash = txHash;
    this.eventName = eventName;
  }
}

/** Minimal receipt waiter (viem PublicClient or a test stub). */
export interface ReceiptWaiter {
  waitForTransactionReceipt(args: { hash: Hash }): Promise<TransactionReceipt>;
}

/** Wait for inclusion and assert the receipt succeeded (throws TxRevertedError). */
export async function waitForReceipt(
  hash: Hash,
  options?: { readonly publicClient?: ReceiptWaiter },
): Promise<TransactionReceipt> {
  const publicClient = (options?.publicClient ?? getPublicClient()) as ReceiptWaiter;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new TxRevertedError(hash, receipt.status);
  }
  return receipt;
}

/** Send, wait for the receipt, and assert `receipt.status === "success"`. */
export async function sendAndConfirm(
  sendFn: () => Promise<Hash>,
  options?: { readonly publicClient?: ReceiptWaiter },
): Promise<TransactionReceipt> {
  const hash = await sendFn();
  return waitForReceipt(hash, options);
}

export interface ConfirmedEvent {
  readonly eventName: string;
  readonly args: Record<string, unknown>;
  readonly address: Address;
}

/**
 * Decode the receipt logs with HUB_ABI and assert the exact expected event
 * (optionally with matching args) is present for `hub`. Throws
 * EventNotFoundError otherwise — never infer inclusion from generic status.
 */
export function confirmEvent(
  receipt: TransactionReceipt,
  hub: Address,
  eventName: string,
  match?: (args: Record<string, unknown>) => boolean,
): ConfirmedEvent {
  const wanted = hub.toLowerCase();
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== wanted) continue;
    let decoded: { eventName?: string; args?: unknown };
    try {
      decoded = decodeEventLog({
        abi: HUB_ABI,
        data: log.data,
        topics: log.topics,
      }) as unknown as { eventName?: string; args?: unknown };
    } catch {
      continue;
    }
    if (decoded.eventName !== eventName) continue;
    const args = (decoded.args ?? {}) as Record<string, unknown>;
    if (match !== undefined && !match(args)) continue;
    return { eventName, args, address: log.address };
  }
  throw new EventNotFoundError(receipt.transactionHash, eventName);
}

// ---- EIP-712 ApproveSeller / RefundBuyer (contract domain MidmanEscrow v1) ----
// Required when the release/refund is relayed: the relayer submits, but only
// the actor's signature (buyer to release, seller to refund) authorizes it.

export interface SettleIntent {
  readonly dealId: Hash;
  /** The deal's EIP-712 terms digest (terms.agreementDigest), never agreementHash. */
  readonly agreementDigest: Hash;
  readonly actor: Address;
  readonly terminalPolicyVersion: Hash;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
}

export async function signSettle(
  kind: "approveSeller" | "refundBuyer",
  hub: Address,
  chainId: number,
  intent: SettleIntent,
): Promise<Hash> {
  const account = await getAccount();
  const client = getWalletClient();
  const primaryType = kind === "approveSeller" ? "ApproveSeller" : "RefundBuyer";
  return (await client.signTypedData({
    account,
    domain: { name: "MidmanEscrow", version: "1", chainId, verifyingContract: hub },
    types: { [primaryType]: EIP712_TYPES[primaryType] } as never,
    primaryType,
    message: {
      dealId: intent.dealId,
      agreementDigest: intent.agreementDigest,
      actor: intent.actor,
      terminalPolicyVersion: intent.terminalPolicyVersion,
      nonce: intent.nonce,
      expiresAt: intent.expiresAt,
    },
  } as never)) as Hash;
}
