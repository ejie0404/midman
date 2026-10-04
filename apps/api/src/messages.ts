// Deal chat messages: validation + record building. Storage lives in
// categories/registry.ts (MessageThreadRegistry); route wiring lives in
// categories/routes.ts.
import { scanTextForSecrets } from "./categories/secrets.js";

export const MAX_MESSAGE_CHARS = 2000;

export interface ChatMessage {
  readonly seq: number;
  readonly author: string;
  readonly text: string;
  readonly at: string;
}

/**
 * Validate message text: must be a non-empty string of at most 2000 chars
 * with no secret material. Errors name the finding codes, never the secret.
 */
export function validateMessageText(text: unknown): { ok: boolean; errors: string[] } {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, errors: ["Message text is required"] };
  }
  const errors: string[] = [];
  if (text.length > MAX_MESSAGE_CHARS) {
    errors.push(`Message text exceeds max length ${MAX_MESSAGE_CHARS}`);
  }
  const hits = scanTextForSecrets(text);
  if (hits.length > 0) errors.push(`Message text contains blocked content: ${hits.join(",")}`);
  return { ok: errors.length === 0, errors };
}

export function buildMessageRecord(seq: number, author: string, text: string, at?: string): ChatMessage {
  return { seq, author, text, at: at ?? new Date().toISOString() };
}
