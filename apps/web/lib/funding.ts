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
import { ABSENT_SIGNATURE } from "@midman/api-client";
import type { RelayFundPayload as CanonicalRelayFundPayload } from "@midman/api-client";
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

// ---- Bundle types (canonical API contract, no aliases) ----
//
// Field names mirror the wire shapes in @midman/api-client/src/funding.ts
// exactly. Transport uints arrive as decimal strings and are normalized to
// bigint here for signing/encoding; assembleRelayPayload() converts back to
// decimal strings for POST. The bundle carries signing PARAMS plus typed-data
// envelopes — never wallet signatures (those travel as explicit arguments).

export interface TypedDataEnvelopeWire {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

export interface BundleAllowanceParams {
  readonly paymentSalt: Hash;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
  readonly typedData: TypedDataEnvelopeWire;
}

export interface BundleReadinessParams {
  readonly required: boolean | null;
  readonly note: string;
  readonly attestedAt: bigint;
  readonly nonce: Hash;
  readonly expiresAt: bigint;
  readonly typedData: TypedDataEnvelopeWire | null;
}

export interface BundleAdmission {
  readonly note: string;
  /** Operator-granted admission struct, or null until the operator grants it. */
  readonly granted: AdmissionStruct | null;
}

export interface BundlePayment3009 {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly paymentSalt: Hash;
  readonly nonce: Hash;
}

export interface FundingBundle {
  readonly draftId: string;
  readonly dealId: Hash;
  readonly agreementDigest: Hash | null;
  readonly chainId: number;
  readonly hub: Address;
  readonly token: Address;
  readonly principalUnits: string;
  readonly fundedUnits: string;
  readonly prepaidBuyerFeeUnits: string;
  readonly dealTermsTypedData: DealTermsTypedData;
  readonly fullTerms: Record<string, unknown>;
  readonly signatures: { readonly buyer: string | null; readonly seller: string | null };
  readonly allowance: BundleAllowanceParams;
  readonly readiness: BundleReadinessParams;
  readonly admission: BundleAdmission;
  /** Gasless deposit params (EIP-3009); null for bundles from older APIs. */
  readonly payment3009: BundlePayment3009 | null;
  readonly requiredSignatures: readonly ["buyer", "seller"];
  readonly relayActionTemplate: { readonly action: "fund"; readonly params: { readonly dealId: Hash } };
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

function sigOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error("Funding bundle: signature must be hex or null");
  return value;
}

function parseEnvelope(raw: unknown, field: string): TypedDataEnvelopeWire {
  const obj = asRecord(raw, field);
  const domain = asRecord(obj["domain"], `${field}.domain`);
  const typesRaw = asRecord(obj["types"], `${field}.types`);
  const types: Record<string, readonly { readonly name: string; readonly type: string }[]> = {};
  for (const [key, value] of Object.entries(typesRaw)) {
    if (!Array.isArray(value)) throw new Error(`Funding bundle: ${field}.types.${key} must be an array`);
    types[key] = value as readonly { readonly name: string; readonly type: string }[];
  }
  return {
    domain: {
      name: asString(domain["name"], `${field}.domain.name`),
      version: asString(domain["version"], `${field}.domain.version`),
      chainId: Number(toBigIntValue(domain["chainId"], `${field}.domain.chainId`)),
      verifyingContract: asAddress(domain["verifyingContract"], `${field}.domain.verifyingContract`),
    },
    types,
    primaryType: asString(obj["primaryType"], `${field}.primaryType`),
    message: asRecord(obj["message"], `${field}.message`),
  };
}

/** Strict operator-granted admission: complete struct or null (never partial). */
function parseGrantedAdmission(raw: unknown): AdmissionStruct | null {
  if (raw === undefined || raw === null) return null;
  const obj = asRecord(raw, "admission.granted");
  return {
    minPolicyId: asHash(required(obj, ["minPolicyId"], "minPolicyId"), "admission.granted.minPolicyId"),
    admissionNonce: asHash(required(obj, ["admissionNonce"], "admissionNonce"), "admission.granted.admissionNonce"),
    expiresAt: toBigIntValue(required(obj, ["expiresAt"], "expiresAt"), "admission.granted.expiresAt"),
    signature: asString(required(obj, ["signature"], "signature"), "admission.granted.signature"),
  };
}

/**
 * Parse + validate a raw funding-bundle response into a typed FundingBundle.
 * Keys are the exact canonical contract (@midman/api-client/src/funding.ts):
 * unknown aliases are rejected so API/web drift fails loudly instead of
 * producing null-filled bundles.
 */
export function parseFundingBundle(raw: unknown, draftId = ""): FundingBundle {
  const outer = asRecord(raw, "bundle");
  const data = isRecord(outer["bundle"]) ? asRecord(outer["bundle"], "bundle.bundle") : outer;

  const dealId = asHash(required(data, ["dealId"], "dealId"), "dealId");
  const chainId = Number(toBigIntValue(required(data, ["chainId"], "chainId"), "chainId"));
  const hub = asAddress(required(data, ["hub"], "hub"), "hub");
  const token = asAddress(required(data, ["token"], "token"), "token");
  const principalUnits = asUnits(required(data, ["principalUnits"], "principalUnits"), "principalUnits");
  const fundedUnits = asUnits(required(data, ["fundedUnits"], "fundedUnits"), "fundedUnits");
  const prepaidBuyerFeeUnits = asUnits(
    required(data, ["prepaidBuyerFeeUnits"], "prepaidBuyerFeeUnits"),
    "prepaidBuyerFeeUnits",
  );

  const agreementRaw = data["agreementDigest"];
  const agreementDigest =
    agreementRaw === undefined || agreementRaw === null ? null : asHash(agreementRaw, "agreementDigest");

  const fullTermsRaw = asRecord(required(data, ["fullTerms"], "fullTerms"), "fullTerms");
  const fullTerms = normalizeDealTerms(fullTermsRaw);

  const typedDeclared = parseDealTermsTypedData(
    required(data, ["dealTermsTypedData"], "dealTermsTypedData"),
    { chainId, hub, message: fullTermsRaw },
  );
  assertCanonicalDealTermsTypedData(typedDeclared);
  const dealTermsTypedData: DealTermsTypedData = {
    domain: typedDeclared.domain,
    types: typedDeclared.types,
    primaryType: typedDeclared.primaryType,
    message: normalizeTypedDataMessage(typedDeclared.message),
  };

  const sigs = asRecord(required(data, ["signatures"], "signatures"), "signatures");

  const allowanceRaw = asRecord(required(data, ["allowance"], "allowance"), "allowance");
  const allowance: BundleAllowanceParams = {
    paymentSalt: asHash(required(allowanceRaw, ["paymentSalt"], "paymentSalt"), "allowance.paymentSalt"),
    nonce: asHash(required(allowanceRaw, ["nonce"], "nonce"), "allowance.nonce"),
    expiresAt: toBigIntValue(required(allowanceRaw, ["expiresAt"], "expiresAt"), "allowance.expiresAt"),
    typedData: parseEnvelope(required(allowanceRaw, ["typedData"], "typedData"), "allowance.typedData"),
  };

  const readinessRaw = asRecord(required(data, ["readiness"], "readiness"), "readiness");
  const requiredFlag = readinessRaw["required"];
  if (requiredFlag !== true && requiredFlag !== false && requiredFlag !== null)
    throw new Error("Funding bundle: readiness.required must be true, false, or null");
  const readinessTypedRaw = readinessRaw["typedData"];
  const readiness: BundleReadinessParams = {
    required: requiredFlag,
    note: asString(required(readinessRaw, ["note"], "note"), "readiness.note"),
    attestedAt: toBigIntValue(required(readinessRaw, ["attestedAt"], "attestedAt"), "readiness.attestedAt"),
    nonce: asHash(required(readinessRaw, ["nonce"], "nonce"), "readiness.nonce"),
    expiresAt: toBigIntValue(required(readinessRaw, ["expiresAt"], "expiresAt"), "readiness.expiresAt"),
    typedData:
      readinessTypedRaw === undefined || readinessTypedRaw === null
        ? null
        : parseEnvelope(readinessTypedRaw, "readiness.typedData"),
  };

  const admissionRaw = asRecord(required(data, ["admission"], "admission"), "admission");
  const admission: BundleAdmission = {
    note: asString(required(admissionRaw, ["note"], "note"), "admission.note"),
    granted: parseGrantedAdmission(admissionRaw["granted"]),
  };

  let payment3009: BundlePayment3009 | null = null;
  if (isRecord(data["payment3009"])) {
    const raw3009 = data["payment3009"] as Record<string, unknown>;
    payment3009 = {
      from: asAddress(raw3009["from"], "payment3009.from"),
      to: asAddress(raw3009["to"], "payment3009.to"),
      value: toBigIntValue(raw3009["value"], "payment3009.value"),
      validAfter: toBigIntValue(raw3009["validAfter"], "payment3009.validAfter"),
      validBefore: toBigIntValue(raw3009["validBefore"], "payment3009.validBefore"),
      paymentSalt: asHash(raw3009["paymentSalt"], "payment3009.paymentSalt"),
      nonce: asHash(raw3009["nonce"], "payment3009.nonce"),
    };
    if (payment3009.to.toLowerCase() !== hub.toLowerCase()) throw new Error("Funding bundle: payment3009.to must be the hub");
    if (payment3009.value.toString() !== fundedUnits) throw new Error("Funding bundle: payment3009.value must equal fundedUnits");
  }

  const requiredSigs = data["requiredSignatures"];
  if (
    !Array.isArray(requiredSigs) ||
    requiredSigs.length !== 2 ||
    requiredSigs[0] !== "buyer" ||
    requiredSigs[1] !== "seller"
  )
    throw new Error('Funding bundle: requiredSignatures must be ["buyer", "seller"]');

  const template = asRecord(required(data, ["relayActionTemplate"], "relayActionTemplate"), "relayActionTemplate");
  if (template["action"] !== "fund") throw new Error('Funding bundle: relayActionTemplate.action must be "fund"');
  const templateParams = asRecord(template["params"], "relayActionTemplate.params");

  return {
    draftId: draftId || (typeof data["draftId"] === "string" ? (data["draftId"] as string) : ""),
    dealId,
    agreementDigest,
    chainId,
    hub,
    token,
    principalUnits,
    fundedUnits,
    prepaidBuyerFeeUnits,
    dealTermsTypedData,
    fullTerms,
    signatures: { buyer: sigOrNull(sigs["buyer"]), seller: sigOrNull(sigs["seller"]) },
    allowance,
    readiness,
    admission,
    payment3009,
    requiredSignatures: ["buyer", "seller"],
    relayActionTemplate: {
      action: "fund",
      params: { dealId: asHash(templateParams["dealId"], "relayActionTemplate.params.dealId") },
    },
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

// ---- Gasless deposit (EIP-3009 ReceiveWithAuthorization) ----

export interface Payment3009Signature {
  readonly v: number;
  readonly r: Hash;
  readonly s: Hash;
}

export interface TokenDomain {
  readonly name: string;
  readonly version: string;
}

const RECEIVE_WITH_AUTHORIZATION_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

const TOKEN_DOMAIN_ABI = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

/**
 * The token's own EIP-712 domain: EIP-5267 eip712Domain() when available,
 * else name() + version() (native USDC exposes both; Base mainnet USDC is
 * "USD Coin" / "2"). Read from chain so the signature always matches the
 * deployed token instead of a hard-coded name.
 */
export async function readTokenDomain(token: Address, deps: FundingDeps = {}): Promise<TokenDomain> {
  const client = publicOf(deps);
  if (typeof client.readContract !== "function") throw new Error("Funding: no public client to read the token domain");
  try {
    const domain = (await client.readContract({
      address: token,
      abi: TOKEN_DOMAIN_ABI,
      functionName: "eip712Domain",
      args: [],
    })) as readonly unknown[];
    if (typeof domain[1] === "string" && typeof domain[2] === "string") return { name: domain[1], version: domain[2] };
  } catch {
    // Not EIP-5267: fall back to name()/version().
  }
  const name = (await client.readContract({ address: token, abi: TOKEN_DOMAIN_ABI, functionName: "name", args: [] })) as string;
  const version = (await client.readContract({ address: token, abi: TOKEN_DOMAIN_ABI, functionName: "version", args: [] })) as string;
  return { name, version };
}

/** Split a 65-byte ECDSA signature into (v, r, s) for the 3009 v/r/s entrypoint. */
export function splitSignature(signature: string): Payment3009Signature {
  const hex = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (hex.length !== 130) {
    throw new Error("Gasless deposits need a standard wallet signature. Use the approve path instead.");
  }
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { r: `0x${hex.slice(0, 64)}` as Hash, s: `0x${hex.slice(64, 128)}` as Hash, v };
}

/**
 * Sign USDC's ReceiveWithAuthorization for the bundle's exact deposit. Only
 * the hub can redeem it (receive* requires msg.sender == to), only for this
 * amount, and the nonce binds it to this deal's terms.
 */
export async function signPayment3009(
  account: Address,
  bundle: FundingBundle,
  deps: FundingDeps & { readonly tokenDomain?: TokenDomain } = {},
): Promise<Payment3009Signature> {
  const p = bundle.payment3009;
  if (!p) throw new Error("Funding: this deal has no gasless deposit parameters");
  if (account.toLowerCase() !== p.from.toLowerCase()) throw new Error("Funding: only the buyer can authorize the deposit");
  const domain = deps.tokenDomain ?? (await readTokenDomain(bundle.token, deps));
  const client = walletOf(deps) as unknown as TypedDataSigner;
  const signature = (await client.signTypedData({
    account,
    domain: { name: domain.name, version: domain.version, chainId: bundle.chainId, verifyingContract: bundle.token },
    types: { ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION_FIELDS },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: p.from,
      to: p.to,
      value: p.value,
      validAfter: p.validAfter,
      validBefore: p.validBefore,
      nonce: p.nonce,
    },
  } as never)) as string;
  return splitSignature(signature);
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

// ---- Struct assembly (one path for relay + direct) ----

export interface FundStructSignatures {
  readonly buyer: string;
  readonly seller: string;
  /** Buyer FundWithAllowance signature (allowance path). Unused with `payment`. */
  readonly allowance?: string;
  /** Buyer EIP-3009 ReceiveWithAuthorization signature (gasless path). */
  readonly payment?: Payment3009Signature;
  /** Buyer ReadinessConsent signature. Required iff bundle.readiness.required. */
  readonly readiness?: string;
  /** Operator admission signature. Defaults to the bundle's granted admission. */
  readonly admission?: string;
}

export interface RelayStructs {
  readonly pay: PaymentStruct;
  readonly allowance: AllowanceStruct;
  readonly admission: AdmissionStruct;
  readonly readiness: ReadinessStruct;
}

function assertSig(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value === "" || value === "0x")
    throw new Error(`Funding: ${field} signature is required`);
  return value;
}

/**
 * Assemble the four completed on-chain structs from bundle params plus
 * wallet/operator signatures. Readiness without a signature is only allowed
 * when the policy does not require consent (the hub ignores that slot);
 * ABSENT_SIGNATURE marks the ignored slot explicitly.
 */
export function assembleStructs(bundle: FundingBundle, sigs: FundStructSignatures): RelayStructs {
  const gasless = sigs.payment !== undefined;
  if (gasless && !bundle.payment3009) throw new Error("Funding: this deal has no gasless deposit parameters");
  const allowanceSig = gasless ? ABSENT_SIGNATURE : assertSig(sigs.allowance, "allowance intent");
  const granted = bundle.admission.granted;
  if (!granted) throw new Error("Funding: operator-granted admission is missing");
  const admissionSig = sigs.admission ?? granted.signature;
  if (!admissionSig || admissionSig === "0x")
    throw new Error("Funding: admission signature is missing");
  let readiness: ReadinessStruct;
  if (sigs.readiness) {
    readiness = {
      attestedAt: bundle.readiness.attestedAt,
      nonce: bundle.readiness.nonce,
      expiresAt: bundle.readiness.expiresAt,
      signature: sigs.readiness,
    };
  } else if (bundle.readiness.required === false) {
    readiness = { attestedAt: 0n, nonce: ZERO_HASH, expiresAt: 0n, signature: ABSENT_SIGNATURE };
  } else {
    throw new Error("Funding: readiness consent signature is required for this deal");
  }
  return {
    // Gasless: the hub pulls USDC with receiveWithAuthorization and ignores
    // the allowance struct. Otherwise the allowance intent authorizes
    // transferFrom and the payment struct is ignored.
    pay:
      gasless && bundle.payment3009 && sigs.payment
        ? {
            validAfter: bundle.payment3009.validAfter,
            validBefore: bundle.payment3009.validBefore,
            paymentSalt: bundle.payment3009.paymentSalt,
            v: sigs.payment.v,
            r: sigs.payment.r,
            s: sigs.payment.s,
            use3009: true,
          }
        : zeroPayment(),
    allowance: gasless
      ? { paymentSalt: ZERO_HASH, nonce: ZERO_HASH, expiresAt: 0n, signature: ABSENT_SIGNATURE }
      : {
          paymentSalt: bundle.allowance.paymentSalt,
          nonce: bundle.allowance.nonce,
          expiresAt: bundle.allowance.expiresAt,
          signature: allowanceSig,
        },
    admission: { ...granted, signature: admissionSig },
    readiness,
  };
}

// ---- Calldata ----

function zeroPayment(): PaymentStruct {
  return { validAfter: 0n, validBefore: 0n, paymentSalt: ZERO_HASH, v: 0, r: ZERO_HASH, s: ZERO_HASH, use3009: false };
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
 * all wallet/operator signatures. This is the only direct call the hub
 * accepts for a newly funded deal (finding #6: the web must not stop at
 * approve()). Byte-identical to what the API enqueues for the same inputs.
 */
export function buildFundCalldata(bundle: FundingBundle, sigs: FundStructSignatures): Hash {
  const buyer = assertSig(sigs.buyer, "buyer DealTerms");
  const seller = assertSig(sigs.seller, "seller DealTerms");
  const structs = assembleStructs(bundle, sigs);
  const terms = normalizeDealTerms(bundle.fullTerms);
  const args = [
    terms,
    buyer as `0x${string}`,
    seller as `0x${string}`,
    structs.pay,
    structs.allowance,
    structs.admission,
    structs.readiness,
  ];
  return encodeFunctionData({
    abi: HUB_ABI,
    functionName: "fund",
    args: args as never,
  } as unknown as Parameters<typeof encodeFunctionData>[0]) as Hash;
}

// ---- Sponsored relay path (canonical API contract) ----

export interface RelayFundResult {
  readonly idempotencyKey: string;
  readonly inserted: boolean;
  readonly status: string;
}

function newIdempotencyKey(prefix: string, seed: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${seed.slice(0, 16)}-${Date.now()}-${rand}`;
}

function wireUnits(value: bigint): string {
  return value.toString();
}

/**
 * Assemble the exact POST /drafts/:id/relay-fund body (canonical contract):
 * sigBuyer/sigSeller plus the four completed structs with decimal-string
 * uints. Throws when a required signature is missing instead of posting a
 * payload the API would reject.
 */
export function assembleRelayPayload(
  bundle: FundingBundle,
  sigs: FundStructSignatures,
  idempotencyKey = newIdempotencyKey("fund", bundle.draftId),
): CanonicalRelayFundPayload {
  const buyer = assertSig(sigs.buyer, "buyer DealTerms");
  const seller = assertSig(sigs.seller, "seller DealTerms");
  const s = assembleStructs(bundle, sigs);
  return {
    idempotencyKey,
    sigBuyer: buyer,
    sigSeller: seller,
    pay: {
      validAfter: wireUnits(s.pay.validAfter),
      validBefore: wireUnits(s.pay.validBefore),
      paymentSalt: s.pay.paymentSalt,
      v: String(s.pay.v),
      r: s.pay.r,
      s: s.pay.s,
      use3009: s.pay.use3009,
    },
    allowance: {
      paymentSalt: s.allowance.paymentSalt,
      nonce: s.allowance.nonce,
      expiresAt: wireUnits(s.allowance.expiresAt),
      signature: s.allowance.signature,
    },
    admission: {
      minPolicyId: s.admission.minPolicyId,
      admissionNonce: s.admission.admissionNonce,
      expiresAt: wireUnits(s.admission.expiresAt),
      signature: s.admission.signature,
    },
    readiness: {
      attestedAt: wireUnits(s.readiness.attestedAt),
      nonce: s.readiness.nonce,
      expiresAt: wireUnits(s.readiness.expiresAt),
      signature: s.readiness.signature,
    },
  };
}

/**
 * Hand the funding bundle to the sponsored relayer. The idempotency key makes
 * retries safe: a repeated key never double-funds. A returned status is NOT
 * inclusion — wait for the receipt + DealFunded event (waitForFundingEvent).
 */
export function submitRelayFund(
  draftId: string,
  payload: CanonicalRelayFundPayload,
  deps: FundingDeps = {},
): Promise<RelayFundResult> {
  const body: Record<string, unknown> = { ...payload };
  if (typeof body["idempotencyKey"] !== "string" || body["idempotencyKey"] === "") {
    body["idempotencyKey"] = newIdempotencyKey("fund", draftId);
  }
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
  // Allowance path only: the buyer must approve the hub unless on-chain
  // allowance already covers it (the EIP-3009 path never needs approval).
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
  sigs: FundStructSignatures,
  deps: FundingDeps = {},
): Promise<DirectFundResult> {
  const wallet = walletOf(deps);
  await ensureChainId(wallet as unknown as { getChainId(): Promise<number> }, bundle.chainId);

  const payer = deps.account ?? (await getAccount());
  const publicClient = publicOf(deps);

  let approveTxHash: Hash | null = null;
  // A 3009 authorization moves the USDC itself: no approve transaction.
  if (sigs.payment === undefined && (await requiresApproval(bundle, payer, deps))) {
    const approveData = buildApproveCalldata(bundle.hub, bundle.fundedUnits);
    const approveReceipt = await waitForReceipt(await wallet.sendTransaction({ account: payer, to: bundle.token, data: approveData }), {
      publicClient,
    });
    approveTxHash = approveReceipt.transactionHash;
  }

  const fundData = buildFundCalldata(bundle, sigs);
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
