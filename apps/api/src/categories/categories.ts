// Per-category delivery form schemas (specs/policy-register.md P-12) plus the
// delivery-data validator. Pure module: no Store, no network, no secrets echoed.
import { createHash } from "node:crypto";
import { CATEGORY_MINIMUMS } from "../terms.js";
import { scanTextForSecrets } from "./secrets.js";

export type DeliveryFieldType = "text" | "uint" | "hash" | "boolean";

export interface DeliveryFieldSchema {
  readonly name: string;
  readonly label: string;
  readonly type: DeliveryFieldType;
  readonly required: boolean;
  readonly maxLen?: number;
  /** Exact character length required (identifierLast4). */
  readonly exactLen?: number;
}

export interface CategorySchema {
  readonly id: string;
  readonly fields: readonly DeliveryFieldSchema[];
  readonly completionCriteria: string;
  /** Minimum inspection seconds (P-12 table; mirrors CATEGORY_MINIMUMS). */
  readonly minInspection: number;
}

const INSTANT_CODE: CategorySchema = {
  id: "INSTANT_CODE",
  fields: [
    { name: "redemptionMethod", label: "Redemption method", type: "text", required: true, maxLen: 200 },
    { name: "identifierLast4", label: "Identifier (last 4 characters only)", type: "text", required: true, maxLen: 4, exactLen: 4 },
    { name: "notes", label: "Notes", type: "text", required: false, maxLen: 2000 },
  ],
  completionCriteria:
    "Code/key delivered via designated non-chat channel; delivery manifest hash commits to redemption method + obscured identifier (last 4 only, never full secret in commitment/preview)",
  minInspection: CATEGORY_MINIMUMS["INSTANT_CODE"]!,
};

const GAME_ITEM: CategorySchema = {
  id: "GAME_ITEM",
  fields: [
    { name: "itemName", label: "Item name", type: "text", required: true, maxLen: 200 },
    { name: "recipientId", label: "Recipient ID", type: "text", required: true, maxLen: 200 },
    { name: "tradeId", label: "Trade ID", type: "text", required: false, maxLen: 200 },
    { name: "transferNote", label: "Transfer note", type: "text", required: false, maxLen: 2000 },
  ],
  completionCriteria: "Item transfer to designated recipient ID; trade-ID / screenshot hash",
  minInspection: CATEGORY_MINIMUMS["GAME_ITEM"]!,
};

const GAME_CURRENCY: CategorySchema = {
  id: "GAME_CURRENCY",
  fields: [
    { name: "amount", label: "Amount (base units, decimal string)", type: "uint", required: true },
    { name: "recipientId", label: "Recipient ID", type: "text", required: true, maxLen: 200 },
    { name: "recordId", label: "Transaction/record ID", type: "text", required: false, maxLen: 200 },
  ],
  completionCriteria: "Amount + recipient ID + transaction/record ID",
  minInspection: CATEGORY_MINIMUMS["GAME_CURRENCY"]!,
};

const DIGITAL_GOOD: CategorySchema = {
  id: "DIGITAL_GOOD",
  fields: [
    { name: "fileHash", label: "File hash (64 hex characters)", type: "hash", required: true },
    { name: "version", label: "Version", type: "text", required: true, maxLen: 100 },
  ],
  completionCriteria: "File/delivery + version hash",
  minInspection: CATEGORY_MINIMUMS["DIGITAL_GOOD"]!,
};

const SERVICE: CategorySchema = {
  id: "SERVICE",
  fields: [
    { name: "milestone", label: "Milestone description", type: "text", required: true, maxLen: 500 },
    { name: "workHash", label: "Work product hash (64 hex characters)", type: "hash", required: false },
    { name: "completionNote", label: "Completion note", type: "text", required: false, maxLen: 2000 },
  ],
  completionCriteria: "Milestone description + completion attestation",
  minInspection: CATEGORY_MINIMUMS["SERVICE"]!,
};

const GAME_ACCOUNT: CategorySchema = {
  id: "GAME_ACCOUNT",
  fields: [
    { name: "accountIdentifier", label: "Account identifier (non-secret)", type: "text", required: true, maxLen: 200 },
    { name: "transferMethod", label: "Transfer method", type: "text", required: true, maxLen: 500 },
    {
      name: "noCredentialStorageAttestation",
      label: "Attestation: no credentials were stored on the platform",
      type: "boolean",
      required: true,
    },
    { name: "postSettlementNote", label: "Post-settlement note", type: "text", required: false, maxLen: 2000 },
  ],
  completionCriteria:
    "Account identifier (non-secret), transfer of credentials via approved out-of-band method (never platform chat/evidence), post-settlement account-report handling per category policy",
  minInspection: CATEGORY_MINIMUMS["GAME_ACCOUNT"]!,
};

const SCHEMAS: Record<string, CategorySchema> = {
  INSTANT_CODE,
  GAME_ITEM,
  GAME_CURRENCY,
  DIGITAL_GOOD,
  SERVICE,
  GAME_ACCOUNT,
};

export const CATEGORY_ORDER: readonly string[] = [
  "INSTANT_CODE",
  "GAME_ITEM",
  "GAME_CURRENCY",
  "DIGITAL_GOOD",
  "SERVICE",
  "GAME_ACCOUNT",
];

export function getCategory(id: string): CategorySchema | null {
  return SCHEMAS[id] ?? null;
}

const UINT_RE = /^[0-9]+$/;
const HASH_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Validate delivery-form data for a category. Runs scanTextForSecrets over
 * EVERY string field; any hit is an error that names the field and the finding
 * codes but never echoes the secret. The game-account attestation MUST be true.
 */
export function validateDelivery(category: string, data: unknown): { ok: boolean; errors: string[] } {
  const schema = getCategory(category);
  if (!schema) return { ok: false, errors: [`Unknown category: ${category}`] };
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, errors: ["Delivery data must be an object"] };
  }
  const record = data as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of schema.fields) {
    const value = record[field.name];
    if (isMissing(value)) {
      if (field.required) errors.push(`Field "${field.name}" is required`);
      continue;
    }
    // Secret hygiene runs over EVERY string field, regardless of declared
    // type: any hit is an error naming the field and the finding codes, and
    // the secret itself is never echoed.
    if (typeof value === "string" && value.length > 0) {
      const hits = scanTextForSecrets(value);
      if (hits.length > 0) errors.push(`Field "${field.name}" contains blocked content: ${hits.join(",")}`);
    }
    switch (field.type) {
      case "boolean": {
        if (typeof value !== "boolean") {
          errors.push(`Field "${field.name}" must be a boolean`);
        } else if (field.name === "noCredentialStorageAttestation" && value !== true) {
          errors.push(
            `Field "${field.name}" must be true: credentials must never be stored on the platform`,
          );
        }
        break;
      }
      case "uint": {
        if (typeof value !== "string" || !UINT_RE.test(value)) {
          errors.push(`Field "${field.name}" must be a decimal uint string`);
        } else {
          let amount = 0n;
          try {
            amount = BigInt(value);
          } catch {
            errors.push(`Field "${field.name}" must be a decimal uint string`);
            break;
          }
          if (amount <= 0n) errors.push(`Field "${field.name}" must be greater than zero`);
        }
        break;
      }
      case "hash": {
        if (typeof value !== "string" || !HASH_RE.test(value)) {
          errors.push(`Field "${field.name}" must be 64 hex characters`);
        }
        break;
      }
      case "text": {
        if (typeof value !== "string") {
          errors.push(`Field "${field.name}" must be a string`);
        } else {
          if (field.maxLen !== undefined && value.length > field.maxLen) {
            errors.push(`Field "${field.name}" exceeds max length ${field.maxLen}`);
          }
          if (field.exactLen !== undefined && value.length !== field.exactLen) {
            errors.push(`Field "${field.name}" must be exactly ${field.exactLen} characters`);
          }
        }
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Canonical JSON: object keys sorted recursively, so hashes are stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unserializable delivery data");
  return encoded;
}

/** sha256 (0x bytes32 hex) of the canonical delivery manifest: {dealId, category, data}. */
export function hashDeliveryManifest(dealId: string, category: string, data: Record<string, unknown>): string {
  const canonical = canonicalJson({ category, data, dealId });
  return `0x${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
