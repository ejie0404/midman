// Validated API resource shapes for the Midman V1 HTTP surface.
//
// Every validator here mirrors the route implementation EXACTLY (apps/api/src):
// routes.ts, journey.ts, evidence/routes.ts, categories/routes.ts,
// review/routes.ts (+ awards/approvals/proposals/registry), server.ts.
// The web app keeps its own shape guards as defense-in-depth; this package is
// the single validated definition + typed client.
//
// Convention: `validateX(value, path?)` returns the typed value or throws
// ApiValidationError (message always carries `path`). `isX(value)` predicates
// never throw. Money = decimal strings (/^[0-9]+$/), hashes = 0x+64 hex,
// addresses = 0x+40 hex.

export class ApiValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ApiValidationError";
    this.path = path;
  }
}

const UNITS_RE = /^[0-9]+$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ApiValidationError(path, "expected an object");
  return value;
}

function needString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new ApiValidationError(`${path}.${key}`, "expected a string");
  return value;
}

function optString(obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiValidationError(`${path}.${key}`, "expected a string");
  return value;
}

function needNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiValidationError(`${path}.${key}`, "expected a number");
  }
  return value;
}

function needBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") throw new ApiValidationError(`${path}.${key}`, "expected a boolean");
  return value;
}

function needArray(obj: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) throw new ApiValidationError(`${path}.${key}`, "expected an array");
  return value;
}

function needUnits(obj: Record<string, unknown>, key: string, path: string): string {
  const value = needString(obj, key, path);
  if (!UNITS_RE.test(value)) throw new ApiValidationError(`${path}.${key}`, "expected decimal units string");
  return value;
}

function needHash(obj: Record<string, unknown>, key: string, path: string): string {
  const value = needString(obj, key, path);
  if (!HASH_RE.test(value)) throw new ApiValidationError(`${path}.${key}`, "expected 0x + 64 hex");
  return value;
}

function needAddress(obj: Record<string, unknown>, key: string, path: string): string {
  const value = needString(obj, key, path);
  if (!ADDRESS_RE.test(value)) throw new ApiValidationError(`${path}.${key}`, "expected 0x + 40 hex address");
  return value;
}

function needHex(obj: Record<string, unknown>, key: string, path: string): string {
  const value = needString(obj, key, path);
  if (!HEX_RE.test(value)) throw new ApiValidationError(`${path}.${key}`, "expected 0x hex");
  return value;
}

function optHashOrNull(obj: Record<string, unknown>, key: string, path: string): string | null {
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new ApiValidationError(`${path}.${key}`, "expected 0x + 64 hex or null");
  }
  return value;
}

function needStringRecord(value: unknown, path: string): Record<string, string> {
  const obj = needRecord(value, path);
  for (const [key, entry] of Object.entries(obj)) {
    if (typeof entry !== "string") throw new ApiValidationError(`${path}.${key}`, "expected a string");
  }
  return obj as Record<string, string>;
}

function needStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ApiValidationError(path, "expected an array");
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== "string") throw new ApiValidationError(`${path}[${i}]`, "expected a string");
  }
  return value as string[];
}

function tryParse<T>(parse: (value: unknown, path: string) => T, value: unknown): T | null {
  try {
    return parse(value, "$");
  } catch {
    return null;
  }
}

// ---- Primitives ------------------------------------------------------------

export type ConfirmationLevel = "pending" | "included" | "safe" | "finalized";
const CONFIRMATION_LEVELS: readonly string[] = ["pending", "included", "safe", "finalized"];

export function validateConfirmationLevel(value: unknown, path = "$"): ConfirmationLevel {
  if (typeof value !== "string" || !CONFIRMATION_LEVELS.includes(value)) {
    throw new ApiValidationError(path, "expected pending|included|safe|finalized");
  }
  return value as ConfirmationLevel;
}

export type DealSource = "chain" | "projection" | "draft";

export function validateDealSource(value: unknown, path = "$"): DealSource {
  if (value !== "chain" && value !== "projection" && value !== "draft") {
    throw new ApiValidationError(path, "expected chain|projection|draft");
  }
  return value;
}

export function isConfirmationLevel(value: unknown): value is ConfirmationLevel {
  return tryParse(validateConfirmationLevel, value) !== null;
}

export function isDealSource(value: unknown): value is DealSource {
  return tryParse(validateDealSource, value) !== null;
}

export function isDealStatus(value: unknown): value is DealStatus {
  return tryParse(validateDealStatus, value) !== null;
}

// ---- Drafts ----------------------------------------------------------------

export interface CanonicalTerms extends Record<string, string> {
  readonly dealId: string;
  readonly buyer: string;
  readonly seller: string;
  readonly principalUnits: string;
  readonly quotedFeeUnits: string;
  readonly prepaidBuyerFeeUnits: string;
  readonly fundedUnits: string;
  readonly buyerFeeBps: string;
  readonly deliverySeconds: string;
  readonly inspectionSeconds: string;
  readonly fundingDeadline: string;
  readonly readinessConsentHash: string;
  readonly nonce: string;
  readonly salt: string;
  readonly chainId: string;
  readonly hub: string;
  readonly token: string;
  readonly category: string;
  readonly agreementHash: string;
}

const CANONICAL_MONEY_KEYS = [
  "principalUnits",
  "quotedFeeUnits",
  "prepaidBuyerFeeUnits",
  "fundedUnits",
  "buyerFeeBps",
  "deliverySeconds",
  "inspectionSeconds",
  "fundingDeadline",
] as const;

export function validateCanonicalTerms(value: unknown, path = "$"): CanonicalTerms {
  const obj = needRecord(value, path);
  // Exact implementation shape (apps/api/src/terms.ts buildCanonicalTerms).
  needHash(obj, "dealId", path);
  needAddress(obj, "buyer", path);
  needAddress(obj, "seller", path);
  for (const key of CANONICAL_MONEY_KEYS) needUnits(obj, key, path);
  needHash(obj, "readinessConsentHash", path);
  needHash(obj, "nonce", path);
  needHash(obj, "salt", path);
  needUnits(obj, "chainId", path);
  needAddress(obj, "hub", path);
  needAddress(obj, "token", path);
  needString(obj, "category", path);
  needHash(obj, "agreementHash", path);
  return needStringRecord(value, path) as CanonicalTerms;
}

export interface Draft {
  readonly id: string;
  readonly dealId: string;
  readonly creatorWallet: string;
  readonly counterpartyHint: string | null;
  readonly counterpartyAddress: string | null;
  readonly terms: CanonicalTerms;
  readonly signatures: Record<string, string>;
  readonly admission: Record<string, string> | null;
  readonly revocationNote: Record<string, string> | null;
  readonly status: string;
}

export function validateDraft(value: unknown, path = "$"): Draft {
  const obj = needRecord(value, path);
  const id = needString(obj, "id", path);
  const dealId = needHash(obj, "dealId", path);
  const creatorWallet = needString(obj, "creatorWallet", path);
  const hint = obj["counterpartyHint"];
  if (hint !== null && typeof hint !== "string") {
    throw new ApiValidationError(`${path}.counterpartyHint`, "expected a string or null");
  }
  const counterparty = obj["counterpartyAddress"];
  if (counterparty !== null && typeof counterparty !== "string") {
    throw new ApiValidationError(`${path}.counterpartyAddress`, "expected a string or null");
  }
  const terms = validateCanonicalTerms(obj["terms"], `${path}.terms`);
  const signatures = needStringRecord(obj["signatures"], `${path}.signatures`);
  const admissionRaw = obj["admission"];
  const admission =
    admissionRaw === null || admissionRaw === undefined
      ? null
      : needStringRecord(admissionRaw, `${path}.admission`);
  const noteRaw = obj["revocationNote"];
  const revocationNote =
    noteRaw === null || noteRaw === undefined ? null : needStringRecord(noteRaw, `${path}.revocationNote`);
  const status = needString(obj, "status", path);
  return {
    id,
    dealId,
    creatorWallet,
    counterpartyHint: hint as string | null,
    counterpartyAddress: counterparty as string | null,
    terms,
    signatures,
    admission,
    revocationNote,
    status,
  };
}

export interface CreateDraftResult {
  readonly id: string;
  readonly dealId: string;
  readonly terms: CanonicalTerms;
}

export function validateCreateDraftResult(value: unknown, path = "$"): CreateDraftResult {
  const obj = needRecord(value, path);
  return {
    id: needString(obj, "id", path),
    dealId: needHash(obj, "dealId", path),
    terms: validateCanonicalTerms(obj["terms"], `${path}.terms`),
  };
}

export interface Invitation {
  readonly invitationToken: string;
  readonly expiresAt: string;
}

export function validateInvitation(value: unknown, path = "$"): Invitation {
  const obj = needRecord(value, path);
  return { invitationToken: needString(obj, "invitationToken", path), expiresAt: needString(obj, "expiresAt", path) };
}

export interface AcceptDraftResult {
  readonly ok: true;
  readonly counterpartyAddress: string;
}

export function validateAcceptDraftResult(value: unknown, path = "$"): AcceptDraftResult {
  const obj = needRecord(value, path);
  if (obj["ok"] !== true) throw new ApiValidationError(`${path}.ok`, "expected true");
  return { ok: true, counterpartyAddress: needAddress(obj, "counterpartyAddress", path) };
}

export interface DraftTermsResult {
  readonly terms: CanonicalTerms;
  readonly signatures: Record<string, string>;
  readonly status: string;
}

export function validateDraftTermsResult(value: unknown, path = "$"): DraftTermsResult {
  const obj = needRecord(value, path);
  return {
    terms: validateCanonicalTerms(obj["terms"], `${path}.terms`),
    signatures: needStringRecord(obj["signatures"], `${path}.signatures`),
    status: needString(obj, "status", path),
  };
}

export interface AcceptanceSignature {
  readonly ok: true;
  readonly role: "buyer" | "seller";
}

export function validateAcceptanceSignature(value: unknown, path = "$"): AcceptanceSignature {
  const obj = needRecord(value, path);
  if (obj["ok"] !== true) throw new ApiValidationError(`${path}.ok`, "expected true");
  const role = needString(obj, "role", path);
  if (role !== "buyer" && role !== "seller") throw new ApiValidationError(`${path}.role`, "expected buyer|seller");
  return { ok: true, role };
}

export interface AdmissionResult {
  readonly ok: true;
}

export function validateAdmissionResult(value: unknown, path = "$"): AdmissionResult {
  const obj = needRecord(value, path);
  if (obj["ok"] !== true) throw new ApiValidationError(`${path}.ok`, "expected true");
  return { ok: true };
}

export interface RevocationNote {
  readonly ok: true;
  readonly note: { readonly by: string; readonly at: string };
  readonly pendingUntil: string;
}

export function validateRevocationNote(value: unknown, path = "$"): RevocationNote {
  const obj = needRecord(value, path);
  if (obj["ok"] !== true) throw new ApiValidationError(`${path}.ok`, "expected true");
  const note = needRecord(obj["note"], `${path}.note`);
  return {
    ok: true,
    note: { by: needString(note, "by", `${path}.note`), at: needString(note, "at", `${path}.note`) },
    pendingUntil: needString(obj, "pendingUntil", path),
  };
}

export interface SettlementQuote {
  readonly prepaidBuyerFee: string;
  readonly earnedFee: string;
  readonly buyerFee: string;
  readonly sellerFee: string;
  readonly buyerClaim: string;
  readonly sellerClaim: string;
  readonly funded: string;
  readonly source: string;
}

export function validateSettlementQuote(value: unknown, path = "$"): SettlementQuote {
  const obj = needRecord(value, path);
  for (const key of ["prepaidBuyerFee", "earnedFee", "buyerFee", "sellerFee", "buyerClaim", "sellerClaim", "funded"] as const) {
    needUnits(obj, key, path);
  }
  return {
    prepaidBuyerFee: obj["prepaidBuyerFee"] as string,
    earnedFee: obj["earnedFee"] as string,
    buyerFee: obj["buyerFee"] as string,
    sellerFee: obj["sellerFee"] as string,
    buyerClaim: obj["buyerClaim"] as string,
    sellerClaim: obj["sellerClaim"] as string,
    funded: obj["funded"] as string,
    source: needString(obj, "source", path),
  };
}

// ---- Journey ----------------------------------------------------------------

export interface DraftSummary {
  readonly dealId: string;
  readonly parties: {
    readonly buyer: string;
    readonly seller: string;
    readonly payouts: {
      readonly sellerPayout: string;
      readonly buyerRefund: string;
      readonly buyerBondRefund: string;
      readonly sellerBondRefund: string;
    };
  };
  readonly amounts: {
    readonly principalUnits: string;
    readonly quotedFeeUnits: string;
    readonly fundedUnits: string;
    readonly effectiveFeeBps: string;
  };
  readonly schedule: {
    readonly deliverySeconds: string;
    readonly inspectionSeconds: string;
    readonly fundingDeadline: string;
  };
  readonly feeFormula: string;
  readonly dispute: {
    readonly oneFreeDispute: boolean;
    readonly negotiationHours: number;
    readonly escalationHours: number;
    readonly minBondUnits: string;
    readonly quorumTiers: string;
    readonly executionDelays: string;
  };
  readonly catastrophic: { readonly days: number; readonly split: string; readonly fees: string };
  readonly warnings: string[];
}

export function validateDraftSummary(value: unknown, path = "$"): DraftSummary {
  const obj = needRecord(value, path);
  const parties = needRecord(obj["parties"], `${path}.parties`);
  const payouts = needRecord(parties["payouts"], `${path}.parties.payouts`);
  const amounts = needRecord(obj["amounts"], `${path}.amounts`);
  const schedule = needRecord(obj["schedule"], `${path}.schedule`);
  const dispute = needRecord(obj["dispute"], `${path}.dispute`);
  const catastrophic = needRecord(obj["catastrophic"], `${path}.catastrophic`);
  return {
    dealId: needString(obj, "dealId", path),
    parties: {
      buyer: needString(parties, "buyer", `${path}.parties`),
      seller: needString(parties, "seller", `${path}.parties`),
      payouts: {
        sellerPayout: needString(payouts, "sellerPayout", `${path}.parties.payouts`),
        buyerRefund: needString(payouts, "buyerRefund", `${path}.parties.payouts`),
        buyerBondRefund: needString(payouts, "buyerBondRefund", `${path}.parties.payouts`),
        sellerBondRefund: needString(payouts, "sellerBondRefund", `${path}.parties.payouts`),
      },
    },
    amounts: {
      principalUnits: needUnits(amounts, "principalUnits", `${path}.amounts`),
      quotedFeeUnits: needUnits(amounts, "quotedFeeUnits", `${path}.amounts`),
      fundedUnits: needUnits(amounts, "fundedUnits", `${path}.amounts`),
      effectiveFeeBps: needUnits(amounts, "effectiveFeeBps", `${path}.amounts`),
    },
    schedule: {
      deliverySeconds: needString(schedule, "deliverySeconds", `${path}.schedule`),
      inspectionSeconds: needString(schedule, "inspectionSeconds", `${path}.schedule`),
      fundingDeadline: needString(schedule, "fundingDeadline", `${path}.schedule`),
    },
    feeFormula: needString(obj, "feeFormula", path),
    dispute: {
      oneFreeDispute: needBoolean(dispute, "oneFreeDispute", `${path}.dispute`),
      negotiationHours: needNumber(dispute, "negotiationHours", `${path}.dispute`),
      escalationHours: needNumber(dispute, "escalationHours", `${path}.dispute`),
      minBondUnits: needUnits(dispute, "minBondUnits", `${path}.dispute`),
      quorumTiers: needString(dispute, "quorumTiers", `${path}.dispute`),
      executionDelays: needString(dispute, "executionDelays", `${path}.dispute`),
    },
    catastrophic: {
      days: needNumber(catastrophic, "days", `${path}.catastrophic`),
      split: needString(catastrophic, "split", `${path}.catastrophic`),
      fees: needString(catastrophic, "fees", `${path}.catastrophic`),
    },
    warnings: needStringArray(obj["warnings"], `${path}.warnings`),
  };
}

export interface DraftDownload {
  readonly canonicalTerms: CanonicalTerms;
  readonly fullTerms: Record<string, unknown>;
  readonly agreementDigest: string;
  readonly signatures: Record<string, string>;
  readonly acceptanceTypedData: {
    readonly domain: Record<string, unknown>;
    readonly types: Record<string, unknown>;
    readonly primaryType: string;
    readonly message: Record<string, unknown>;
  };
  readonly exportedAt: string;
  readonly note: string;
}

export function validateDraftDownload(value: unknown, path = "$"): DraftDownload {
  const obj = needRecord(value, path);
  const typed = needRecord(obj["acceptanceTypedData"], `${path}.acceptanceTypedData`);
  return {
    canonicalTerms: validateCanonicalTerms(obj["canonicalTerms"], `${path}.canonicalTerms`),
    fullTerms: needRecord(obj["fullTerms"], `${path}.fullTerms`),
    agreementDigest: needHash(obj, "agreementDigest", path),
    signatures: needStringRecord(obj["signatures"], `${path}.signatures`),
    acceptanceTypedData: {
      domain: needRecord(typed["domain"], `${path}.acceptanceTypedData.domain`),
      types: needRecord(typed["types"], `${path}.acceptanceTypedData.types`),
      primaryType: needString(typed, "primaryType", `${path}.acceptanceTypedData`),
      message: needRecord(typed["message"], `${path}.acceptanceTypedData.message`),
    },
    exportedAt: needString(obj, "exportedAt", path),
    note: needString(obj, "note", path),
  };
}

export interface TxStatus {
  readonly txHash: string;
  readonly level: ConfirmationLevel;
  readonly status: string | null;
  readonly blockNumber: string | null;
  readonly safeBlock: string | null;
  readonly finalizedBlock: string | null;
}

export function validateTxStatus(value: unknown, path = "$"): TxStatus {
  const obj = needRecord(value, path);
  const statusRaw = obj["status"];
  if (statusRaw !== null && typeof statusRaw !== "string") {
    throw new ApiValidationError(`${path}.status`, "expected a string or null");
  }
  const block = (key: string): string | null => {
    const entry = obj[key];
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "string") throw new ApiValidationError(`${path}.${key}`, "expected a string or null");
    return entry;
  };
  return {
    txHash: needHash(obj, "txHash", path),
    level: validateConfirmationLevel(obj["level"], `${path}.level`),
    status: statusRaw as string | null,
    blockNumber: block("blockNumber"),
    safeBlock: block("safeBlock"),
    finalizedBlock: block("finalizedBlock"),
  };
}

export interface ReadinessPayload {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
  readonly types: Record<string, unknown>;
  readonly primaryType: "ReadinessConsent";
  readonly message: {
    readonly dealId: string;
    readonly agreementDigest: string;
    readonly buyer: string;
    readonly attestedAt: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
}

export function validateReadinessPayload(value: unknown, path = "$"): ReadinessPayload {
  const obj = needRecord(value, path);
  const domain = needRecord(obj["domain"], `${path}.domain`);
  const message = needRecord(obj["message"], `${path}.message`);
  const primaryType = needString(obj, "primaryType", path);
  if (primaryType !== "ReadinessConsent") throw new ApiValidationError(`${path}.primaryType`, "expected ReadinessConsent");
  return {
    domain: {
      name: needString(domain, "name", `${path}.domain`),
      version: needString(domain, "version", `${path}.domain`),
      chainId: needNumber(domain, "chainId", `${path}.domain`),
      verifyingContract: needString(domain, "verifyingContract", `${path}.domain`),
    },
    types: needRecord(obj["types"], `${path}.types`),
    primaryType: "ReadinessConsent",
    message: {
      dealId: needHash(message, "dealId", `${path}.message`),
      agreementDigest: needHash(message, "agreementDigest", `${path}.message`),
      buyer: needAddress(message, "buyer", `${path}.message`),
      attestedAt: needUnits(message, "attestedAt", `${path}.message`),
      nonce: needHash(message, "nonce", `${path}.message`),
      expiresAt: needUnits(message, "expiresAt", `${path}.message`),
    },
  };
}

// ---- Chain-first deal reads -------------------------------------------------

export interface ChainDealStatus {
  readonly dealId: string;
  readonly source: "chain";
  readonly phase: string;
  readonly fundedAt?: string | undefined;
  readonly deliveredAt?: string | undefined;
  readonly disputeOpenedAt?: string | undefined;
  readonly disputeUsed?: boolean | undefined;
  readonly events?: number | undefined;
}

export interface DraftDealStatus {
  readonly dealId: string;
  readonly source: "draft";
  readonly status: string;
  readonly terms: CanonicalTerms;
}

export interface ProjectionDealStatus {
  readonly dealId: string;
  readonly source: "projection";
  readonly phase: string;
  readonly events?: number | undefined;
}

export type DealStatus = ChainDealStatus | DraftDealStatus | ProjectionDealStatus;

export function validateDealStatus(value: unknown, path = "$"): DealStatus {
  const obj = needRecord(value, path);
  const dealId = needHash(obj, "dealId", path);
  const source = validateDealSource(obj["source"], `${path}.source`);
  if (source === "chain") {
    const out: ChainDealStatus = { dealId, source, phase: needString(obj, "phase", path) };
    const fundedAt = optString(obj, "fundedAt", path);
    const deliveredAt = optString(obj, "deliveredAt", path);
    const disputeOpenedAt = optString(obj, "disputeOpenedAt", path);
    const result: ChainDealStatus = { ...out };
    if (fundedAt !== undefined) (result as { fundedAt?: string }).fundedAt = fundedAt;
    if (deliveredAt !== undefined) (result as { deliveredAt?: string }).deliveredAt = deliveredAt;
    if (disputeOpenedAt !== undefined) (result as { disputeOpenedAt?: string }).disputeOpenedAt = disputeOpenedAt;
    if (typeof obj["disputeUsed"] === "boolean") {
      (result as { disputeUsed?: boolean }).disputeUsed = obj["disputeUsed"] as boolean;
    } else if (obj["disputeUsed"] !== undefined) {
      throw new ApiValidationError(`${path}.disputeUsed`, "expected a boolean");
    }
    if (typeof obj["events"] === "number") {
      (result as { events?: number }).events = obj["events"] as number;
    } else if (obj["events"] !== undefined) {
      throw new ApiValidationError(`${path}.events`, "expected a number");
    }
    return result;
  }
  if (source === "draft") {
    return {
      dealId,
      source,
      status: needString(obj, "status", path),
      terms: validateCanonicalTerms(obj["terms"], `${path}.terms`),
    };
  }
  const out: ProjectionDealStatus = { dealId, source, phase: needString(obj, "phase", path) };
  if (typeof obj["events"] === "number") {
    return { ...out, events: obj["events"] as number };
  }
  if (obj["events"] !== undefined) throw new ApiValidationError(`${path}.events`, "expected a number");
  return out;
}

export interface Confirmation {
  readonly dealId: string;
  readonly level: ConfirmationLevel;
  readonly txBlock?: string | undefined;
  readonly safeBlock?: string | null | undefined;
  readonly finalizedBlock?: string | null | undefined;
}

export function validateConfirmation(value: unknown, path = "$"): Confirmation {
  const obj = needRecord(value, path);
  const out: { dealId: string; level: ConfirmationLevel; txBlock?: string; safeBlock?: string | null; finalizedBlock?: string | null } = {
    dealId: needHash(obj, "dealId", path),
    level: validateConfirmationLevel(obj["level"], `${path}.level`),
  };
  if (obj["txBlock"] !== undefined) {
    if (typeof obj["txBlock"] !== "string") throw new ApiValidationError(`${path}.txBlock`, "expected a string");
    out.txBlock = obj["txBlock"];
  }
  for (const key of ["safeBlock", "finalizedBlock"] as const) {
    const entry = obj[key];
    if (entry !== undefined) {
      if (entry !== null && typeof entry !== "string") {
        throw new ApiValidationError(`${path}.${key}`, "expected a string or null");
      }
      out[key] = entry;
    }
  }
  return out;
}

export function isConfirmation(value: unknown): value is Confirmation {
  return tryParse(validateConfirmation, value) !== null;
}

export interface RecoveryPackage {
  readonly version: 1;
  readonly chainId: number;
  readonly hub: string;
  readonly usdc: string;
  readonly dealId: string;
  readonly agreementDigest: string;
  readonly canonicalTerms: Record<string, string>;
  readonly signatures: { readonly buyer: string; readonly seller: string };
  readonly policyIds: Record<string, string>;
  readonly relevantTransactions: readonly string[];
  readonly indexerTip: { readonly blockNumber: string; readonly blockHash: string } | null;
  readonly emergencyCalldata: Record<string, string>;
  readonly note: string;
}

export function validateRecoveryPackage(value: unknown, path = "$"): RecoveryPackage {
  const obj = needRecord(value, path);
  if (obj["version"] !== 1) throw new ApiValidationError(`${path}.version`, "expected version 1");
  const signatures = needRecord(obj["signatures"], `${path}.signatures`);
  const tipRaw = obj["indexerTip"];
  let indexerTip: RecoveryPackage["indexerTip"] = null;
  if (tipRaw !== null && tipRaw !== undefined) {
    const tip = needRecord(tipRaw, `${path}.indexerTip`);
    indexerTip = { blockNumber: needString(tip, "blockNumber", `${path}.indexerTip`), blockHash: needHash(tip, "blockHash", `${path}.indexerTip`) };
  }
  const txs = needArray(obj, "relevantTransactions", path);
  for (const [i, entry] of txs.entries()) {
    if (typeof entry !== "string") throw new ApiValidationError(`${path}.relevantTransactions[${i}]`, "expected a string");
  }
  return {
    version: 1,
    chainId: needNumber(obj, "chainId", path),
    hub: needAddress(obj, "hub", path),
    usdc: needAddress(obj, "usdc", path),
    dealId: needHash(obj, "dealId", path),
    agreementDigest: needHash(obj, "agreementDigest", path),
    canonicalTerms: needStringRecord(obj["canonicalTerms"], `${path}.canonicalTerms`),
    signatures: { buyer: needHash(signatures, "buyer", `${path}.signatures`), seller: needHash(signatures, "seller", `${path}.signatures`) },
    policyIds: needStringRecord(obj["policyIds"], `${path}.policyIds`),
    relevantTransactions: txs as string[],
    indexerTip,
    emergencyCalldata: needStringRecord(obj["emergencyCalldata"], `${path}.emergencyCalldata`),
    note: needString(obj, "note", path),
  };
}

export function isRecoveryPackage(value: unknown): value is RecoveryPackage {
  return tryParse(validateRecoveryPackage, value) !== null;
}

// ---- Relay ------------------------------------------------------------------

export interface RelaySubmitResult {
  readonly idempotencyKey: string;
  readonly inserted: boolean;
  readonly status: string;
}

export function validateRelaySubmitResult(value: unknown, path = "$"): RelaySubmitResult {
  const obj = needRecord(value, path);
  return {
    idempotencyKey: needString(obj, "idempotencyKey", path),
    inserted: needBoolean(obj, "inserted", path),
    status: needString(obj, "status", path),
  };
}

export interface RelayJob {
  readonly idempotencyKey: string;
  readonly queue: string;
  readonly action: string;
  readonly params: Record<string, unknown>;
  readonly status: string;
  readonly attempts: number;
  readonly txHash: string | null;
  readonly result: Record<string, unknown> | null;
}

export function validateRelayJob(value: unknown, path = "$"): RelayJob {
  const obj = needRecord(value, path);
  const txHash = obj["txHash"];
  if (txHash !== null && typeof txHash !== "string") {
    throw new ApiValidationError(`${path}.txHash`, "expected a string or null");
  }
  const result = obj["result"];
  if (result !== null && !isRecord(result)) {
    throw new ApiValidationError(`${path}.result`, "expected an object or null");
  }
  return {
    idempotencyKey: needString(obj, "idempotencyKey", path),
    queue: needString(obj, "queue", path),
    action: needString(obj, "action", path),
    params: needRecord(obj["params"], `${path}.params`),
    status: needString(obj, "status", path),
    attempts: needNumber(obj, "attempts", path),
    txHash: txHash as string | null,
    result: result as Record<string, unknown> | null,
  };
}

export function isRelayJob(value: unknown): value is RelayJob {
  return tryParse(validateRelayJob, value) !== null;
}

// ---- Evidence ---------------------------------------------------------------

export interface EvidenceScan {
  readonly status: "clean" | "infected" | "deferred" | "error";
  readonly detail?: string | undefined;
}

export function validateEvidenceScan(value: unknown, path = "$"): EvidenceScan {
  const obj = needRecord(value, path);
  const status = needString(obj, "status", path);
  if (status !== "clean" && status !== "infected" && status !== "deferred" && status !== "error") {
    throw new ApiValidationError(`${path}.status`, "expected clean|infected|deferred|error");
  }
  const detail = optString(obj, "detail", path);
  const out: EvidenceScan = { status };
  if (detail !== undefined) (out as { detail?: string }).detail = detail;
  return out;
}

export interface EvidenceManifestEntry {
  readonly dealId: string;
  readonly seq: number;
  readonly uploader: string;
  readonly kind: "delivery" | "dispute";
  readonly description: string;
  readonly fileHash: string;
  readonly prevHash: string;
  readonly head: string;
  readonly scan: EvidenceScan;
  readonly filename: string | null;
  readonly mimetype: string | null;
  readonly size: number | null;
  readonly at: string;
  readonly receipt?: EvidenceReceipt | undefined;
}

export interface EvidenceReceipt {
  readonly payload: string;
  readonly signature: string;
  readonly signer: string;
}

export function validateEvidenceReceipt(value: unknown, path = "$"): EvidenceReceipt {
  const obj = needRecord(value, path);
  return {
    payload: needString(obj, "payload", path),
    signature: needHex(obj, "signature", path),
    signer: needAddress(obj, "signer", path),
  };
}

export function isEvidenceReceipt(value: unknown): value is EvidenceReceipt {
  return tryParse(validateEvidenceReceipt, value) !== null;
}

export function validateEvidenceManifestEntry(value: unknown, path = "$"): EvidenceManifestEntry {
  const obj = needRecord(value, path);
  const kind = needString(obj, "kind", path);
  if (kind !== "delivery" && kind !== "dispute") {
    throw new ApiValidationError(`${path}.kind`, "expected delivery|dispute");
  }
  const filename = obj["filename"];
  if (filename !== null && typeof filename !== "string") {
    throw new ApiValidationError(`${path}.filename`, "expected a string or null");
  }
  const mimetype = obj["mimetype"];
  if (mimetype !== null && typeof mimetype !== "string") {
    throw new ApiValidationError(`${path}.mimetype`, "expected a string or null");
  }
  const size = obj["size"];
  if (size !== null && typeof size !== "number") {
    throw new ApiValidationError(`${path}.size`, "expected a number or null");
  }
  const out: EvidenceManifestEntry = {
    dealId: needString(obj, "dealId", path),
    seq: needNumber(obj, "seq", path),
    uploader: needAddress(obj, "uploader", path),
    kind,
    description: needString(obj, "description", path),
    fileHash: needHex(obj, "fileHash", path),
    prevHash: needHex(obj, "prevHash", path),
    head: needHex(obj, "head", path),
    scan: validateEvidenceScan(obj["scan"], `${path}.scan`),
    filename: filename as string | null,
    mimetype: mimetype as string | null,
    size: size as number | null,
    at: needString(obj, "at", path),
  };
  if (obj["receipt"] !== undefined) {
    (out as { receipt?: EvidenceReceipt }).receipt = validateEvidenceReceipt(obj["receipt"], `${path}.receipt`);
  }
  return out;
}

export function isEvidenceManifestEntry(value: unknown): value is EvidenceManifestEntry {
  return tryParse(validateEvidenceManifestEntry, value) !== null;
}

export interface EvidenceManifest {
  readonly dealId: string;
  readonly head: string;
  readonly entries: readonly EvidenceManifestEntry[];
}

export function validateEvidenceManifest(value: unknown, path = "$"): EvidenceManifest {
  const obj = needRecord(value, path);
  const entries = needArray(obj, "entries", path);
  return {
    dealId: needString(obj, "dealId", path),
    head: needHex(obj, "head", path),
    entries: entries.map((entry, i) => validateEvidenceManifestEntry(entry, `${path}.entries[${i}]`)),
  };
}

export interface EvidenceUploadResult {
  readonly seq: number;
  readonly fileHash: string;
  readonly commitment: string;
  readonly receipt: EvidenceReceipt;
  readonly scan: EvidenceScan;
}

export function validateEvidenceUploadResult(value: unknown, path = "$"): EvidenceUploadResult {
  const obj = needRecord(value, path);
  return {
    seq: needNumber(obj, "seq", path),
    fileHash: needHex(obj, "fileHash", path),
    commitment: needHex(obj, "commitment", path),
    receipt: validateEvidenceReceipt(obj["receipt"], `${path}.receipt`),
    scan: validateEvidenceScan(obj["scan"], `${path}.scan`),
  };
}

export interface EvidenceExport {
  readonly dealId: string;
  readonly exportedAt: string;
  readonly head: string;
  readonly count: number;
  readonly entries: readonly EvidenceManifestEntry[];
  readonly receipts: readonly (EvidenceReceipt | null)[];
  readonly tombstones: readonly { readonly dealId: string; readonly fileHash: string; readonly purgedAt: number }[];
  readonly metadata: { readonly genesis: string; readonly bytesIncluded: boolean };
}

export function validateEvidenceExport(value: unknown, path = "$"): EvidenceExport {
  const obj = needRecord(value, path);
  const entries = needArray(obj, "entries", path);
  const receipts = needArray(obj, "receipts", path);
  const tombstones = needArray(obj, "tombstones", path);
  const metadata = needRecord(obj["metadata"], `${path}.metadata`);
  return {
    dealId: needString(obj, "dealId", path),
    exportedAt: needString(obj, "exportedAt", path),
    head: needHex(obj, "head", path),
    count: needNumber(obj, "count", path),
    entries: entries.map((entry, i) => validateEvidenceManifestEntry(entry, `${path}.entries[${i}]`)),
    receipts: receipts.map((receipt, i) => {
      if (receipt === null) return null;
      return validateEvidenceReceipt(receipt, `${path}.receipts[${i}]`);
    }),
    tombstones: tombstones.map((tomb, i) => {
      const record = needRecord(tomb, `${path}.tombstones[${i}]`);
      return {
        dealId: needString(record, "dealId", `${path}.tombstones[${i}]`),
        fileHash: needString(record, "fileHash", `${path}.tombstones[${i}]`),
        purgedAt: needNumber(record, "purgedAt", `${path}.tombstones[${i}]`),
      };
    }),
    metadata: {
      genesis: needString(metadata, "genesis", `${path}.metadata`),
      bytesIncluded: needBoolean(metadata, "bytesIncluded", `${path}.metadata`),
    },
  };
}

export interface RestoreCheckResult {
  readonly ok: boolean;
  readonly fileHash: string;
  readonly recomputed: string;
}

export function validateRestoreCheckResult(value: unknown, path = "$"): RestoreCheckResult {
  const obj = needRecord(value, path);
  return {
    ok: needBoolean(obj, "ok", path),
    fileHash: needString(obj, "fileHash", path),
    recomputed: needString(obj, "recomputed", path),
  };
}

// ---- Categories / delivery forms / messages / commitments -------------------

export interface CategoryFieldDef {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "uint" | "hash" | "boolean";
  readonly required: boolean;
  readonly maxLen?: number | undefined;
  readonly exactLen?: number | undefined;
}

export interface CategoryDef {
  readonly id: string;
  readonly fields: readonly CategoryFieldDef[];
  readonly completionCriteria: string;
  readonly minInspection: number;
}

export function validateCategoryDef(value: unknown, path = "$"): CategoryDef {
  const obj = needRecord(value, path);
  const fields = needArray(obj, "fields", path);
  return {
    id: needString(obj, "id", path),
    fields: fields.map((field, i) => {
      const record = needRecord(field, `${path}.fields[${i}]`);
      const type = needString(record, "type", `${path}.fields[${i}]`);
      if (type !== "text" && type !== "uint" && type !== "hash" && type !== "boolean") {
        throw new ApiValidationError(`${path}.fields[${i}].type`, "expected text|uint|hash|boolean");
      }
      const out: CategoryFieldDef = {
        name: needString(record, "name", `${path}.fields[${i}]`),
        label: needString(record, "label", `${path}.fields[${i}]`),
        type,
        required: needBoolean(record, "required", `${path}.fields[${i}]`),
      };
      if (typeof record["maxLen"] === "number") (out as { maxLen?: number }).maxLen = record["maxLen"] as number;
      else if (record["maxLen"] !== undefined) {
        throw new ApiValidationError(`${path}.fields[${i}].maxLen`, "expected a number");
      }
      if (typeof record["exactLen"] === "number") (out as { exactLen?: number }).exactLen = record["exactLen"] as number;
      else if (record["exactLen"] !== undefined) {
        throw new ApiValidationError(`${path}.fields[${i}].exactLen`, "expected a number");
      }
      return out;
    }),
    completionCriteria: needString(obj, "completionCriteria", path),
    minInspection: needNumber(obj, "minInspection", path),
  };
}

export function isCategoryDef(value: unknown): value is CategoryDef {
  return tryParse(validateCategoryDef, value) !== null;
}

export interface CategoriesList {
  readonly categories: readonly CategoryDef[];
}

export function validateCategoriesList(value: unknown, path = "$"): CategoriesList {
  const obj = needRecord(value, path);
  const categories = needArray(obj, "categories", path);
  return {
    categories: categories.map((entry, i) => validateCategoryDef(entry, `${path}.categories[${i}]`)),
  };
}

export interface DeliveryFormResult {
  readonly ok: true;
  readonly deliveryManifestHash: string;
  readonly version: number;
}

export function validateDeliveryFormResult(value: unknown, path = "$"): DeliveryFormResult {
  const obj = needRecord(value, path);
  if (obj["ok"] !== true) throw new ApiValidationError(`${path}.ok`, "expected true");
  return {
    ok: true,
    deliveryManifestHash: needHash(obj, "deliveryManifestHash", path),
    version: needNumber(obj, "version", path),
  };
}

export interface DeliveryFormRecord {
  readonly dealId: string;
  readonly category: string;
  readonly data: Record<string, unknown>;
  readonly deliveryManifestHash: string;
  readonly submittedBy: string;
  readonly submittedAt: string;
  readonly version: number;
}

export function validateDeliveryFormRecord(value: unknown, path = "$"): DeliveryFormRecord {
  const obj = needRecord(value, path);
  return {
    dealId: needString(obj, "dealId", path),
    category: needString(obj, "category", path),
    data: needRecord(obj["data"], `${path}.data`),
    deliveryManifestHash: needHash(obj, "deliveryManifestHash", path),
    submittedBy: needString(obj, "submittedBy", path),
    submittedAt: needString(obj, "submittedAt", path),
    version: needNumber(obj, "version", path),
  };
}

export interface ChatMessage {
  readonly seq: number;
  readonly author: string;
  readonly text: string;
  readonly at: string;
}

export function validateChatMessage(value: unknown, path = "$"): ChatMessage {
  const obj = needRecord(value, path);
  return {
    seq: needNumber(obj, "seq", path),
    author: needString(obj, "author", path),
    text: needString(obj, "text", path),
    at: needString(obj, "at", path),
  };
}

export function isChatMessage(value: unknown): value is ChatMessage {
  return tryParse(validateChatMessage, value) !== null;
}

export interface MessagesList {
  readonly dealId: string;
  readonly messages: readonly ChatMessage[];
}

export function validateMessagesList(value: unknown, path = "$"): MessagesList {
  const obj = needRecord(value, path);
  const messages = needArray(obj, "messages", path);
  return {
    dealId: needString(obj, "dealId", path),
    messages: messages.map((entry, i) => validateChatMessage(entry, `${path}.messages[${i}]`)),
  };
}

export interface EvidencePayload {
  readonly dealId: string;
  readonly agreementDigest: string;
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
  readonly types: Record<string, unknown>;
  readonly primaryType: string;
  readonly message: {
    readonly dealId: string;
    readonly agreementDigest: string;
    readonly uploader: string;
    readonly sequence: string;
    readonly prevCommitment: string;
    readonly fileHashes: readonly string[];
    readonly metadataCommitment: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
  readonly calldata: string;
  readonly commitment: string;
  readonly note: string;
}

export function validateEvidencePayload(value: unknown, path = "$"): EvidencePayload {
  const obj = needRecord(value, path);
  const domain = needRecord(obj["domain"], `${path}.domain`);
  const message = needRecord(obj["message"], `${path}.message`);
  // Server emits uint fields as decimal strings (same convention as readiness).
  const fileHashes = needArray(message, "fileHashes", `${path}.message`);
  fileHashes.forEach((entry, i) => {
    if (typeof entry !== "string" || !HASH_RE.test(entry)) {
      throw new ApiValidationError(`${path}.message.fileHashes[${i}]`, "expected 0x + 64 hex");
    }
  });
  return {
    dealId: needHash(obj, "dealId", path),
    agreementDigest: needHash(obj, "agreementDigest", path),
    domain: {
      name: needString(domain, "name", `${path}.domain`),
      version: needString(domain, "version", `${path}.domain`),
      chainId: needNumber(domain, "chainId", `${path}.domain`),
      verifyingContract: needAddress(domain, "verifyingContract", `${path}.domain`),
    },
    types: needRecord(obj["types"], `${path}.types`),
    primaryType: needString(obj, "primaryType", path),
    message: {
      dealId: needHash(message, "dealId", `${path}.message`),
      agreementDigest: needHash(message, "agreementDigest", `${path}.message`),
      uploader: needAddress(message, "uploader", `${path}.message`),
      sequence: needUnits(message, "sequence", `${path}.message`),
      prevCommitment: needHash(message, "prevCommitment", `${path}.message`),
      fileHashes: fileHashes as string[],
      metadataCommitment: needHash(message, "metadataCommitment", `${path}.message`),
      nonce: needHash(message, "nonce", `${path}.message`),
      expiresAt: needUnits(message, "expiresAt", `${path}.message`),
    },
    calldata: needHex(obj, "calldata", path),
    commitment: needHex(obj, "commitment", path),
    note: needString(obj, "note", path),
  };
}

// ---- Review -----------------------------------------------------------------

export interface DeadlineSummary {
  readonly evidenceEnd: string | null;
  readonly primaryEnd: string | null;
  readonly fallbackEnd: string | null;
  readonly escapeAt: string | null;
  readonly secondsToEvidenceEnd: number | null;
  readonly secondsToEscape: number | null;
}

export function validateDeadlineSummary(value: unknown, path = "$"): DeadlineSummary {
  const obj = needRecord(value, path);
  const strOrNull = (key: string): string | null => {
    const entry = obj[key];
    if (entry === null) return null;
    if (typeof entry !== "string") throw new ApiValidationError(`${path}.${key}`, "expected a string or null");
    return entry;
  };
  const numOrNull = (key: string): number | null => {
    const entry = obj[key];
    if (entry === null) return null;
    if (typeof entry !== "number") throw new ApiValidationError(`${path}.${key}`, "expected a number or null");
    return entry;
  };
  return {
    evidenceEnd: strOrNull("evidenceEnd"),
    primaryEnd: strOrNull("primaryEnd"),
    fallbackEnd: strOrNull("fallbackEnd"),
    escapeAt: strOrNull("escapeAt"),
    secondsToEvidenceEnd: numOrNull("secondsToEvidenceEnd"),
    secondsToEscape: numOrNull("secondsToEscape"),
  };
}

export interface ReviewQueueItem {
  readonly dealId: string;
  readonly source: "chain" | "projection";
  readonly phase: string;
  readonly phaseIndex: number | null;
  readonly inDispute: boolean | null;
  readonly stage: string;
  readonly deadlines: DeadlineSummary;
  readonly primaryEligible: readonly string[];
  readonly fallbackEligible: readonly string[];
  readonly recusals: number;
}

export function validateReviewQueueItem(value: unknown, path = "$"): ReviewQueueItem {
  const obj = needRecord(value, path);
  const source = needString(obj, "source", path);
  if (source !== "chain" && source !== "projection") {
    throw new ApiValidationError(`${path}.source`, "expected chain|projection");
  }
  const phaseIndex = obj["phaseIndex"];
  if (phaseIndex !== null && typeof phaseIndex !== "number") {
    throw new ApiValidationError(`${path}.phaseIndex`, "expected a number or null");
  }
  const inDispute = obj["inDispute"];
  if (inDispute !== null && typeof inDispute !== "boolean") {
    throw new ApiValidationError(`${path}.inDispute`, "expected a boolean or null");
  }
  return {
    dealId: needHash(obj, "dealId", path),
    source: source as "chain" | "projection",
    phase: needString(obj, "phase", path),
    phaseIndex: phaseIndex as number | null,
    inDispute: inDispute as boolean | null,
    stage: needString(obj, "stage", path),
    deadlines: validateDeadlineSummary(obj["deadlines"], `${path}.deadlines`),
    primaryEligible: needStringArray(obj["primaryEligible"], `${path}.primaryEligible`),
    fallbackEligible: needStringArray(obj["fallbackEligible"], `${path}.fallbackEligible`),
    recusals: needNumber(obj, "recusals", path),
  };
}

export function isReviewQueueItem(value: unknown): value is ReviewQueueItem {
  return tryParse(validateReviewQueueItem, value) !== null;
}

export interface ReviewQueue {
  readonly queue: readonly ReviewQueueItem[];
  readonly filtered: string;
}

export function validateReviewQueue(value: unknown, path = "$"): ReviewQueue {
  const obj = needRecord(value, path);
  const queue = needArray(obj, "queue", path);
  return {
    queue: queue.map((entry, i) => validateReviewQueueItem(entry, `${path}.queue[${i}]`)),
    filtered: needString(obj, "filtered", path),
  };
}

export interface RecusalRecord {
  readonly reviewer: string;
  readonly reason: string;
  readonly at: string;
}

export function validateRecusalRecord(value: unknown, path = "$"): RecusalRecord {
  const obj = needRecord(value, path);
  return {
    reviewer: needAddress(obj, "reviewer", path),
    reason: needString(obj, "reason", path),
    at: needString(obj, "at", path),
  };
}

export interface AwardDraft {
  readonly dealId: string;
  readonly agreementDigest: string;
  readonly arbitrationPolicyId: string;
  readonly origin: number;
  readonly rulingNonce: string;
  readonly sellerAward: string;
  readonly buyerCost: string;
  readonly sellerCost: string;
  readonly earnedFeePreview: string;
  readonly evidenceCommitment: string;
  readonly authEpoch: string;
  readonly queueExpiry: string;
  readonly rulingDigest: string;
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
  readonly types: Record<string, unknown>;
  readonly primaryType: "Ruling";
  readonly message: {
    readonly dealId: string;
    readonly agreementDigest: string;
    readonly arbitrationPolicyId: string;
    readonly origin: number;
    readonly rulingNonce: string;
    readonly sellerAward: string;
    readonly buyerBondCost: string;
    readonly sellerBondCost: string;
    readonly evidenceCommitment: string;
    readonly authEpoch: string;
    readonly queueExpiry: string;
  };
  readonly createdAt: string;
}

export function validateAwardDraft(value: unknown, path = "$"): AwardDraft {
  const obj = needRecord(value, path);
  const origin = needNumber(obj, "origin", path);
  if (origin !== 0 && origin !== 1) throw new ApiValidationError(`${path}.origin`, "expected 0 or 1");
  const primaryType = needString(obj, "primaryType", path);
  if (primaryType !== "Ruling") throw new ApiValidationError(`${path}.primaryType`, "expected Ruling");
  const domain = needRecord(obj["domain"], `${path}.domain`);
  const message = needRecord(obj["message"], `${path}.message`);
  return {
    dealId: needHash(obj, "dealId", path),
    agreementDigest: needHash(obj, "agreementDigest", path),
    arbitrationPolicyId: needHash(obj, "arbitrationPolicyId", path),
    origin,
    rulingNonce: needHash(obj, "rulingNonce", path),
    sellerAward: needUnits(obj, "sellerAward", path),
    buyerCost: needUnits(obj, "buyerCost", path),
    sellerCost: needUnits(obj, "sellerCost", path),
    earnedFeePreview: needUnits(obj, "earnedFeePreview", path),
    evidenceCommitment: needHash(obj, "evidenceCommitment", path),
    authEpoch: needUnits(obj, "authEpoch", path),
    queueExpiry: needUnits(obj, "queueExpiry", path),
    rulingDigest: needHash(obj, "rulingDigest", path),
    domain: {
      name: needString(domain, "name", `${path}.domain`),
      version: needString(domain, "version", `${path}.domain`),
      chainId: needNumber(domain, "chainId", `${path}.domain`),
      verifyingContract: needAddress(domain, "verifyingContract", `${path}.domain`),
    },
    types: needRecord(obj["types"], `${path}.types`),
    primaryType: "Ruling",
    message: {
      dealId: needHash(message, "dealId", `${path}.message`),
      agreementDigest: needHash(message, "agreementDigest", `${path}.message`),
      arbitrationPolicyId: needHash(message, "arbitrationPolicyId", `${path}.message`),
      origin: needNumber(message, "origin", `${path}.message`),
      rulingNonce: needHash(message, "rulingNonce", `${path}.message`),
      sellerAward: needUnits(message, "sellerAward", `${path}.message`),
      buyerBondCost: needUnits(message, "buyerBondCost", `${path}.message`),
      sellerBondCost: needUnits(message, "sellerBondCost", `${path}.message`),
      evidenceCommitment: needHash(message, "evidenceCommitment", `${path}.message`),
      authEpoch: needUnits(message, "authEpoch", `${path}.message`),
      queueExpiry: needUnits(message, "queueExpiry", `${path}.message`),
    },
    createdAt: needString(obj, "createdAt", path),
  };
}

export function isAwardDraft(value: unknown): value is AwardDraft {
  return tryParse(validateAwardDraft, value) !== null;
}

export interface ApprovalProgress {
  readonly rulingDigest: string;
  readonly origin: number;
  readonly have: number;
  readonly need: number;
  readonly signers: readonly string[];
  readonly complete: boolean;
}

export function validateApprovalProgress(value: unknown, path = "$"): ApprovalProgress {
  const obj = needRecord(value, path);
  const origin = needNumber(obj, "origin", path);
  if (origin !== 0 && origin !== 1) throw new ApiValidationError(`${path}.origin`, "expected 0 or 1");
  return {
    rulingDigest: needHash(obj, "rulingDigest", path),
    origin,
    have: needNumber(obj, "have", path),
    need: needNumber(obj, "need", path),
    signers: needStringArray(obj["signers"], `${path}.signers`),
    complete: needBoolean(obj, "complete", path),
  };
}

export function isApprovalProgress(value: unknown): value is ApprovalProgress {
  return tryParse(validateApprovalProgress, value) !== null;
}

export interface ReviewCaseBundle {
  readonly dealId: string;
  readonly chain: Record<string, string | boolean | number | null> | null;
  readonly evidence: { readonly head: string; readonly entries: readonly EvidenceManifestEntry[] };
  readonly deliveryForm: DeliveryFormRecord | null;
  readonly primary: readonly string[];
  readonly fallback: readonly string[];
  readonly recusals: readonly RecusalRecord[];
  readonly remainingEligible: { readonly primary: readonly string[]; readonly fallback: readonly string[] };
  readonly drafts: readonly AwardDraft[];
  readonly approvals: readonly ApprovalProgress[];
  readonly quorumNeed: number;
}

export function validateReviewCaseBundle(value: unknown, path = "$"): ReviewCaseBundle {
  const obj = needRecord(value, path);
  const chainRaw = obj["chain"];
  let chain: ReviewCaseBundle["chain"] = null;
  if (chainRaw !== null && chainRaw !== undefined) {
    const record = needRecord(chainRaw, `${path}.chain`);
    const out: Record<string, string | boolean | number | null> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (entry === null || typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number") {
        out[key] = entry;
      } else {
        throw new ApiValidationError(`${path}.chain.${key}`, "expected a string, boolean, number, or null");
      }
    }
    chain = out;
  }
  const evidence = needRecord(obj["evidence"], `${path}.evidence`);
  const evidenceEntries = needArray(evidence, "entries", `${path}.evidence`);
  const formRaw = obj["deliveryForm"];
  const deliveryForm =
    formRaw === null || formRaw === undefined
      ? null
      : validateDeliveryFormRecord(formRaw, `${path}.deliveryForm`);
  const remaining = needRecord(obj["remainingEligible"], `${path}.remainingEligible`);
  const drafts = needArray(obj, "drafts", path);
  const approvals = needArray(obj, "approvals", path);
  const recusals = needArray(obj, "recusals", path);
  return {
    dealId: needHash(obj, "dealId", path),
    chain,
    evidence: {
      head: needHex(evidence, "head", `${path}.evidence`),
      entries: evidenceEntries.map((entry, i) => validateEvidenceManifestEntry(entry, `${path}.evidence.entries[${i}]`)),
    },
    deliveryForm,
    primary: needStringArray(obj["primary"], `${path}.primary`),
    fallback: needStringArray(obj["fallback"], `${path}.fallback`),
    recusals: recusals.map((entry, i) => validateRecusalRecord(entry, `${path}.recusals[${i}]`)),
    remainingEligible: {
      primary: needStringArray(remaining["primary"], `${path}.remainingEligible.primary`),
      fallback: needStringArray(remaining["fallback"], `${path}.remainingEligible.fallback`),
    },
    drafts: drafts.map((entry, i) => validateAwardDraft(entry, `${path}.drafts[${i}]`)),
    approvals: approvals.map((entry, i) => validateApprovalProgress(entry, `${path}.approvals[${i}]`)),
    quorumNeed: needNumber(obj, "quorumNeed", path),
  };
}

export function isReviewCaseBundle(value: unknown): value is ReviewCaseBundle {
  return tryParse(validateReviewCaseBundle, value) !== null;
}

export interface ReviewCaseRecord {
  readonly dealId: string;
  readonly primary: readonly string[];
  readonly fallback: readonly string[];
  readonly recusals: readonly RecusalRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function validateReviewCaseRecord(value: unknown, path = "$"): ReviewCaseRecord {
  const obj = needRecord(value, path);
  const recusals = needArray(obj, "recusals", path);
  return {
    dealId: needHash(obj, "dealId", path),
    primary: needStringArray(obj["primary"], `${path}.primary`),
    fallback: needStringArray(obj["fallback"], `${path}.fallback`),
    recusals: recusals.map((entry, i) => validateRecusalRecord(entry, `${path}.recusals[${i}]`)),
    createdAt: needString(obj, "createdAt", path),
    updatedAt: needString(obj, "updatedAt", path),
  };
}

export interface RecuseResult extends ReviewCaseRecord {
  readonly remainingEligible: { readonly primary: readonly string[]; readonly fallback: readonly string[] };
  readonly note: string;
}

export function validateRecuseResult(value: unknown, path = "$"): RecuseResult {
  const base = validateReviewCaseRecord(value, path);
  const obj = needRecord(value, path);
  const remaining = needRecord(obj["remainingEligible"], `${path}.remainingEligible`);
  return {
    ...base,
    remainingEligible: {
      primary: needStringArray(remaining["primary"], `${path}.remainingEligible.primary`),
      fallback: needStringArray(remaining["fallback"], `${path}.remainingEligible.fallback`),
    },
    note: needString(obj, "note", path),
  };
}

export interface RelayPayload {
  readonly idempotencyKey: string;
  readonly action: string;
  readonly params: Record<string, unknown>;
}

export function validateRelayPayload(value: unknown, path = "$"): RelayPayload {
  const obj = needRecord(value, path);
  return {
    idempotencyKey: needString(obj, "idempotencyKey", path),
    action: needString(obj, "action", path),
    params: needRecord(obj["params"], `${path}.params`),
  };
}

export interface QueueRulingResult {
  readonly dealId: string;
  readonly rulingDigest: string;
  readonly origin: number;
  readonly signatures: readonly string[];
  readonly calldata: string;
  readonly relayPayload: RelayPayload;
  readonly note: string;
}

export function validateQueueRulingResult(value: unknown, path = "$"): QueueRulingResult {
  const obj = needRecord(value, path);
  const signatures = needArray(obj, "signatures", path);
  signatures.forEach((entry, i) => {
    if (typeof entry !== "string" || !HEX_RE.test(entry)) {
      throw new ApiValidationError(`${path}.signatures[${i}]`, "expected 0x hex");
    }
  });
  return {
    dealId: needHash(obj, "dealId", path),
    rulingDigest: needHash(obj, "rulingDigest", path),
    origin: needNumber(obj, "origin", path),
    signatures: signatures as string[],
    calldata: needHex(obj, "calldata", path),
    relayPayload: validateRelayPayload(obj["relayPayload"], `${path}.relayPayload`),
    note: needString(obj, "note", path),
  };
}

export interface VetoSig {
  readonly authority: string;
  readonly nonce: string;
  readonly expiry: string;
  readonly signature: string;
}

export function validateVetoSig(value: unknown, path = "$"): VetoSig {
  const obj = needRecord(value, path);
  return {
    authority: needAddress(obj, "authority", path),
    nonce: needHash(obj, "nonce", path),
    expiry: needUnits(obj, "expiry", path),
    signature: needHex(obj, "signature", path),
  };
}

export interface VetoPayload {
  readonly dealId: string;
  readonly rulingDigest: string;
  readonly origin: number;
  readonly effect: "cancel-only";
  readonly authorities: readonly string[];
  readonly vsigs: readonly VetoSig[];
  readonly calldata: string;
  readonly relayPayload: RelayPayload;
  readonly note: string;
}

export function validateVetoPayload(value: unknown, path = "$"): VetoPayload {
  const obj = needRecord(value, path);
  if (obj["effect"] !== "cancel-only") throw new ApiValidationError(`${path}.effect`, "expected cancel-only");
  const origin = needNumber(obj, "origin", path);
  if (origin !== 0 && origin !== 1) throw new ApiValidationError(`${path}.origin`, "expected 0 or 1");
  const vsigs = needArray(obj, "vsigs", path);
  return {
    dealId: needHash(obj, "dealId", path),
    rulingDigest: needHash(obj, "rulingDigest", path),
    origin,
    effect: "cancel-only",
    authorities: needStringArray(obj["authorities"], `${path}.authorities`),
    vsigs: vsigs.map((entry, i) => validateVetoSig(entry, `${path}.vsigs[${i}]`)),
    calldata: needHex(obj, "calldata", path),
    relayPayload: validateRelayPayload(obj["relayPayload"], `${path}.relayPayload`),
    note: needString(obj, "note", path),
  };
}

export function isVetoPayload(value: unknown): value is VetoPayload {
  return tryParse(validateVetoPayload, value) !== null;
}

// ---- Settlement proposals ---------------------------------------------------
// Server field names are sellerAward/buyerCost/sellerCost (NOT *Units) plus
// principal/claimantBond/respondentBond — see review/proposals.ts.

export interface SettlementProposal {
  readonly id: string;
  readonly dealId: string;
  readonly proposer: string;
  readonly buyer: string | null;
  readonly seller: string | null;
  readonly sellerAward: string;
  readonly buyerCost: string;
  readonly sellerCost: string;
  readonly expectedPhase: number;
  readonly agreementDigest: string;
  readonly settlementNonce: string;
  readonly expiresAt: string;
  readonly principal: string;
  readonly claimantBond: string;
  readonly respondentBond: string;
  readonly bondsUnverified: boolean;
  readonly proposerSignature: string | null;
  readonly chainId: number;
  readonly hub: string;
  readonly status: "open" | "accepted";
  readonly createdAt: string;
}

export function validateSettlementProposal(value: unknown, path = "$"): SettlementProposal {
  const obj = needRecord(value, path);
  const buyer = obj["buyer"];
  if (buyer !== null && (typeof buyer !== "string" || !ADDRESS_RE.test(buyer))) {
    throw new ApiValidationError(`${path}.buyer`, "expected an address or null");
  }
  const seller = obj["seller"];
  if (seller !== null && (typeof seller !== "string" || !ADDRESS_RE.test(seller))) {
    throw new ApiValidationError(`${path}.seller`, "expected an address or null");
  }
  const proposerSignature = obj["proposerSignature"];
  if (proposerSignature !== null && (typeof proposerSignature !== "string" || !HEX_RE.test(proposerSignature))) {
    throw new ApiValidationError(`${path}.proposerSignature`, "expected 0x hex or null");
  }
  const status = needString(obj, "status", path);
  if (status !== "open" && status !== "accepted") {
    throw new ApiValidationError(`${path}.status`, "expected open|accepted");
  }
  return {
    id: needString(obj, "id", path),
    dealId: needHash(obj, "dealId", path),
    proposer: needAddress(obj, "proposer", path),
    buyer: buyer as string | null,
    seller: seller as string | null,
    sellerAward: needUnits(obj, "sellerAward", path),
    buyerCost: needUnits(obj, "buyerCost", path),
    sellerCost: needUnits(obj, "sellerCost", path),
    expectedPhase: needNumber(obj, "expectedPhase", path),
    agreementDigest: needHash(obj, "agreementDigest", path),
    settlementNonce: needHash(obj, "settlementNonce", path),
    expiresAt: needUnits(obj, "expiresAt", path),
    principal: needUnits(obj, "principal", path),
    claimantBond: needUnits(obj, "claimantBond", path),
    respondentBond: needUnits(obj, "respondentBond", path),
    bondsUnverified: needBoolean(obj, "bondsUnverified", path),
    proposerSignature: proposerSignature as string | null,
    chainId: needNumber(obj, "chainId", path),
    hub: needAddress(obj, "hub", path),
    status,
    createdAt: needString(obj, "createdAt", path),
  };
}

export function isSettlementProposal(value: unknown): value is SettlementProposal {
  return tryParse(validateSettlementProposal, value) !== null;
}

export interface SettlementProposalsList {
  readonly dealId: string;
  readonly proposals: readonly SettlementProposal[];
}

export function validateSettlementProposalsList(value: unknown, path = "$"): SettlementProposalsList {
  const obj = needRecord(value, path);
  const proposals = needArray(obj, "proposals", path);
  return {
    dealId: needHash(obj, "dealId", path),
    proposals: proposals.map((entry, i) => validateSettlementProposal(entry, `${path}.proposals[${i}]`)),
  };
}

export interface AcceptProposalResult {
  readonly proposal: SettlementProposal;
  readonly calldata: string;
  readonly relayPayload: RelayPayload;
  readonly note: string;
}

export function validateAcceptProposalResult(value: unknown, path = "$"): AcceptProposalResult {
  const obj = needRecord(value, path);
  return {
    proposal: validateSettlementProposal(obj["proposal"], `${path}.proposal`),
    calldata: needHex(obj, "calldata", path),
    relayPayload: validateRelayPayload(obj["relayPayload"], `${path}.relayPayload`),
    note: needString(obj, "note", path),
  };
}

// ---- Escalation ---------------------------------------------------------------

export interface EscalationInfo {
  readonly dealId: string;
  readonly claimantBond: string;
  readonly respondentBond: string;
  readonly source: "chain" | "estimated";
  readonly estimated: boolean;
  readonly policyNote: string;
  readonly windows: {
    readonly now: string;
    readonly fundedAt: string | null;
    readonly deliveredAt: string | null;
    readonly disputeOpenedAt: string | null;
    readonly escalatedAt: string | null;
    readonly selfResolutionEnd: string | null;
    readonly escalationEnd: string | null;
    readonly deadlines: DeadlineSummary;
  };
}

export function validateEscalationInfo(value: unknown, path = "$"): EscalationInfo {
  const obj = needRecord(value, path);
  const source = needString(obj, "source", path);
  if (source !== "chain" && source !== "estimated") {
    throw new ApiValidationError(`${path}.source`, "expected chain|estimated");
  }
  const windows = needRecord(obj["windows"], `${path}.windows`);
  const strOrNull = (key: string): string | null => {
    const entry = windows[key];
    if (entry === null) return null;
    if (typeof entry !== "string") throw new ApiValidationError(`${path}.windows.${key}`, "expected a string or null");
    return entry;
  };
  return {
    dealId: needHash(obj, "dealId", path),
    claimantBond: needUnits(obj, "claimantBond", path),
    respondentBond: needUnits(obj, "respondentBond", path),
    source: source as "chain" | "estimated",
    estimated: needBoolean(obj, "estimated", path),
    policyNote: needString(obj, "policyNote", path),
    windows: {
      now: needString(windows, "now", `${path}.windows`),
      fundedAt: strOrNull("fundedAt"),
      deliveredAt: strOrNull("deliveredAt"),
      disputeOpenedAt: strOrNull("disputeOpenedAt"),
      escalatedAt: strOrNull("escalatedAt"),
      selfResolutionEnd: strOrNull("selfResolutionEnd"),
      escalationEnd: strOrNull("escalationEnd"),
      deadlines: validateDeadlineSummary(windows["deadlines"], `${path}.windows.deadlines`),
    },
  };
}

export function isEscalationInfo(value: unknown): value is EscalationInfo {
  return tryParse(validateEscalationInfo, value) !== null;
}

// ---- Indexer / health / errors -------------------------------------------------

export interface IndexerTickResult {
  readonly scannedTo: string;
  readonly added: number;
  readonly orphaned: number;
  readonly reorg: boolean;
}

export function validateIndexerTickResult(value: unknown, path = "$"): IndexerTickResult {
  const obj = needRecord(value, path);
  // The indexer returns scannedTo as a bigint; JSON-safe transports may carry
  // it as a decimal string or number. Normalize to a decimal string.
  const raw = obj["scannedTo"];
  let scannedTo: string;
  if (typeof raw === "bigint") scannedTo = raw.toString();
  else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) scannedTo = String(raw);
  else if (typeof raw === "string" && UNITS_RE.test(raw)) scannedTo = raw;
  else throw new ApiValidationError(`${path}.scannedTo`, "expected a bigint, integer, or decimal string");
  return {
    scannedTo,
    added: needNumber(obj, "added", path),
    orphaned: needNumber(obj, "orphaned", path),
    reorg: needBoolean(obj, "reorg", path),
  };
}

export interface IndexerReplayResult {
  readonly ok: true;
}

export function validateIndexerReplayResult(value: unknown, path = "$"): IndexerReplayResult {
  const obj = needRecord(value, path);
  if (obj["ok"] !== true) throw new ApiValidationError(`${path}.ok`, "expected true");
  return { ok: true };
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly chainId: number | null;
  readonly rpc: boolean;
  readonly hub: string | null;
}

export function validateHealthResponse(value: unknown, path = "$"): HealthResponse {
  const obj = needRecord(value, path);
  const chainId = obj["chainId"];
  if (chainId !== null && typeof chainId !== "number") {
    throw new ApiValidationError(`${path}.chainId`, "expected a number or null");
  }
  const hub = obj["hub"];
  if (hub !== null && (typeof hub !== "string" || !ADDRESS_RE.test(hub))) {
    throw new ApiValidationError(`${path}.hub`, "expected an address or null");
  }
  return {
    ok: needBoolean(obj, "ok", path),
    degraded: needBoolean(obj, "degraded", path),
    chainId: chainId as number | null,
    rpc: needBoolean(obj, "rpc", path),
    hub: hub as string | null,
  };
}

export interface ErrorResponse {
  readonly error: string;
}

export function validateErrorResponse(value: unknown, path = "$"): ErrorResponse {
  const obj = needRecord(value, path);
  return { error: needString(obj, "error", path) };
}

export function isErrorResponse(value: unknown): value is ErrorResponse {
  return tryParse(validateErrorResponse, value) !== null;
}
