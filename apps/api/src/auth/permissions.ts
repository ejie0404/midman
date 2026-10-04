// Authorization primitives: session auth, draft/deal party checks, operator
// role checks, and invitation-token enforcement.
//
// Layering:
//   - requireAuth: a valid signed session cookie (no signed request needed).
//   - requireParty: session wallet matches the draft/deal buyer or seller
//     (chain participants supported via an optional resolver).
//   - requireOperator: BOTH a valid session AND a valid EIP-191 signed request
//     (evidence/access scheme), AND the wallet must be allow-listed for the
//     role via OPERATOR_<ROLE>_WALLETS. A session alone is never sufficient.
import type { FastifyRequest } from "fastify";
import type { Address } from "viem";
import { verifySignedRequest } from "../evidence/access.js";
import { hashInvitationToken, isInvitationUsable } from "../invitations.js";
import {
  getAuthPersistence,
  setAuthPersistence,
  MemoryAuthPersistence,
  type RedeemInvitationResult,
  type StoredInvitation,
} from "./persistence.js";
import { readSession, type Session } from "./session.js";

export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export interface AuthedRequest extends FastifyRequest {
  session?: Session | null;
}

/** Require a valid session; throws 401 otherwise. */
export function requireAuth(req: FastifyRequest): Session {
  const session = (req as AuthedRequest).session ?? readSession(req);
  if (!session) throw httpError(401, "Authentication required");
  return session;
}

/** Minimal structural store shape (avoids importing routes.ts cycles). */
export interface PartyDraft {
  readonly id: string;
  readonly dealId: string;
  readonly creatorWallet: string;
  readonly counterpartyHint: string | null;
  readonly counterpartyAddress: string | null;
  readonly terms: Record<string, string>;
}

export interface PartyStore {
  getDraft(id: string): Promise<PartyDraft | null>;
  getDraftByDeal(dealId: string): Promise<PartyDraft | null>;
}

export type PartyRole = "buyer" | "seller";
export type ResolvedRole = PartyRole | "creator";

/** Optional chain/deal resolver: returns a role for chain-known participants. */
export type PartyResolver = (dealId: string, wallet: string) => Promise<PartyRole | null>;

async function resolveDraft(store: PartyStore, idOrDealId: string): Promise<PartyDraft | null> {
  const byId = await store.getDraft(idOrDealId);
  if (byId) return byId;
  return store.getDraftByDeal(idOrDealId);
}

/**
 * Resolve a wallet's buyer/seller role for a draft (or deal id), consulting an
 * optional chain resolver first. Throws 404 when the draft is unknown and 403
 * when the wallet is neither party.
 */
export async function requireParty(
  req: FastifyRequest,
  store: PartyStore,
  idOrDealId: string,
  wallet?: string,
  resolver?: PartyResolver,
): Promise<PartyRole> {
  const resolvedWallet = wallet ?? requireAuth(req).wallet;
  const draft = await resolveDraft(store, idOrDealId);
  if (!draft) throw httpError(404, "Draft not found");
  if (resolver) {
    const role = await resolver(draft.dealId, resolvedWallet);
    if (role) return role;
  }
  const want = resolvedWallet.toLowerCase();
  const buyer = (draft.terms["buyer"] ?? "").toLowerCase();
  const seller = (draft.terms["seller"] ?? "").toLowerCase();
  if (buyer !== "" && buyer === want) return "buyer";
  if (seller !== "" && seller === want) return "seller";
  throw httpError(403, "Wallet is not a party to this draft");
}

/** Require the wallet to be the draft creator OR a buyer/seller party. */
export async function requireCreatorOrParty(
  req: FastifyRequest,
  store: PartyStore,
  idOrDealId: string,
  wallet?: string,
  resolver?: PartyResolver,
): Promise<ResolvedRole> {
  const resolvedWallet = wallet ?? requireAuth(req).wallet;
  const draft = await resolveDraft(store, idOrDealId);
  if (!draft) throw httpError(404, "Draft not found");
  if (draft.creatorWallet && draft.creatorWallet.toLowerCase() === resolvedWallet.toLowerCase()) return "creator";
  if (resolver) {
    const role = await resolver(draft.dealId, resolvedWallet);
    if (role) return role;
  }
  const want = resolvedWallet.toLowerCase();
  const buyer = (draft.terms["buyer"] ?? "").toLowerCase();
  const seller = (draft.terms["seller"] ?? "").toLowerCase();
  if (buyer !== "" && buyer === want) return "buyer";
  if (seller !== "" && seller === want) return "seller";
  throw httpError(403, "Wallet is not the creator or a party to this draft");
}

/** Require the wallet to be the draft creator. */
export async function requireCreator(
  req: FastifyRequest,
  store: PartyStore,
  idOrDealId: string,
  wallet?: string,
): Promise<true> {
  const resolvedWallet = wallet ?? requireAuth(req).wallet;
  const draft = await resolveDraft(store, idOrDealId);
  if (!draft) throw httpError(404, "Draft not found");
  if (!draft.creatorWallet || draft.creatorWallet.toLowerCase() !== resolvedWallet.toLowerCase()) {
    throw httpError(403, "Wallet is not the draft creator");
  }
  return true;
}

export const OPERATOR_ROLES = [
  "pauser",
  "admission",
  "arbitration",
  "veto",
  "relay",
  "governance",
  "feeRecipient",
] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** OPERATOR_<ROLE>_WALLETS env key for a role (camelCase -> SNAKE_CASE). */
export function operatorEnvKey(role: OperatorRole): string {
  const snake = role.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `OPERATOR_${snake}_WALLETS`;
}

/** True when wallet is allow-listed for the role (case-insensitive CSV). */
export function isOperator(role: OperatorRole, wallet: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[operatorEnvKey(role)] ?? "";
  if (!raw.trim()) return false;
  const allow = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return allow.has(wallet.toLowerCase());
}

/** Roles the wallet currently holds. */
export function operatorRolesFor(wallet: string, env: NodeJS.ProcessEnv = process.env): OperatorRole[] {
  return OPERATOR_ROLES.filter((role) => isOperator(role, wallet, env));
}

/**
 * Operator auth = session AND a valid signed request, for the SAME wallet,
 * which must be allow-listed for at least one of `roles`.
 */
export async function requireAnyOperator(
  req: FastifyRequest,
  roles: readonly OperatorRole[],
): Promise<{ session: Session; wallet: Address; role: OperatorRole }> {
  const session = requireAuth(req);
  let signed: Address;
  try {
    signed = await verifySignedRequest(req);
  } catch {
    throw httpError(401, "Operator requests require a valid signed request");
  }
  if (signed.toLowerCase() !== session.wallet.toLowerCase()) {
    throw httpError(401, "Signed request wallet does not match the session");
  }
  const role = roles.find((candidate) => isOperator(candidate, signed));
  if (!role) throw httpError(403, "Wallet is not authorized for this operator role");
  return { session, wallet: signed, role };
}

/** Single-role convenience wrapper. */
export function requireOperator(req: FastifyRequest, role: OperatorRole): Promise<{
  session: Session;
  wallet: Address;
  role: OperatorRole;
}> {
  return requireAnyOperator(req, [role]);
}

/** Non-throwing operator probe (used for response redaction). */
export async function isOperatorRequest(
  req: FastifyRequest,
  roles: readonly OperatorRole[],
): Promise<boolean> {
  try {
    await requireAnyOperator(req, roles);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Durable invitation-token enforcement
//
// routes.ts generates the raw token in POST /drafts/:id/invite and never
// persists a retrievable copy (only the audit hash). registerAuthGuards
// observes the invite response via onSend and records sha256(token) + expiry +
// intended counterparty through the AuthPersistence adapter. Accept then
// redeems the presented raw token with a compare-and-set call: it must hash to
// the stored value and be unexpired/unrevoked/unconsumed, and the accepting
// wallet must match the intended counterparty (when set). After redemption the
// participant authenticates via their own session; the secret is no longer
// needed.
// ---------------------------------------------------------------------------

const invitations = new Map<string, StoredInvitation>();

function invitationKey(id: string): string {
  return id.toLowerCase();
}

export function recordInvitation(
  draftId: string,
  token: string,
  expiresAtIso: string,
  intendedCounterparty: string | null = null,
  nowIso: string = new Date().toISOString(),
): StoredInvitation {
  const record: StoredInvitation = {
    draftId,
    dealId: draftId,
    tokenHash: hashInvitationToken(token),
    intendedCounterparty,
    createdAt: nowIso,
    expiresAt: expiresAtIso,
    revoked: false,
    consumed: false,
    redeemedBy: null,
    redeemTx: null,
  };
  invitations.set(invitationKey(draftId), record);
  void getAuthPersistence().recordInvitation(record);
  return record;
}

export function revokeInvitation(draftId: string): void {
  const entry = invitations.get(invitationKey(draftId));
  if (entry) {
    entry.revoked = true;
    void getAuthPersistence().revokeInvitation(draftId);
  }
}

/** Sync probe against the in-memory mirror (used for diagnostics/tests). */
export function verifyInvitation(
  draftId: string,
  token: string,
  nowIso: string = new Date().toISOString(),
): boolean {
  const entry = invitations.get(invitationKey(draftId));
  if (!entry) return false;
  if (!isInvitationUsable(entry, nowIso)) return false;
  return entry.tokenHash === hashInvitationToken(token);
}

/**
 * Compare-and-set redemption through the adapter. Verifies the raw token hashes
 * to the stored value and that it is unexpired/unrevoked/unconsumed and bound
 * to the redeeming wallet, then consumes it in a single adapter call.
 */
export async function redeemInvitation(
  draftId: string,
  rawToken: string,
  wallet: string,
  opts: { nowIso?: string; redeemTx?: string | null } = {},
): Promise<RedeemInvitationResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const result = await getAuthPersistence().redeemInvitation(draftId, {
    tokenHash: hashInvitationToken(rawToken),
    wallet,
    nowIso,
    redeemTx: opts.redeemTx ?? null,
  });
  if (result.ok) invitations.set(invitationKey(draftId), result.invitation);
  return result;
}

/** Test helper: clear the in-memory invitation registry and reset the adapter. */
export function __resetInvitationsForTests(): void {
  invitations.clear();
  setAuthPersistence(new MemoryAuthPersistence());
}
