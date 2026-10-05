// Funding bundle + deal-signature persistence (audit finding #6, API half).
//
// The bundle is everything a wallet needs to complete a fund() call for a
// draft, in the canonical shape defined by @midman/api-client/src/funding.ts
// (exact field names, no aliases): full 32-field DealTerms typed data both
// parties sign, draft DealTerms signatures collected so far, the
// buyer-signed FundWithAllowance params + envelope, readiness
// requirement + params (+ envelope when required), and the
// operator-granted admission struct when present. Nothing here signs or
// submits; the contract remains the arbiter.
//
// Nonce/salt strategy: `paymentSalt` and `allowanceNonce` are uniformly random
// 32-byte values generated per bundle and RETURNED, so a client can re-sign a
// bundle deterministically if it retains them. They are not derived from draft
// fields (the contract enforces single-use on-chain).
import { randomBytes } from "node:crypto";
import { recoverTypedDataAddress, type Address, type Hash } from "viem";
import type { ChainReader } from "@midman/chain";
import type { Store } from "./db.js";
import { buildFullTerms } from "./fullTerms.js";
import type { CanonicalTerms } from "./terms.js";
import {
  dealTermsTypedData,
  fundWithAllowanceTypedData,
  fundingAdmissionTypedData,
  readinessConsentTypedData,
} from "./chainActions.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

/** Allowance intent validity window (seconds from bundle build). */
export const ALLOWANCE_WINDOW_SECONDS = 3_600;
/** P-11: readiness attestation is valid for 2h before funding. */
export const READINESS_EXPIRY_SECONDS = 7_200;
/** P-11: readiness is required for the <=3h pricing tier (delivery+inspection). */
export const READINESS_TIER_MAX_SECONDS = 10_800;

export const ADMISSION_POLICY_NOTE =
  "FundingAdmission is required for all deals at launch: an expiring (24h) signature from the risk " +
  "admission signer over (agreementDigest, minPolicyId, admissionNonce, expiresAt, expectedUnfunded=true). " +
  "Withhold it and the hub reverts at fund().";

/** Structural deps (subset of the API RouteDeps; extra fields ignored). */
export interface FundingDeps {
  readonly reader: ChainReader | null;
  readonly hub: Address | null;
  readonly usdc: Address;
  readonly chainId: number | null;
}

export type DealRole = "buyer" | "seller";

/**
 * Canonical funding bundle — the single API/web contract defined in
 * @midman/api-client/src/funding.ts. Field names are exact (no aliases):
 * `token` (not usdc), `signatures` (draft DealTerms sigs), `allowance`
 * (signing params + typed envelope), `readiness` (required flag + params +
 * optional envelope), `admission` (policy note + operator-granted struct).
 */
export interface FundingBundle {
  readonly draftId: string;
  readonly dealId: string;
  readonly hub: Address;
  readonly token: Address;
  readonly chainId: number;
  readonly principalUnits: string;
  readonly fundedUnits: string;
  readonly prepaidBuyerFeeUnits: string;
  readonly fullTerms: Record<string, string>;
  readonly agreementDigest: Hash;
  readonly dealTermsTypedData: ReturnType<typeof dealTermsTypedData>;
  readonly signatures: { readonly buyer: string | null; readonly seller: string | null };
  readonly allowance: {
    readonly paymentSalt: Hash;
    readonly nonce: Hash;
    readonly expiresAt: string;
    readonly typedData: ReturnType<typeof fundWithAllowanceTypedData>;
  };
  readonly readiness: {
    readonly required: boolean | null;
    readonly note: string;
    readonly attestedAt: string;
    readonly nonce: Hash;
    readonly expiresAt: string;
    readonly typedData: ReturnType<typeof readinessConsentTypedData> | null;
  };
  readonly admission: {
    readonly note: string;
    readonly granted: Record<string, string> | null;
  };
  readonly requiredSignatures: readonly ["buyer", "seller"];
  readonly relayActionTemplate: { readonly action: "fund"; readonly params: { readonly dealId: string } };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const randomHash = (): Hash => `0x${randomBytes(32).toString("hex")}` as Hash;

/**
 * P-11 readiness decision is best-effort from the draft alone: the on-chain
 * registry (not the off-chain draft) records whether a readiness policy
 * requires consent, so when the draft is a short (<=3h) deal without a
 * registered readiness policy we cannot confirm the requirement and return
 * `null` with an explanatory note.
 */
function resolveReadiness(terms: CanonicalTerms): { required: boolean | null; note: string } {
  const duration = Number(terms["deliverySeconds"] ?? "0") + Number(terms["inspectionSeconds"] ?? "0");
  const readinessPolicy = terms["policy:readiness"] ?? terms["readinessPolicyId"];
  const hasReadinessPolicy = typeof readinessPolicy === "string" && readinessPolicy !== "";
  if (duration <= READINESS_TIER_MAX_SECONDS) {
    if (hasReadinessPolicy) {
      return {
        required: true,
        note: "P-11: short deal (delivery+inspection <= 3h) requires a buyer ReadinessConsent signed within 2h of funding.",
      };
    }
    return {
      required: null,
      note:
        "P-11: short deal (<= 3h) but the draft carries no readiness policy id; the on-chain registry determines " +
        "readRequired and cannot be read from the draft alone. Provide a ReadinessConsent only after confirming the policy.",
    };
  }
  return {
    required: false,
    note: "P-11: deals longer than 3h use the registered no-readiness policy; readinessTypedData is omitted.",
  };
}

/**
 * Build the funding bundle for a draft. Throws a 404-tagged error when the
 * draft is unknown and a 400-tagged error when the terms/deployment cannot
 * produce a digest.
 */
export async function buildFundingBundle(
  store: Store,
  deps: FundingDeps,
  draftId: string,
  nowSeconds: number,
): Promise<FundingBundle> {
  const draft = await store.getDraft(draftId);
  if (!draft) throw httpError(404, "Draft not found");
  const terms = draft.terms as CanonicalTerms;

  const hubValue = deps.hub ?? terms["hub"];
  if (typeof hubValue !== "string" || !ADDRESS_RE.test(hubValue)) {
    throw httpError(400, "hub is not configured (set HUB_ADDRESS or draft.terms.hub)");
  }
  const hub = hubValue as Address;

  const chainIdValue = deps.chainId ?? (terms["chainId"] ? Number(terms["chainId"]) : null);
  if (chainIdValue === null || !Number.isInteger(chainIdValue) || chainIdValue <= 0) {
    throw httpError(400, "chainId is not configured (set BASE_CHAIN_ID or draft.terms.chainId)");
  }
  const chainId = chainIdValue;

  const usdcValue = deps.usdc ?? terms["token"];
  if (typeof usdcValue !== "string" || !ADDRESS_RE.test(usdcValue)) {
    throw httpError(400, "usdc is not configured (set USDC_ADDRESS or draft.terms.token)");
  }
  const usdc = usdcValue as Address;

  const { fullTerms, agreementDigest } = buildFullTerms(terms, hub);

  const buyerAddress = fullTerms["buyerAddress"] as Address;
  // The contract signs FundWithAllowance over t.buyerAddress (MidmanHub.sol
  // line 331); canonical buyerRefundAddress equals buyerAddress by default.
  const payer = buyerAddress;

  const paymentSalt = randomHash();
  const allowanceNonce = randomHash();
  const allowanceExpiresAt = String(nowSeconds + ALLOWANCE_WINDOW_SECONDS);

  const allowance = fundWithAllowanceTypedData({
    chainId,
    hub,
    dealId: fullTerms["dealId"]!,
    agreementDigest,
    payer,
    amountUnits: terms["fundedUnits"] ?? "0",
    paymentSalt,
    nonce: allowanceNonce,
    expiresAt: allowanceExpiresAt,
  });

  const { required: readinessRequired, note: readinessPolicyNote } = resolveReadiness(terms);
  // Fresh attestation params are always issued so the buyer can sign a
  // consent when the policy requires it; the typed envelope exists only then.
  const readinessAttestedAt = String(nowSeconds);
  const readinessNonce = randomHash();
  const readinessExpiresAt = String(nowSeconds + READINESS_EXPIRY_SECONDS);
  const readinessTypedData =
    readinessRequired === true
      ? readinessConsentTypedData({
          chainId,
          hub,
          dealId: fullTerms["dealId"]!,
          agreementDigest,
          buyer: buyerAddress,
          attestedAt: readinessAttestedAt,
          nonce: readinessNonce,
          expiresAt: readinessExpiresAt,
        })
      : null;

  const signatures = (draft.signatures ?? {}) as Record<string, string>;
  const sigOrNull = (role: DealRole): string | null => {
    const sig = signatures[`dealTerms:${role}`];
    return typeof sig === "string" && sig !== "" ? sig : null;
  };
  // Operator-granted admission stored via POST /drafts/:id/admission (which
  // validates the struct). Anything else is not a grant.
  const grantedRaw = draft.admission;
  const granted =
    grantedRaw !== null &&
    typeof grantedRaw === "object" &&
    typeof grantedRaw["minPolicyId"] === "string" &&
    typeof grantedRaw["admissionNonce"] === "string" &&
    typeof grantedRaw["expiresAt"] === "string" &&
    typeof grantedRaw["signature"] === "string"
      ? (grantedRaw as Record<string, string>)
      : null;

  const principalUnits = terms["principalUnits"] ?? fullTerms["principal"] ?? "0";

  return {
    draftId: draft.id,
    dealId: draft.dealId,
    hub,
    token: usdc,
    chainId,
    principalUnits,
    fundedUnits: terms["fundedUnits"] ?? "0",
    prepaidBuyerFeeUnits: terms["prepaidBuyerFeeUnits"] ?? "0",
    fullTerms,
    agreementDigest,
    dealTermsTypedData: dealTermsTypedData(chainId, hub, fullTerms),
    signatures: { buyer: sigOrNull("buyer"), seller: sigOrNull("seller") },
    allowance: {
      paymentSalt,
      nonce: allowanceNonce,
      expiresAt: allowanceExpiresAt,
      typedData: allowance,
    },
    readiness: {
      required: readinessRequired,
      note: readinessPolicyNote,
      attestedAt: readinessAttestedAt,
      nonce: readinessNonce,
      expiresAt: readinessExpiresAt,
      typedData: readinessTypedData,
    },
    admission: {
      note: ADMISSION_POLICY_NOTE,
      granted,
    },
    requiredSignatures: ["buyer", "seller"] as const,
    relayActionTemplate: { action: "fund", params: { dealId: draft.dealId } },
  };
}

/**
 * Verify `signature` recovers to the role's deal party over the full
 * DealTerms typed data, then persist it under `dealTerms:<role>` in the
 * draft's signatures map. Throws a 400-tagged error on any mismatch.
 */
export async function storeDealSignature(
  store: Store,
  draftId: string,
  role: string,
  signature: string,
): Promise<{ ok: true; role: DealRole; signer: Address }> {
  if (role !== "buyer" && role !== "seller") throw httpError(400, "Role must be buyer or seller");
  if (typeof signature !== "string" || !HEX_RE.test(signature)) throw httpError(400, "Invalid signature");

  const draft = await store.getDraft(draftId);
  if (!draft) throw httpError(404, "Draft not found");
  const terms = draft.terms as CanonicalTerms;
  const hubValue = terms["hub"];
  if (typeof hubValue !== "string" || !ADDRESS_RE.test(hubValue)) throw httpError(400, "Draft hub is invalid");
  const chainId = Number(terms["chainId"]);
  if (!Number.isInteger(chainId) || chainId <= 0) throw httpError(400, "Draft chainId is invalid");

  const { fullTerms } = buildFullTerms(terms, hubValue as Address);
  const typed = dealTermsTypedData(chainId, hubValue as Address, fullTerms);
  const expected = (role === "buyer" ? terms["buyer"] : terms["seller"]) as Address;
  if (typeof expected !== "string" || !ADDRESS_RE.test(expected)) {
    throw httpError(400, `Draft has no valid ${role} address`);
  }

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: typed.domain,
      types: typed.types,
      primaryType: "DealTerms",
      message: typed.message,
      signature: signature as Hash,
    } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
  } catch {
    throw httpError(400, "Unrecoverable deal signature");
  }
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    throw httpError(400, "Signature does not recover to the expected party");
  }

  await store.updateDraft(draftId, {
    signatures: { ...draft.signatures, [`dealTerms:${role}`]: signature },
  });
  return { ok: true, role, signer: recovered };
}
