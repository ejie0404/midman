// Canonical funding-bundle + relay-fund contract between the API and the web.
//
// EXACT field names — no aliases. The API produces these shapes, the web
// consumes them, and the suites assert them. A rename must change all three
// sides together (packages/api-client, apps/api, apps/web).
//
// Transport conventions (same as schemas.ts): money and uints are decimal
// digit strings (JSON has no bigint), hashes are 0x+64 hex, addresses are
// 0x+40 hex, signatures are 0x-prefixed hex of any length, timestamps and
// expiries are decimal unix-second strings.
//
// `ABSENT_SIGNATURE` ("0x00") is the placeholder for struct slots the hub
// provably ignores (readiness when the policy does not require consent). It
// is never a valid authorization; the API's strict hex checks accept it as
// data, and the contract never verifies an ignored slot.

import { ApiValidationError } from "./schemas.js";

export const ABSENT_SIGNATURE = "0x00";

const UNITS_RE = /^[0-9]+$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEXSIG_RE = /^0x[0-9a-fA-F]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ApiValidationError(path, "expected an object");
  return value;
}

function needString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "")
    throw new ApiValidationError(`${path}.${key}`, "expected a non-empty string");
  return value;
}

function needUnits(obj: Record<string, unknown>, key: string, path: string): string {
  const value = needString(obj, key, path);
  if (!UNITS_RE.test(value)) throw new ApiValidationError(`${path}.${key}`, "expected decimal units");
  return value;
}

function needHash(obj: Record<string, unknown>, key: string, path: string): string {
  const value = needString(obj, key, path);
  if (!HASH_RE.test(value)) throw new ApiValidationError(`${path}.${key}`, "expected bytes32 hex");
  return value;
}

function needAddress(obj: Record<string, unknown>, key: string, path: string): string {
  const value = needString(obj, key, path);
  if (!ADDRESS_RE.test(value)) throw new ApiValidationError(`${path}.${key}`, "expected an address");
  return value;
}

function needHexSig(obj: Record<string, unknown>, key: string, path: string): string {
  const value = needString(obj, key, path);
  if (!HEXSIG_RE.test(value)) throw new ApiValidationError(`${path}.${key}`, "expected a hex signature");
  return value;
}

function needBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") throw new ApiValidationError(`${path}.${key}`, "expected a boolean");
  return value;
}

// ---- Typed-data envelopes ----

export interface TypedDataEnvelope {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: string;
  };
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  /** Wire form: uints are decimal strings, bytes are hex, flags are booleans. */
  readonly message: Record<string, string | boolean>;
}

export function validateTypedDataEnvelope(value: unknown, path: string): TypedDataEnvelope {
  const obj = needRecord(value, path);
  const domain = needRecord(obj["domain"], `${path}.domain`);
  const chainId = domain["chainId"];
  if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0)
    throw new ApiValidationError(`${path}.domain.chainId`, "expected a positive integer");
  const types = needRecord(obj["types"], `${path}.types`);
  for (const [key, entries] of Object.entries(types)) {
    if (!Array.isArray(entries)) throw new ApiValidationError(`${path}.types.${key}`, "expected an array");
    for (const entry of entries) {
      const rec = needRecord(entry, `${path}.types.${key}[]`);
      if (typeof rec["name"] !== "string" || typeof rec["type"] !== "string")
        throw new ApiValidationError(`${path}.types.${key}[]`, "expected {name, type} strings");
    }
  }
  const message = needRecord(obj["message"], `${path}.message`);
  for (const [key, entry] of Object.entries(message)) {
    if (typeof entry !== "string" && typeof entry !== "boolean")
      throw new ApiValidationError(`${path}.message.${key}`, "expected a string or boolean");
  }
  return {
    domain: {
      name: needString(domain, "name", `${path}.domain`),
      version: needString(domain, "version", `${path}.domain`),
      chainId,
      verifyingContract: needAddress(domain, "verifyingContract", `${path}.domain`),
    },
    types: types as TypedDataEnvelope["types"],
    primaryType: needString(obj, "primaryType", path),
    message: message as Record<string, string | boolean>,
  };
}

// ---- Completed on-chain structs (relay/decode transport) ----

export interface PaymentStruct {
  readonly validAfter: string;
  readonly validBefore: string;
  readonly paymentSalt: string;
  readonly v: string;
  readonly r: string;
  readonly s: string;
  readonly use3009: boolean;
}

export interface AllowanceStruct {
  readonly paymentSalt: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export interface AdmissionStruct {
  readonly minPolicyId: string;
  readonly admissionNonce: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export interface ReadinessStruct {
  readonly attestedAt: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly signature: string;
}

function validatePaymentStruct(value: unknown, path: string): PaymentStruct {
  const obj = needRecord(value, path);
  return {
    validAfter: needUnits(obj, "validAfter", path),
    validBefore: needUnits(obj, "validBefore", path),
    paymentSalt: needHash(obj, "paymentSalt", path),
    v: needUnits(obj, "v", path),
    r: needHash(obj, "r", path),
    s: needHash(obj, "s", path),
    use3009: needBoolean(obj, "use3009", path),
  };
}

function validateAllowanceStruct(value: unknown, path: string): AllowanceStruct {
  const obj = needRecord(value, path);
  return {
    paymentSalt: needHash(obj, "paymentSalt", path),
    nonce: needHash(obj, "nonce", path),
    expiresAt: needUnits(obj, "expiresAt", path),
    signature: needHexSig(obj, "signature", path),
  };
}

export function validateAdmissionStruct(value: unknown, path = "admission"): AdmissionStruct {
  const obj = needRecord(value, path);
  return {
    minPolicyId: needHash(obj, "minPolicyId", path),
    admissionNonce: needHash(obj, "admissionNonce", path),
    expiresAt: needUnits(obj, "expiresAt", path),
    signature: needHexSig(obj, "signature", path),
  };
}

export function isAdmissionStruct(value: unknown): value is AdmissionStruct {
  try {
    validateAdmissionStruct(value);
    return true;
  } catch {
    return false;
  }
}

function validateReadinessStruct(value: unknown, path: string): ReadinessStruct {
  const obj = needRecord(value, path);
  return {
    attestedAt: needUnits(obj, "attestedAt", path),
    nonce: needHash(obj, "nonce", path),
    expiresAt: needUnits(obj, "expiresAt", path),
    signature: needHexSig(obj, "signature", path),
  };
}

// ---- Funding bundle (GET /drafts/:id/funding-bundle) ----

export interface FundingBundleSignatures {
  readonly buyer: string | null;
  readonly seller: string | null;
}

export interface FundingBundle {
  readonly draftId: string;
  readonly dealId: string;
  readonly chainId: number;
  readonly hub: string;
  readonly token: string;
  readonly principalUnits: string;
  readonly fundedUnits: string;
  readonly prepaidBuyerFeeUnits: string;
  readonly agreementDigest: string | null;
  readonly fullTerms: Record<string, string>;
  readonly dealTermsTypedData: TypedDataEnvelope;
  readonly signatures: FundingBundleSignatures;
  readonly allowance: {
    readonly paymentSalt: string;
    readonly nonce: string;
    readonly expiresAt: string;
    readonly typedData: TypedDataEnvelope;
  };
  readonly readiness: {
    readonly required: boolean | null;
    readonly note: string;
    readonly attestedAt: string;
    readonly nonce: string;
    readonly expiresAt: string;
    readonly typedData: TypedDataEnvelope | null;
  };
  readonly admission: {
    readonly note: string;
    readonly granted: AdmissionStruct | null;
  };
  readonly requiredSignatures: readonly ["buyer", "seller"];
  readonly relayActionTemplate: { readonly action: "fund"; readonly params: { readonly dealId: string } };
}

function needHexSigOrNull(obj: Record<string, unknown>, key: string, path: string): string | null {
  const value = obj[key];
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !HEXSIG_RE.test(value))
    throw new ApiValidationError(`${path}.${key}`, "expected a hex signature or null");
  return value;
}

export function validateFundingBundle(value: unknown, path = "funding-bundle"): FundingBundle {
  const obj = needRecord(value, path);
  const chainId = obj["chainId"];
  if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0)
    throw new ApiValidationError(`${path}.chainId`, "expected a positive integer");

  const fullTermsRaw = needRecord(obj["fullTerms"], `${path}.fullTerms`);
  const fullTerms: Record<string, string> = {};
  for (const [key, entry] of Object.entries(fullTermsRaw)) {
    if (typeof entry !== "string") throw new ApiValidationError(`${path}.fullTerms.${key}`, "expected a string");
    fullTerms[key] = entry;
  }

  const sigs = needRecord(obj["signatures"], `${path}.signatures`);
  const allowance = needRecord(obj["allowance"], `${path}.allowance`);
  const readiness = needRecord(obj["readiness"], `${path}.readiness`);
  const admission = needRecord(obj["admission"], `${path}.admission`);

  const agreementRaw = obj["agreementDigest"];
  const readinessTypedRaw = readiness["typedData"];
  const grantedRaw = admission["granted"];

  const required = readiness["required"];
  if (required !== true && required !== false && required !== null)
    throw new ApiValidationError(`${path}.readiness.required`, "expected true, false, or null");

  const requiredSignatures = obj["requiredSignatures"];
  if (
    !Array.isArray(requiredSignatures) ||
    requiredSignatures.length !== 2 ||
    requiredSignatures[0] !== "buyer" ||
    requiredSignatures[1] !== "seller"
  )
    throw new ApiValidationError(`${path}.requiredSignatures`, 'expected ["buyer", "seller"]');

  const template = needRecord(obj["relayActionTemplate"], `${path}.relayActionTemplate`);
  if (template["action"] !== "fund")
    throw new ApiValidationError(`${path}.relayActionTemplate.action`, 'expected "fund"');
  const templateParams = needRecord(template["params"], `${path}.relayActionTemplate.params`);

  return {
    draftId: needString(obj, "draftId", path),
    dealId: needHash(obj, "dealId", path),
    chainId,
    hub: needAddress(obj, "hub", path),
    token: needAddress(obj, "token", path),
    principalUnits: needUnits(obj, "principalUnits", path),
    fundedUnits: needUnits(obj, "fundedUnits", path),
    prepaidBuyerFeeUnits: needUnits(obj, "prepaidBuyerFeeUnits", path),
    agreementDigest:
      agreementRaw === null || agreementRaw === undefined ? null : needHash(obj, "agreementDigest", path),
    fullTerms,
    dealTermsTypedData: validateTypedDataEnvelope(obj["dealTermsTypedData"], `${path}.dealTermsTypedData`),
    signatures: {
      buyer: needHexSigOrNull(sigs, "buyer", `${path}.signatures`),
      seller: needHexSigOrNull(sigs, "seller", `${path}.signatures`),
    },
    allowance: {
      paymentSalt: needHash(allowance, "paymentSalt", `${path}.allowance`),
      nonce: needHash(allowance, "nonce", `${path}.allowance`),
      expiresAt: needUnits(allowance, "expiresAt", `${path}.allowance`),
      typedData: validateTypedDataEnvelope(allowance["typedData"], `${path}.allowance.typedData`),
    },
    readiness: {
      required,
      note: needString(readiness, "note", `${path}.readiness`),
      attestedAt: needUnits(readiness, "attestedAt", `${path}.readiness`),
      nonce: needHash(readiness, "nonce", `${path}.readiness`),
      expiresAt: needUnits(readiness, "expiresAt", `${path}.readiness`),
      typedData:
        readinessTypedRaw === null || readinessTypedRaw === undefined
          ? null
          : validateTypedDataEnvelope(readinessTypedRaw, `${path}.readiness.typedData`),
    },
    admission: {
      note: needString(admission, "note", `${path}.admission`),
      granted:
        grantedRaw === null || grantedRaw === undefined
          ? null
          : validateAdmissionStruct(grantedRaw, `${path}.admission.granted`),
    },
    requiredSignatures: ["buyer", "seller"],
    relayActionTemplate: {
      action: "fund",
      params: { dealId: needHash(templateParams, "dealId", `${path}.relayActionTemplate.params`) },
    },
  };
}

// ---- Relay-fund payload (POST /drafts/:id/relay-fund) ----

export interface RelayFundPayload {
  readonly idempotencyKey: string;
  readonly sigBuyer: string;
  readonly sigSeller: string;
  readonly pay: PaymentStruct;
  readonly allowance: AllowanceStruct;
  readonly admission: AdmissionStruct;
  readonly readiness: ReadinessStruct;
}

export function validateRelayFundPayload(value: unknown, path = "relay-fund"): RelayFundPayload {
  const obj = needRecord(value, path);
  return {
    idempotencyKey: needString(obj, "idempotencyKey", path),
    sigBuyer: needHexSig(obj, "sigBuyer", path),
    sigSeller: needHexSig(obj, "sigSeller", path),
    pay: validatePaymentStruct(obj["pay"], `${path}.pay`),
    allowance: validateAllowanceStruct(obj["allowance"], `${path}.allowance`),
    admission: validateAdmissionStruct(obj["admission"], `${path}.admission`),
    readiness: validateReadinessStruct(obj["readiness"], `${path}.readiness`),
  };
}
