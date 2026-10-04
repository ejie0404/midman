// Funding orchestration for Midman V1 (audit findings #6 and #8).
//
// Both funding paths end in the SAME on-chain assertion: wait for the exact
// transaction receipt, require status === "success", and require the
// DealFunded event for THIS dealId. A relay acceptance, a funding-status
// label, or a generic per-deal "confirmation" level is NEVER treated as
// funded.
//
//   (a) sponsored relay: submitRelayFund -> poll funding-status -> wait for the
//       relayer tx -> confirmEvent(DealFunded)
//   (b) direct: ensureChainId -> optional ERC20 approve -> fund() calldata
//       (full 32-field DealTerms + both signatures + allowance/admission/
//       readiness) -> wait for receipt -> confirmEvent(DealFunded)
//
// The DealTerms typed data is the canonical 32-field MidmanEscrow struct from
// @midman/chain (finding #6). The legacy 5-field MidmanDraft envelope is
// rejected by assertCanonicalDealTermsTypedData().
//
// Only erasable TypeScript is used so Node 24 can import this file directly
// in tests (no enums, namespaces, or parameter properties).

import { encodeFunctionData, type Address, type Hash, type TransactionReceipt } from "viem";
import { DEAL_TERMS_FIELDS, EIP712_DOMAIN, HUB_ABI, TYPES } from "@midman/chain";
import {
  getFundingBundleRaw,
  getFundingStatusRaw,
  postDealSignatures,
  postRelayFund as apiPostRelayFund,
} from "./api.ts";
import {
  confirmEvent,
  ensureChainId,
  getAccount,
  getPublicClient,
  getWalletClient,
  signAllowanceIntent,
  signReadinessConsent,
  waitForReceipt,
  type AllowanceIntentMessage,
  type ConfirmedEvent,
  type ReadinessConsentMessage,
  type ReceiptWaiter,
} from "./wallet.ts";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

const ERC20_ABI = [
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
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ---- Dependency injection (real viem clients by default, stubs in tests) ----

export interface TypedDataSigner {
  signTypedData(args: {
    account: Address;
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
}

export interface WalletClientLike {
  getChainId(): Promise<number>;
  sendTransaction(args: { account: Address; to: Address; data: Hash; chain?: unknown }): Promise<Hash>;
}

export interface PublicClientLike extends ReceiptWaiter {
  readContract?(args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

export interface FundingDeps {
  readonly fetchImpl?: typeof fetch;
  /** Fake or injected wallet client (tests). Defaults to the browser wallet. */
  readonly walletClient?: unknown;
  /** Fake or injected public client (tests). Defaults to the Base RPC client. */
  readonly publicClient?: unknown;
  /** Payer/buyer address (tests). Defaults to the connected account. */
  readonly account?: Address;
  /**
   * Skip the on-chain allowance read: `true` skips the approve step, `false`
   * forces it, `undefined` reads `allowance()` and approves only if short.
   */
  readonly allowanceSufficient?: boolean;
}

function walletOf(deps: FundingDeps): WalletClientLike {
  return (deps.walletClient ?? getWalletClient()) as unknown as WalletClientLike;
}

function publicOf(deps: FundingDeps): PublicClientLike {
  return (deps.publicClient ?? getPublicClient()) as unknown as PublicClientLike;
}

// ---- Bundle types (defensive, alias-tolerant) ----

export interface DealTermsTypedData {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: Address };
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

export interface PaymentStruct {
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly paymentSalt: Hash;
  readonly v: number;
  readonly r: Hash;
  readonly s: Hash;
  readonly use3009: boolean;
}

export interface AllowanceStruct {
  readonly paymentSalt: Hash;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
  readonly signature: string;
}

export interface AdmissionStruct {
  readonly minPolicyId: Hash;
  readonly admissionNonce: Hash;
  readonly expiresAt: bigint;
  readonly signature: string;
}

export interface ReadinessStruct {
  readonly attestedAt: bigint;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
  readonly signature: string;
}

export interface FundingBundle {
  readonly draftId: string;
  readonly dealId: Hash;
  readonly agreementDigest: Hash | null;
  readonly chainId: number;
  readonly hub: Address;
  readonly token: Address;
  readonly fundedUnits: string;
  readonly prepaidBuyerFeeUnits: string;
  readonly principalUnits: string;
  readonly requiresReadiness: boolean;
  readonly dealTermsTypedData: DealTermsTypedData;
  readonly fullTerms: Record<string, unknown>;
  readonly signatures: { readonly buyer: string | null; readonly seller: string | null };
  readonly pay: PaymentStruct | null;
  readonly allowance: AllowanceStruct | null;
  readonly admission: AdmissionStruct | null;
  readonly readiness: ReadinessStruct | null;
  readonly fundCalldataTemplate: string | null;
  readonly admissionNote: string | null;
}

// ---- Defensive parsing helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Funding bundle: ${field} must be an object`);
  return value;
}

function pickValue(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function required(obj: Record<string, unknown>, keys: readonly string[], field: string): unknown {
  const value = pickValue(obj, keys);
  if (value === undefined) throw new Error(`Funding bundle: missing ${field}`);
  return value;
}

function toBigIntValue(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`Funding bundle: ${field} must be an integer`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`Funding bundle: ${field} must be an integer`);
}

function asString(value: unknown, field: string): string {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new Error(`Funding bundle: ${field} must be a non-empty string`);
}

function asAddress(value: unknown, field: string): Address {
  const text = asString(value, field);
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`Funding bundle: ${field} is not an address: ${text}`);
  return text as Address;
}

function asHash(value: unknown, field: string): Hash {
  const text = asString(value, field);
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new Error(`Funding bundle: ${field} is not bytes32: ${text}`);
  return text as Hash;
}

function asUnits(value: unknown, field: string): string {
  const text = asString(value, field);
  if (!/^\d+$/.test(text)) throw new Error(`Funding bundle: ${field} must be smallest units (digits only)`);
  return text;
}

function isIntegerType(type: string): boolean {
  return type.startsWith("uint") || type.startsWith("int");
}

function normalizeStruct(
  raw: Record<string, unknown>,
  fields: readonly { readonly name: string; readonly type: string }[],
  label: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field.name];
    if (value === undefined || value === null) throw new Error(`Funding bundle: ${label}.${field.name} is required`);
    out[field.name] = isIntegerType(field.type) ? toBigIntValue(value, `${label}.${field.name}`) : value;
  }
  return out;
}

/** Normalize a DealTerms typed-data message: integer-type strings become bigint. */
export function normalizeTypedDataMessage(message: Record<string, unknown>): Record<string, unknown> {
  return normalizeStruct(message, DEAL_TERMS_FIELDS, "dealTermsTypedData.message");
}

/** Normalize the on-chain DealTerms tuple for encodeFunctionData. */
export function normalizeDealTerms(raw: Record<string, unknown>): Record<string, unknown> {
  return normalizeStruct(raw, DEAL_TERMS_FIELDS, "fullTerms");
}

function parsePayment(raw: unknown): PaymentStruct | null {
  if (raw === undefined || raw === null) return null;
  const obj = asRecord(raw, "pay");
  return {
    validAfter: toBigIntValue(obj["validAfter"] ?? 0, "pay.validAfter"),
    validBefore: toBigIntValue(obj["validBefore"] ?? 0, "pay.validBefore"),
    paymentSalt: asHash(obj["paymentSalt"] ?? ZERO_HASH, "pay.paymentSalt"),
    v: Number(toBigIntValue(obj["v"] ?? 0, "pay.v")),
    r: asHash(obj["r"] ?? ZERO_HASH, "pay.r"),
    s: asHash(obj["s"] ?? ZERO_HASH, "pay.s"),
    use3009: obj["use3009"] === true || obj["use3009"] === "true",
  };
}

function parseAllowance(raw: unknown): AllowanceStruct | null {
  if (raw === undefined || raw === null) return null;
  const obj = asRecord(raw, "allowance");
  return {
    paymentSalt: asHash(obj["paymentSalt"] ?? ZERO_HASH, "allowance.paymentSalt"),
    nonce: asHash(obj["nonce"] ?? ZERO_HASH, "allowance.nonce"),
    expiresAt: toBigIntValue(obj["expiresAt"] ?? 0, "allowance.expiresAt"),
    signature: typeof obj["signature"] === "string" ? obj["signature"] : "",
  };
}

function parseAdmission(raw: unknown): AdmissionStruct | null {
  if (raw === undefined || raw === null) return null;
  const obj = asRecord(raw, "admission");
  return {
    minPolicyId: asHash(obj["minPolicyId"] ?? ZERO_HASH, "admission.minPolicyId"),
    admissionNonce: asHash(obj["admissionNonce"] ?? ZERO_HASH, "admission.admissionNonce"),
    expiresAt: toBigIntValue(obj["expiresAt"] ?? 0, "admission.expiresAt"),
    signature: typeof obj["signature"] === "string" ? obj["signature"] : "",
  };
}

function parseReadiness(raw: unknown): ReadinessStruct | null {
  if (raw === undefined || raw === null) return null;
  const obj = asRecord(raw, "readiness");
  return {
    attestedAt: toBigIntValue(obj["attestedAt"] ?? 0, "readiness.attestedAt"),
    nonce: asHash(obj["nonce"] ?? ZERO_HASH, "readiness.nonce"),
    expiresAt: toBigIntValue(obj["expiresAt"] ?? 0, "readiness.expiresAt"),
    signature: typeof obj["signature"] === "string" ? obj["signature"] : "",
  };
}

function parseDealTermsTypedData(
  raw: unknown,
  fallback: { chainId: number; hub: Address; message: Record<string, unknown> },
): DealTermsTypedData {
  const declared = isRecord(raw) ? raw : undefined;
  const domainRaw = declared && isRecord(declared["domain"]) ? declared["domain"] : undefined;
  const messageRaw =
    declared && isRecord(declared["message"]) ? (declared["message"] as Record<string, unknown>) : fallback.message;
  const typesRaw = declared && isRecord(declared["types"]) ? declared["types"] : undefined;
  const types: Record<string, readonly { readonly name: string; readonly type: string }[]> = {};
  if (typesRaw) {
    for (const [key, value] of Object.entries(typesRaw)) {
      if (Array.isArray(value)) {
        types[key] = value as readonly { readonly name: string; readonly type: string }[];
      }
    }
  }
  if (!types["DealTerms"]) types["DealTerms"] = DEAL_TERMS_FIELDS;
  const chainId = domainRaw ? Number(toBigIntValue(domainRaw["chainId"], "domain.chainId")) : fallback.chainId;
  const hub =
    domainRaw && domainRaw["verifyingContract"] !== undefined
      ? asAddress(domainRaw["verifyingContract"], "domain.verifyingContract")
      : fallback.hub;
  const name = domainRaw && typeof domainRaw["name"] === "string" ? domainRaw["name"] : EIP712_DOMAIN.name;
  const version = domainRaw && typeof domainRaw["version"] === "string" ? domainRaw["version"] : EIP712_DOMAIN.version;
  return {
    domain: { name, version, chainId, verifyingContract: hub },
    types,
    primaryType: "DealTerms",
    message: messageRaw,
  };
}

/**
 * Assert a typed-data envelope is the canonical 32-field MidmanEscrow
 * DealTerms struct — rejects the legacy 5-field MidmanDraft acceptance shape.
 */
export function assertCanonicalDealTermsTypedData(typedData: DealTermsTypedData): void {
  if (typedData.domain.name !== EIP712_DOMAIN.name) {
    throw new Error(
      `Funding: DealTerms must use the ${EIP712_DOMAIN.name} domain (got "${typedData.domain.name}"); ` +
        "the 5-field MidmanDraft acceptance envelope is not valid for funding",
    );
  }
  const declared = typedData.types["DealTerms"];
  if (!Array.isArray(declared) || declared.length !== DEAL_TERMS_FIELDS.length) {
    throw new Error(
      `Funding: DealTerms must declare all ${DEAL_TERMS_FIELDS.length} canonical fields ` +
        `(got ${Array.isArray(declared) ? declared.length : 0})`,
    );
  }
  for (let i = 0; i < DEAL_TERMS_FIELDS.length; i += 1) {
    const expected = DEAL_TERMS_FIELDS[i]!;
    const actual = declared[i]!;
    if (actual.name !== expected.name || actual.type !== expected.type) {
      throw new Error(
        `Funding: DealTerms field ${i} mismatch (expected ${expected.type} ${expected.name}, got ${actual.type} ${actual.name})`,
      );
    }
  }
}

/** Parse + validate a raw funding-bundle response into a typed FundingBundle. */
export function parseFundingBundle(raw: unknown, draftId = ""): FundingBundle {
  const outer = asRecord(raw, "bundle");
  const data = isRecord(outer["bundle"]) ? asRecord(outer["bundle"], "bundle.bundle") : outer;

  const dealId = asHash(required(data, ["dealId"], "dealId"), "dealId");
  const chainId = Number(toBigIntValue(required(data, ["chainId"], "chainId"), "chainId"));
  const hub = asAddress(required(data, ["hub", "verifyingContract"], "hub"), "hub");
  const token = asAddress(required(data, ["token", "usdc", "paymentToken"], "token"), "token");
  const fundedUnits = asUnits(required(data, ["fundedUnits", "fundedAmount", "totalUnits"], "fundedUnits"), "fundedUnits");
  const prepaidBuyerFeeUnits = asUnits(
    pickValue(data, ["prepaidBuyerFeeUnits", "prepaidFeeUnits", "prepaidBuyerFee"]) ?? "0",
    "prepaidBuyerFeeUnits",
  );
  const principalUnits = asUnits(pickValue(data, ["principalUnits", "principal"]) ?? "0", "principalUnits");

  const agreementRaw = pickValue(data, ["agreementDigest", "agreementHash"]);
  const agreementDigest = agreementRaw === undefined ? null : asHash(agreementRaw, "agreementDigest");

  const fullTermsRaw = asRecord(required(data, ["fullTerms", "terms", "dealTermsStruct", "canonicalTerms"], "fullTerms"), "fullTerms");
  const fullTermsNested = isRecord(fullTermsRaw["message"]) ? asRecord(fullTermsRaw["message"], "fullTerms.message") : fullTermsRaw;
  const fullTerms = normalizeDealTerms(fullTermsNested);

  const typedRaw = pickValue(data, ["dealTermsTypedData", "typedData", "dealTerms"]);
  const typedDeclared = parseDealTermsTypedData(typedRaw, { chainId, hub, message: fullTermsNested });
  assertCanonicalDealTermsTypedData(typedDeclared);
  const dealTermsTypedData: DealTermsTypedData = {
    domain: typedDeclared.domain,
    types: typedDeclared.types,
    primaryType: typedDeclared.primaryType,
    message: normalizeTypedDataMessage(typedDeclared.message),
  };

  const sigsRaw = isRecord(data["signatures"]) ? data["signatures"] : isRecord(data["sigs"]) ? data["sigs"] : {};
  const signatures = {
    buyer: typeof sigsRaw["buyer"] === "string" && sigsRaw["buyer"] !== "" ? (sigsRaw["buyer"] as string) : null,
    seller: typeof sigsRaw["seller"] === "string" && sigsRaw["seller"] !== "" ? (sigsRaw["seller"] as string) : null,
  };

  const readinessFlag = pickValue(data, ["requiresReadiness", "readinessRequired", "requiresReadinessConsent"]);
  const requiresReadiness = readinessFlag === true || readinessFlag === "true";

  const noteRaw = pickValue(data, ["admissionNote", "note", "admissionServiceNote"]);

  return {
    draftId: draftId || (typeof pickValue(data, ["draftId"]) === "string" ? (pickValue(data, ["draftId"]) as string) : ""),
    dealId,
    agreementDigest,
    chainId,
    hub,
    token,
    fundedUnits,
    prepaidBuyerFeeUnits,
    principalUnits,
    requiresReadiness,
    dealTermsTypedData,
    fullTerms,
    signatures,
    pay: parsePayment(pickValue(data, ["pay", "payment", "payment3009"])),
    allowance: parseAllowance(pickValue(data, ["allowance", "allowanceIntent"])),
    admission: parseAdmission(pickValue(data, ["admission"])),
    readiness: parseReadiness(pickValue(data, ["readiness", "readinessAuth"])),
    fundCalldataTemplate:
      typeof pickValue(data, ["fundCalldataTemplate"]) === "string"
        ? (pickValue(data, ["fundCalldataTemplate"]) as string)
        : null,
    admissionNote: typeof noteRaw === "string" ? noteRaw : null,
  };
}

/** GET the funding bundle, parsed + validated. Throws ApiError on transport failures. */
export async function fetchFundingBundle(draftId: string, deps: FundingDeps = {}): Promise<FundingBundle> {
  const raw = await getFundingBundleRaw(draftId, deps.fetchImpl);
  return parseFundingBundle(raw, draftId);
}

// ---- Signing (canonical MidmanEscrow types only) ----

async function signCanonical(
  client: TypedDataSigner,
  account: Address,
  chainId: number,
  hub: Address,
  primaryType: "DealTerms" | "FundWithAllowance" | "ReadinessConsent",
  message: Record<string, unknown>,
): Promise<Hash> {
  return (await client.signTypedData({
    account,
    domain: { name: EIP712_DOMAIN.name, version: EIP712_DOMAIN.version, chainId, verifyingContract: hub },
    types: { [primaryType]: TYPES[primaryType] },
    primaryType,
    message,
  })) as Hash;
}

/**
 * Sign the bundle's DealTerms typed data with `account`. Validates the
 * envelope is the canonical 32-field struct before signing (finding #6).
 */
export async function signDealTerms(
  account: Address,
  typedData: DealTermsTypedData,
  deps: FundingDeps = {},
): Promise<Hash> {
  assertCanonicalDealTermsTypedData(typedData);
  const client = (deps.walletClient ?? getWalletClient()) as unknown as TypedDataSigner;
  return signCanonical(
    client,
    account,
    typedData.domain.chainId,
    typedData.domain.verifyingContract,
    "DealTerms",
    normalizeTypedDataMessage(typedData.message),
  );
}

/** Sign the FundWithAllowance intent (direct approve + fund path). */
export async function signAllowance(
  account: Address,
  intent: AllowanceIntentMessage,
  ctx: { readonly chainId: number; readonly hub: Address },
  deps: FundingDeps = {},
): Promise<Hash> {
  if (deps.walletClient === undefined) {
    return signAllowanceIntent(ctx.hub, ctx.chainId, intent);
  }
  return signCanonical(deps.walletClient as TypedDataSigner, account, ctx.chainId, ctx.hub, "FundWithAllowance", {
    dealId: intent.dealId,
    agreementDigest: intent.agreementDigest,
    payer: intent.payer,
    amount: intent.amount,
    paymentSalt: intent.paymentSalt,
    nonce: intent.nonce,
    expiresAt: intent.expiresAt,
  });
}

/** Sign the buyer ReadinessConsent (required readiness policy only). */
export async function signReadiness(
  account: Address,
  intent: ReadinessConsentMessage,
  ctx: { readonly chainId: number; readonly hub: Address },
  deps: FundingDeps = {},
): Promise<Hash> {
  if (deps.walletClient === undefined) {
    return signReadinessConsent(ctx.hub, ctx.chainId, intent);
  }
  return signCanonical(deps.walletClient as TypedDataSigner, account, ctx.chainId, ctx.hub, "ReadinessConsent", {
    dealId: intent.dealId,
    agreementDigest: intent.agreementDigest,
    buyer: intent.buyer,
    attestedAt: intent.attestedAt,
    nonce: intent.nonce,
    expiresAt: intent.expiresAt,
  });
}

/** Return a copy of the bundle with freshly produced inner signatures attached. */
export function withFundingSignatures(
  bundle: FundingBundle,
  overrides: {
    readonly allowanceSignature?: string;
    readonly readinessSignature?: string;
    readonly admissionSignature?: string;
  },
): FundingBundle {
  const allowance =
    bundle.allowance !== null && overrides.allowanceSignature !== undefined
      ? { ...bundle.allowance, signature: overrides.allowanceSignature }
      : bundle.allowance;
  const readiness =
    bundle.readiness !== null && overrides.readinessSignature !== undefined
      ? { ...bundle.readiness, signature: overrides.readinessSignature }
      : bundle.readiness;
  const admission =
    bundle.admission !== null && overrides.admissionSignature !== undefined
      ? { ...bundle.admission, signature: overrides.admissionSignature }
      : bundle.admission;
  return { ...bundle, allowance, readiness, admission };
}

// ---- Calldata ----

function zeroPayment(): PaymentStruct {
  return { validAfter: 0n, validBefore: 0n, paymentSalt: ZERO_HASH, v: 0, r: ZERO_HASH, s: ZERO_HASH, use3009: false };
}
function zeroAllowance(): AllowanceStruct {
  return { paymentSalt: ZERO_HASH, nonce: ZERO_HASH, expiresAt: 0n, signature: "0x" };
}
function zeroAdmission(): AdmissionStruct {
  return { minPolicyId: ZERO_HASH, admissionNonce: ZERO_HASH, expiresAt: 0n, signature: "0x" };
}
function zeroReadiness(): ReadinessStruct {
  return { attestedAt: 0n, nonce: ZERO_HASH, expiresAt: 0n, signature: "0x" };
}

/** ERC20 approve calldata for the exact funded amount. */
export function buildApproveCalldata(spender: Address, amountUnits: string): Hash {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, BigInt(amountUnits)],
  }) as Hash;
}

/**
 * Encode the full `fund(...)` call from the bundle's on-chain DealTerms plus
 * both party signatures. This is the only direct call the hub accepts for a
 * newly funded deal (finding #6: the web must not stop at approve()).
 */
export function buildFundCalldata(
  bundle: FundingBundle,
  signatures: { readonly buyer: string; readonly seller: string },
): Hash {
  if (!signatures.buyer || signatures.buyer === "0x") {
    throw new Error("Funding: buyer DealTerms signature is required to call fund()");
  }
  if (!signatures.seller || signatures.seller === "0x") {
    throw new Error("Funding: seller DealTerms signature is required to call fund()");
  }
  const terms = normalizeDealTerms(bundle.fullTerms);
  const args = [
    terms,
    signatures.buyer as `0x${string}`,
    signatures.seller as `0x${string}`,
    bundle.pay ?? zeroPayment(),
    bundle.allowance ?? zeroAllowance(),
    bundle.admission ?? zeroAdmission(),
    bundle.readiness ?? zeroReadiness(),
  ];
  return encodeFunctionData({
    abi: HUB_ABI,
    functionName: "fund",
    args: args as never,
  } as unknown as Parameters<typeof encodeFunctionData>[0]) as Hash;
}

// ---- Sponsored relay path ----

export interface RelayFundPayload {
  readonly buyerSignature: string;
  readonly sellerSignature: string;
  readonly payer?: string;
  readonly readinessSignature?: string;
  readonly allowanceSignature?: string;
  readonly admissionSignature?: string;
  readonly idempotencyKey?: string;
  readonly [key: string]: unknown;
}

export interface RelayFundResult {
  readonly idempotencyKey: string;
  readonly inserted: boolean;
  readonly status: string;
}

function newIdempotencyKey(prefix: string, seed: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${seed.slice(0, 16)}-${Date.now()}-${rand}`;
}

/**
 * Hand the funding bundle to the sponsored relayer. The idempotency key makes
 * retries safe: a repeated key never double-funds. A returned status is NOT
 * inclusion — wait for the receipt + DealFunded event (waitForFundingEvent).
 */
export function submitRelayFund(
  draftId: string,
  payload: RelayFundPayload,
  deps: FundingDeps = {},
): Promise<RelayFundResult> {
  const idempotencyKey =
    typeof payload.idempotencyKey === "string" && payload.idempotencyKey !== ""
      ? payload.idempotencyKey
      : newIdempotencyKey("fund", draftId);
  const body: Record<string, unknown> = { ...payload, idempotencyKey };
  return apiPostRelayFund(draftId, body, deps.fetchImpl) as Promise<RelayFundResult>;
}

export interface DealSignaturesPayload {
  readonly buyer?: string;
  readonly seller?: string;
  readonly [key: string]: unknown;
}

/** POST the buyer/seller DealTerms signatures to the draft. */
export function submitDealSignatures(
  draftId: string,
  payload: DealSignaturesPayload,
  deps: FundingDeps = {},
): Promise<unknown> {
  return postDealSignatures(draftId, payload, deps.fetchImpl);
}

// ---- Funding status (relay/projection) ----

export interface FundingStatus {
  readonly draftId: string;
  readonly status: string;
  readonly txHash: Hash | null;
  readonly included: boolean;
  readonly safe: boolean;
  readonly finalized: boolean;
  readonly level: "pending" | "included" | "safe" | "finalized";
  readonly funder: string | null;
}

export async function fetchFundingStatus(draftId: string, deps: FundingDeps = {}): Promise<FundingStatus> {
  const raw = await getFundingStatusRaw(draftId, deps.fetchImpl);
  const obj = asRecord(raw, "funding status");
  const data = isRecord(obj["status"]) ? (obj["status"] as Record<string, unknown>) : obj;
  const rawLevel = pickValue(data, ["level", "confirmation"]);
  const level = rawLevel === "safe" || rawLevel === "finalized" || rawLevel === "included" ? rawLevel : "pending";
  const txRaw = pickValue(data, ["txHash", "transactionHash", "hash"]);
  const txHash = typeof txRaw === "string" && /^0x[0-9a-fA-F]{64}$/.test(txRaw) ? (txRaw as Hash) : null;
  const statusRaw = pickValue(data, ["status", "state"]);
  const funderRaw = pickValue(data, ["funder", "payer"]);
  return {
    draftId,
    status: typeof statusRaw === "string" ? statusRaw : "unknown",
    txHash,
    included: data["included"] === true || level !== "pending",
    safe: data["safe"] === true || level === "safe" || level === "finalized",
    finalized: data["finalized"] === true || level === "finalized",
    level,
    funder: typeof funderRaw === "string" ? funderRaw : null,
  };
}

// ---- Direct path: ensureChain -> optional approve -> fund() -> assert event ----

async function requiresApproval(bundle: FundingBundle, owner: Address, deps: FundingDeps): Promise<boolean> {
  // EIP-3009 receiveWithAuthorization settles inside fund(): no ERC20 approve.
  if (bundle.pay?.use3009 === true) return false;
  if (deps.allowanceSufficient === true) return false;
  if (deps.allowanceSufficient === false) return true;
  const client = deps.publicClient as PublicClientLike | undefined;
  if (client && typeof client.readContract === "function") {
    try {
      const current = (await client.readContract({
        address: bundle.token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, bundle.hub],
      })) as bigint | number | string;
      return BigInt(current) < BigInt(bundle.fundedUnits);
    } catch {
      // Unreadable allowance: approve rather than risk a reverted fund().
    }
  }
  return true;
}

export interface DirectFundResult {
  readonly approveTxHash: Hash | null;
  readonly fundTxHash: Hash;
  readonly receipt: TransactionReceipt;
  readonly event: ConfirmedEvent;
}

/**
 * Direct, relayer-free funding: ensureChainId -> optional ERC20 approve ->
 * fund() (full DealTerms + both signatures + allowance/admission/readiness) ->
 * wait for the exact receipt -> confirm DealFunded for this dealId.
 *
 * The approve step is never the end state: if fund() is not sent (or the
 * DealFunded event is absent), this throws (finding #6 + #8).
 */
export async function directFund(
  bundle: FundingBundle,
  signatures: { readonly buyer: string; readonly seller: string },
  deps: FundingDeps = {},
): Promise<DirectFundResult> {
  const wallet = walletOf(deps);
  await ensureChainId(wallet as unknown as { getChainId(): Promise<number> }, bundle.chainId);

  const payer = deps.account ?? (await getAccount());
  const publicClient = publicOf(deps);

  let approveTxHash: Hash | null = null;
  if (await requiresApproval(bundle, payer, deps)) {
    const approveData = buildApproveCalldata(bundle.hub, bundle.fundedUnits);
    const approveReceipt = await waitForReceipt(await wallet.sendTransaction({ account: payer, to: bundle.token, data: approveData }), {
      publicClient,
    });
    approveTxHash = approveReceipt.transactionHash;
  }

  const fundData = buildFundCalldata(bundle, signatures);
  const receipt = await waitForReceipt(await wallet.sendTransaction({ account: payer, to: bundle.hub, data: fundData }), {
    publicClient,
  });
  const event = confirmEvent(receipt, bundle.hub, "DealFunded", (args) =>
    String(args["dealId"]).toLowerCase() === bundle.dealId.toLowerCase(),
  );
  return { approveTxHash, fundTxHash: receipt.transactionHash, receipt, event };
}

// ---- Relay path: poll status -> wait receipt -> assert DealFunded ----

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitFundingOptions extends FundingDeps {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export interface FundingEventResult {
  readonly txHash: Hash;
  readonly receipt: TransactionReceipt;
  readonly event: ConfirmedEvent;
}

/**
 * Poll funding-status until the relayer's tx hash appears, then wait for its
 * exact receipt and confirm the DealFunded event for this dealId.
 */
export async function waitForFundingEvent(
  draftId: string,
  hub: Address,
  dealId: Hash,
  options: WaitFundingOptions = {},
): Promise<FundingEventResult> {
  const intervalMs = options.intervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  let txHash: Hash | null = null;
  while (txHash === null) {
    if (Date.now() > deadline) throw new Error("Funding relay: timed out waiting for a transaction hash");
    const status = await fetchFundingStatus(draftId, options);
    if (status.txHash !== null) {
      txHash = status.txHash;
      break;
    }
    await sleep(intervalMs);
  }
  const publicClient = publicOf(options);
  const receipt = await waitForReceipt(txHash, { publicClient });
  const event = confirmEvent(receipt, hub, "DealFunded", (args) =>
    String(args["dealId"]).toLowerCase() === dealId.toLowerCase(),
  );
  return { txHash, receipt, event };
}
