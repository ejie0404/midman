// Verified deal configuration + agreement binding for apps/web (Phase 4).
//
// Agreement construction must NOT invent policy maps or use the creator wallet
// as the fee recipients. The API exposes GET /config/deal-defaults (built from
// env / the registered policy manifest) with the hub, USDC, chain id, the eight
// canonical policy ids, and the platformFeeRecipient /
// arbitrationCostRecipient. This module validates that payload and produces the
// exact agreement binding embedded in the draft's terms and signed in the
// canonical 32-field MidmanEscrow DealTerms struct.
//
// Only erasable TypeScript is used so Node 24 can import this file directly in
// tests (no enums, namespaces, or parameter properties).

import { ApiValidationError } from "@midman/api-client";
import { API_BASE } from "./api.ts";

/** The eight canonical policy slots (mirrors @midman/chain DealTerms). */
export const POLICY_KEYS = [
  "fee",
  "category",
  "readiness",
  "evidence",
  "bond",
  "arbitration",
  "outage",
  "catastrophic",
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];

/** Maps a policy slot to its DealTerms policy id key. */
export const POLICY_ID_FIELD: Record<PolicyKey, string> = {
  fee: "feePolicyId",
  category: "categoryPolicyId",
  readiness: "readinessPolicyId",
  evidence: "evidencePolicyId",
  bond: "bondPolicyId",
  arbitration: "arbitrationPolicyId",
  outage: "outagePolicyId",
  catastrophic: "catastrophicPolicyId",
};

export interface DealDefaults {
  readonly hub: string;
  readonly usdc: string;
  readonly chainId: number;
  readonly policyIds: Readonly<Record<PolicyKey, string>>;
  readonly platformFeeRecipient: string;
  readonly arbitrationCostRecipient: string;
}

export interface DealDefaultsFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiValidationError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asAddress(value: unknown, path: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new ApiValidationError(path, "expected a 0x + 40 hex address");
  }
  return value;
}

function asHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new ApiValidationError(path, "expected 0x + 64 hex");
  }
  return value;
}

function asPositiveInt(value: unknown, path: string): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new ApiValidationError(path, "expected a positive integer");
  }
  return n;
}

/** Validate the GET /config/deal-defaults payload; throws on any mismatch. */
export function validateDealDefaults(raw: unknown): DealDefaults {
  const obj = asRecord(raw, "$");
  const source = asRecord(obj["policyIds"], "$.policyIds");
  const policyIds = {} as Record<PolicyKey, string>;
  for (const key of POLICY_KEYS) {
    policyIds[key] = asHash(source[key], `$.policyIds.${key}`);
  }
  const extra = Object.keys(source).filter((key) => !(POLICY_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) {
    throw new ApiValidationError("$.policyIds", `unexpected policy ids: ${extra.join(", ")}`);
  }
  return {
    hub: asAddress(obj["hub"], "$.hub"),
    usdc: asAddress(obj["usdc"], "$.usdc"),
    chainId: asPositiveInt(obj["chainId"], "$.chainId"),
    policyIds,
    platformFeeRecipient: asAddress(obj["platformFeeRecipient"], "$.platformFeeRecipient"),
    arbitrationCostRecipient: asAddress(obj["arbitrationCostRecipient"], "$.arbitrationCostRecipient"),
  };
}

function resolveBase(baseUrl?: string): string {
  const explicit =
    baseUrl ?? (typeof process !== "undefined" ? process.env["NEXT_PUBLIC_API_URL"] : undefined) ?? API_BASE;
  return explicit.replace(/\/+$/, "");
}

/** GET /config/deal-defaults, validated. Throws ApiError/ApiValidationError. */
export async function fetchDealDefaults(options: DealDefaultsFetchOptions = {}): Promise<DealDefaults> {
  const impl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await impl(`${resolveBase(options.baseUrl)}/config/deal-defaults`, {
      method: "GET",
      credentials: "include",
    });
  } catch (error) {
    throw new ApiValidationError("$.network", error instanceof Error ? error.message : "network unreachable");
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (parsed && typeof parsed.error === "string") message = parsed.error;
    } catch {
      // keep raw text
    }
    throw new ApiValidationError(`GET /config/deal-defaults (${res.status})`, message);
  }
  return validateDealDefaults(text ? JSON.parse(text) : {});
}

export interface AgreementBinding {
  readonly hub: string;
  readonly token: string;
  readonly chainId: number;
  /** policy slot -> bytes32 id, for the 8 DealTerms policy fields. */
  readonly policyIds: Readonly<Record<PolicyKey, string>>;
  readonly platformFeeRecipient: string;
  readonly arbitrationCostRecipient: string;
}

/** The agreement-binding fields derived ONLY from verified configuration. */
export function agreementBindingFromDefaults(defaults: DealDefaults): AgreementBinding {
  return {
    hub: defaults.hub,
    token: defaults.usdc,
    chainId: defaults.chainId,
    policyIds: { ...defaults.policyIds },
    platformFeeRecipient: defaults.platformFeeRecipient,
    arbitrationCostRecipient: defaults.arbitrationCostRecipient,
  };
}

/**
 * Merge verified configuration into draft terms. The returned object is
 * suitable for POST /drafts: it carries the real hub/token/chainId, the eight
 * policy ids (never an empty map), and the configured recipients — never the
 * creator wallet.
 */
export function withAgreementBinding<T extends Record<string, unknown>>(
  terms: T,
  defaults: DealDefaults,
): T & {
  hub: string;
  token: string;
  chainId: number;
  policyIds: Readonly<Record<PolicyKey, string>>;
  platformFeeRecipient: string;
  arbitrationCostRecipient: string;
} {
  const binding = agreementBindingFromDefaults(defaults);
  return {
    ...terms,
    hub: binding.hub,
    token: binding.token,
    chainId: binding.chainId,
    policyIds: binding.policyIds,
    platformFeeRecipient: binding.platformFeeRecipient,
    arbitrationCostRecipient: binding.arbitrationCostRecipient,
  };
}

export interface AgreementDisplay {
  readonly hub: string;
  readonly token: string;
  readonly chainId: number;
  readonly policies: readonly { readonly slot: PolicyKey; readonly id: string }[];
  readonly platformFeeRecipient: string;
  readonly arbitrationCostRecipient: string;
}

/** Human-reviewable summary shown BEFORE signing acceptance/funding. */
export function describeAgreement(defaults: DealDefaults): AgreementDisplay {
  return {
    hub: defaults.hub,
    token: defaults.usdc,
    chainId: defaults.chainId,
    policies: POLICY_KEYS.map((slot) => ({ slot, id: defaults.policyIds[slot] })),
    platformFeeRecipient: defaults.platformFeeRecipient,
    arbitrationCostRecipient: defaults.arbitrationCostRecipient,
  };
}
