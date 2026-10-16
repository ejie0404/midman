// Automated funding admission (risk role). The hub refuses fund() without a
// FundingAdmission signed by policies.admissionSigner() over the exact
// agreement digest, so this service is the gate every deal passes through.
// The admission key can only ALLOW new funding; it cannot settle, redirect or
// touch funded deals, which is why it may run as a hot key on the API host.
//
// A grant is issued only when every rule holds:
//   - the service is configured (ADMISSION_SIGNER_KEY) and not paused
//     (ADMISSION_PAUSED=1 is the kill switch),
//   - both parties have signed the full DealTerms,
//   - the draft's binding (recipients, hub, token, chain, policy ids) equals
//     the deployment defaults (no fee/arbitration-cost redirection),
//   - no party/recipient address is on ADMISSION_DENYLIST,
//   - principal <= ADMISSION_MAX_PRINCIPAL_UNITS (guarded launch cap),
//   - hub liabilities + this deal <= ADMISSION_MAX_EXPOSURE_UNITS (TVL cap,
//     fail closed when liabilities cannot be read),
//   - the buyer/seller pair's admitted volume in 24h stays within
//     AGGREGATE_PAIR_CAP_UNITS_PER_24H (split-deal abuse).
// Operators can still grant manually via POST /drafts/:id/admission.
import { randomBytes } from "node:crypto";
import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { ChainReader } from "@midman/chain";
import type { Store } from "../db.js";
import { auditLog } from "../audit.js";
import { buildDealDefaults, categoryPolicyIdFor, POLICY_KEYS } from "../dealsMeta.js";
import { buildFullTerms } from "../fullTerms.js";
import { fundingAdmissionTypedData } from "../chainActions.js";
import type { CanonicalTerms } from "../terms.js";

export const DEFAULT_ADMISSION_TTL_SECONDS = 86_400;
const PAIR_WINDOW_SECONDS = 86_400;
const PAIR_SCOPE = "admission-pair";

export interface AdmissionRules {
  readonly paused: boolean;
  readonly maxPrincipalUnits: bigint | null;
  readonly maxExposureUnits: bigint | null;
  readonly pairCapUnits24h: bigint | null;
  readonly denylist: ReadonlySet<string>;
  readonly ttlSeconds: number;
}

export interface AdmissionGrant {
  readonly minPolicyId: string;
  readonly admissionNonce: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export type AdmissionDecision =
  | { readonly ok: true; readonly admission: AdmissionGrant; readonly reused: boolean }
  | { readonly ok: false; readonly status: number; readonly reason: string };

export interface AdmissionDeps {
  readonly store: Store;
  readonly reader: ChainReader | null;
  readonly hub: Address | null;
}

function optionalUnits(raw: string | undefined): bigint | null {
  const value = (raw ?? "").trim();
  if (value === "" || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}

export function admissionRulesFromEnv(env: NodeJS.ProcessEnv = process.env): AdmissionRules {
  const ttl = Number(env["ADMISSION_TTL_SECONDS"] ?? DEFAULT_ADMISSION_TTL_SECONDS);
  return {
    paused: env["ADMISSION_PAUSED"] === "1",
    maxPrincipalUnits: optionalUnits(env["ADMISSION_MAX_PRINCIPAL_UNITS"]),
    maxExposureUnits: optionalUnits(env["ADMISSION_MAX_EXPOSURE_UNITS"]),
    pairCapUnits24h: optionalUnits(env["AGGREGATE_PAIR_CAP_UNITS_PER_24H"]),
    denylist: new Set(
      (env["ADMISSION_DENYLIST"] ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
    ttlSeconds: Number.isInteger(ttl) && ttl > 0 && ttl <= DEFAULT_ADMISSION_TTL_SECONDS ? ttl : DEFAULT_ADMISSION_TTL_SECONDS,
  };
}

/** Admission signer from ADMISSION_SIGNER_KEY; null when the service is not configured. */
export function admissionSignerFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount | null {
  const raw = (env["ADMISSION_SIGNER_KEY"] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return privateKeyToAccount(raw as Hex);
}

const deny = (status: number, reason: string): AdmissionDecision => ({ ok: false, status, reason });

/** Binding fields that must equal the deployment defaults. */
function bindingMismatch(terms: CanonicalTerms, env: NodeJS.ProcessEnv): string | null {
  let defaults;
  let categoryPolicy: string | null;
  try {
    defaults = buildDealDefaults(env);
    categoryPolicy = categoryPolicyIdFor(String(terms["category"] ?? ""), env);
  } catch (error) {
    return `deployment defaults unavailable (${error instanceof Error ? error.message : "invalid"})`;
  }
  const same = (a: string | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();
  if (!same(terms["platformFeeRecipient"], defaults.platformFeeRecipient)) return "platformFeeRecipient";
  if (!same(terms["arbitrationCostRecipient"], defaults.arbitrationCostRecipient)) return "arbitrationCostRecipient";
  if (!same(terms["hub"], defaults.hub)) return "hub";
  if (!same(terms["token"], defaults.usdc)) return "token";
  if (Number(terms["chainId"]) !== defaults.chainId) return "chainId";
  for (const key of POLICY_KEYS) {
    const expected = key === "category" && categoryPolicy !== null ? categoryPolicy : defaults.policyIds[key];
    if (!same(terms[`policy:${key}`], expected)) return `policy:${key}`;
  }
  return null;
}

interface PairEntry {
  readonly units: string;
  readonly at: number;
}

function pairKey(buyer: string, seller: string): string {
  return `${buyer.toLowerCase()}:${seller.toLowerCase()}`;
}

async function pairVolume(store: Store, key: string, nowSeconds: number): Promise<{ total: bigint; entries: PairEntry[] }> {
  const raw = (await store.authGet(PAIR_SCOPE, key)) as PairEntry[] | null;
  const entries = (Array.isArray(raw) ? raw : []).filter((entry) => nowSeconds - entry.at < PAIR_WINDOW_SECONDS);
  return { total: entries.reduce((sum, entry) => sum + BigInt(entry.units), 0n), entries };
}

/**
 * Decide and (when allowed) sign a FundingAdmission for a draft. Idempotent:
 * an unexpired grant already on the draft is returned as-is.
 */
export async function requestAdmission(
  deps: AdmissionDeps,
  draftId: string,
  options: {
    readonly nowSeconds?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly signer?: PrivateKeyAccount | null;
    readonly rules?: AdmissionRules;
  } = {},
): Promise<AdmissionDecision> {
  const env = options.env ?? process.env;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const signer = options.signer !== undefined ? options.signer : admissionSignerFromEnv(env);
  const rules = options.rules ?? admissionRulesFromEnv(env);

  if (signer === null) return deny(503, "Automated admission is not configured (ADMISSION_SIGNER_KEY)");
  if (rules.paused) return deny(503, "Admission is paused");

  const draft = await deps.store.getDraft(draftId);
  if (!draft) return deny(404, "Draft not found");
  const terms = draft.terms as CanonicalTerms;

  const existing = draft.admission as Record<string, string> | null;
  if (
    existing &&
    typeof existing["signature"] === "string" &&
    typeof existing["expiresAt"] === "string" &&
    Number(existing["expiresAt"]) > now + 300
  ) {
    return {
      ok: true,
      reused: true,
      admission: {
        minPolicyId: existing["minPolicyId"]!,
        admissionNonce: existing["admissionNonce"]!,
        expiresAt: existing["expiresAt"]!,
        signature: existing["signature"]!,
      },
    };
  }

  const signatures = (draft.signatures ?? {}) as Record<string, string>;
  if (!signatures["dealTerms:buyer"] || !signatures["dealTerms:seller"]) {
    return deny(409, "Both parties must sign the deal terms before admission");
  }

  const mismatch = bindingMismatch(terms, env);
  if (mismatch !== null) return deny(403, `Draft binding does not match the deployment: ${mismatch}`);

  const parties = ["buyer", "seller", "sellerPayout", "buyerRefund", "buyerBondRefund", "sellerBondRefund"]
    .map((field) => (terms[field] ?? "").toLowerCase())
    .filter(Boolean);
  if (parties.some((address) => rules.denylist.has(address))) return deny(403, "A party or recipient is not admitted");

  const principal = BigInt(terms["principalUnits"] ?? "0");
  const funded = BigInt(terms["fundedUnits"] ?? terms["principalUnits"] ?? "0");
  if (rules.maxPrincipalUnits !== null && principal > rules.maxPrincipalUnits) {
    return deny(403, `Principal exceeds the current per-deal limit (${rules.maxPrincipalUnits} units)`);
  }

  if (rules.maxExposureUnits !== null) {
    if (!deps.reader || !deps.hub) return deny(503, "Exposure cap configured but the hub cannot be read");
    let liabilities: bigint;
    try {
      liabilities = await deps.reader.getLiabilities(deps.hub);
    } catch {
      return deny(503, "Hub liabilities could not be read (exposure cap fails closed)");
    }
    if (liabilities + funded > rules.maxExposureUnits) return deny(403, "Platform exposure limit reached; try again later");
  }

  const key = pairKey(terms["buyer"] ?? "", terms["seller"] ?? "");
  const pair = await pairVolume(deps.store, key, now);
  if (rules.pairCapUnits24h !== null && pair.total + funded > rules.pairCapUnits24h) {
    return deny(403, "This buyer/seller pair has reached its 24h volume limit");
  }

  let agreementDigest: Hash;
  try {
    agreementDigest = buildFullTerms(terms, terms["hub"] as Address).agreementDigest;
  } catch (error) {
    return deny(400, `Draft terms are incomplete (${error instanceof Error ? error.message : "invalid"})`);
  }
  const minPolicyId = terms["policy:category"] ?? "";
  const admissionNonce = `0x${randomBytes(32).toString("hex")}`;
  const expiresAt = String(now + rules.ttlSeconds);
  const typed = fundingAdmissionTypedData({
    chainId: Number(terms["chainId"]),
    hub: terms["hub"] as Address,
    agreementDigest,
    minPolicyId,
    admissionNonce,
    expiresAt,
    expectedUnfunded: true,
  });
  const signature = await signer.signTypedData(typed as unknown as Parameters<PrivateKeyAccount["signTypedData"]>[0]);

  const admission: AdmissionGrant = { minPolicyId, admissionNonce, expiresAt, signature };
  await deps.store.updateDraft(draft.id, { admission: { ...admission }, status: "admitted" });
  await deps.store.authPut(
    PAIR_SCOPE,
    key,
    [...pair.entries, { units: funded.toString(), at: now }],
    // Row TTL is wall-clock (the store expires rows against real time).
    new Date(Date.now() + PAIR_WINDOW_SECONDS * 1_000).toISOString(),
  );
  auditLog({
    actor: signer.address,
    action: "draft.admission.auto",
    dealId: draft.dealId,
    details: { principalUnits: principal.toString(), expiresAt },
  });
  return { ok: true, reused: false, admission };
}
