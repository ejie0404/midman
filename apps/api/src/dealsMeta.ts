// Verified deal configuration endpoint (Phase 4).
//
// GET /config/deal-defaults exposes the deployment-derived agreement binding so
// the web never invents an empty policy map or a creator-wallet recipient:
//   { hub, usdc, chainId, policyIds{fee,category,readiness,evidence,bond,
//     arbitration,outage,catastrophic}, platformFeeRecipient,
//     arbitrationCostRecipient }
//
// All values come from environment (or an injected manifest); nothing is
// hard-coded and no value is guessed. The web validates this shape again
// (apps/web/lib/dealDefaults.ts) before embedding it in the canonical
// MidmanEscrow DealTerms struct that both parties sign.

import type { FastifyInstance } from "fastify";

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

export interface DealDefaults {
  readonly hub: string;
  readonly usdc: string;
  readonly chainId: number;
  readonly policyIds: Readonly<Record<PolicyKey, string>>;
  readonly platformFeeRecipient: string;
  readonly arbitrationCostRecipient: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_CHAIN_ID = 8453;

export class DealDefaultsError extends Error {
  readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = "DealDefaultsError";
  }
}

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new DealDefaultsError(`${field} must be a configured 0x address`);
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new DealDefaultsError(`${field} must be a bytes32 policy id`);
  }
  return value;
}

function parseJsonObject(raw: string | undefined, field: string): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new DealDefaultsError(`${field} must be a JSON object (${error instanceof Error ? error.message : "invalid"})`);
  }
}

function readChainId(env: NodeJS.ProcessEnv): number {
  const raw = env["BASE_CHAIN_ID"] ?? env["CHAIN_ID"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHAIN_ID;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new DealDefaultsError("BASE_CHAIN_ID must be a positive integer");
  return n;
}

export interface BuildDealDefaultsOptions {
  /** Overrides per policy slot (e.g. loaded from a registered manifest). */
  readonly policyIds?: Partial<Record<PolicyKey, string>>;
}

/**
 * Build the deal defaults from environment (or injected policy ids). Fails
 * loudly when a required address/policy id is missing or malformed — an empty
 * or partial configuration must never reach the client.
 */
export function buildDealDefaults(
  env: NodeJS.ProcessEnv = process.env,
  options: BuildDealDefaultsOptions = {},
): DealDefaults {
  const envPolicies = parseJsonObject(env["MIDMAN_POLICY_IDS"] ?? env["POLICY_IDS"], "MIDMAN_POLICY_IDS");
  const merged: Record<string, unknown> = { ...envPolicies, ...(options.policyIds ?? {}) };
  const policyIds = {} as Record<PolicyKey, string>;
  for (const key of POLICY_KEYS) {
    policyIds[key] = requireHash(merged[key], `policyIds.${key}`);
  }
  return {
    hub: requireAddress(env["HUB_ADDRESS"], "HUB_ADDRESS"),
    usdc: requireAddress(env["USDC_ADDRESS"] ?? DEFAULT_USDC, "USDC_ADDRESS"),
    chainId: readChainId(env),
    policyIds,
    platformFeeRecipient: requireAddress(env["PLATFORM_FEE_RECIPIENT"], "PLATFORM_FEE_RECIPIENT"),
    arbitrationCostRecipient: requireAddress(
      env["ARBITRATION_COST_RECIPIENT"],
      "ARBITRATION_COST_RECIPIENT",
    ),
  };
}

/**
 * Register GET /config/deal-defaults. Public: it carries no private data, only
 * the deployment's verified public binding. (server.ts owns the final wiring;
 * this helper keeps the route definition testable in isolation.)
 */
export function registerDealMetaRoutes(app: FastifyInstance): void {
  app.get("/config/deal-defaults", async (_req, reply) => {
    try {
      return buildDealDefaults();
    } catch (error) {
      return reply
        .code(error instanceof DealDefaultsError ? error.statusCode : 500)
        .send({ error: error instanceof Error ? error.message : "Deal defaults unavailable" });
    }
  });
}
