// In-memory reviewer case registry (Phase 9 console state, NOT consensus).
// Panel assignment comes from chain panels or a manual roster (drills).
// Recusal never halts a case: a recused signer counts as ABSENT for console
// quorum math so the remaining bar stays visible. The contract still enforces
// quorum on-chain at queue time; this registry is display + intake only.
import type { Address } from "viem";
import { DurableCollection, RegistryWriter, type RegistryAdapter } from "@midman/store";
import { getAuthPersistence, type AssignmentAuditEntry } from "../auth/persistence.js";

const CASE_NS = "review.cases";

export interface RecusalRecord {
  readonly reviewer: Address;
  readonly reason: string;
  readonly at: string;
}

export interface ReviewCase {
  readonly dealId: string;
  readonly primary: Address[];
  readonly fallback: Address[];
  readonly recusals: RecusalRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ReviewHouse = "primary" | "fallback";

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DEAL_RE = /^0x[0-9a-fA-F]{64}$/;

function asAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw httpError(400, `Invalid address for ${field}`);
  }
  return value as Address;
}

function dedupe(addresses: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const entry of addresses) {
    const lower = entry.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(entry);
    }
  }
  return out;
}

function copyCase(stored: ReviewCase): ReviewCase {
  return {
    dealId: stored.dealId,
    primary: [...stored.primary],
    fallback: [...stored.fallback],
    recusals: stored.recusals.map((r) => ({ ...r })),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export class InMemoryReviewRegistry {
  private readonly writer = new RegistryWriter();
  private readonly cases = new DurableCollection<ReviewCase>(CASE_NS, this.writer, (record) =>
    record.dealId.toLowerCase(),
  );

  /** Attach the durability adapter (see configureRegistry). */
  setAdapter(adapter: RegistryAdapter | null): void {
    this.writer.setAdapter(adapter);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  async hydrate(dealIds?: string[]): Promise<void> {
    await this.cases.hydrate(dealIds);
  }

  async assignReviewers(dealId: string, panels: { primary: string[]; fallback: string[] }): Promise<ReviewCase> {
    if (!DEAL_RE.test(dealId)) throw httpError(400, "Invalid dealId");
    if (!Array.isArray(panels.primary) || !Array.isArray(panels.fallback)) {
      throw httpError(400, "primary and fallback must be arrays");
    }
    if (panels.primary.length === 0 || panels.fallback.length === 0) {
      throw httpError(400, "primary and fallback panels must each be non-empty");
    }
    const primary = dedupe(panels.primary.map((entry, i) => asAddress(entry, `primary[${i}]`)));
    const fallback = dedupe(panels.fallback.map((entry, i) => asAddress(entry, `fallback[${i}]`)));
    const primarySet = new Set(primary.map((entry) => entry.toLowerCase()));
    const overlap = fallback.filter((entry) => primarySet.has(entry.toLowerCase()));
    if (overlap.length > 0) {
      // P-05: primary and fallback signer sets must be disjoint.
      throw httpError(400, "primary and fallback panels must be disjoint");
    }
    const now = new Date().toISOString();
    const key = dealId.toLowerCase();
    const existing = this.cases.get(key, key);
    const record: ReviewCase = {
      dealId,
      primary,
      fallback,
      recusals: existing ? [...existing.recusals] : [],
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    // Cache updates synchronously inside `set`; awaiting surfaces durable
    // failures to the route instead of acknowledging an uncommitted write.
    await this.cases.set(key, key, record);
    return copyCase(record);
  }

  async recordRecusal(dealId: string, reviewer: string, reason: string): Promise<ReviewCase> {
    if (!DEAL_RE.test(dealId)) throw httpError(400, "Invalid dealId");
    const wallet = asAddress(reviewer, "reviewer");
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw httpError(400, "Recusal reason is required");
    }
    const key = dealId.toLowerCase();
    const existing = this.cases.get(key, key);
    if (!existing) throw httpError(404, "Unknown review case");
    const member = [...existing.primary, ...existing.fallback].some(
      (entry) => entry.toLowerCase() === wallet.toLowerCase(),
    );
    if (!member) throw httpError(404, "Reviewer is not assigned to this case");
    if (existing.recusals.some((r) => r.reviewer.toLowerCase() === wallet.toLowerCase())) {
      return copyCase(existing); // idempotent: already recused
    }
    const updated: ReviewCase = {
      ...existing,
      primary: [...existing.primary],
      fallback: [...existing.fallback],
      recusals: [...existing.recusals, { reviewer: wallet, reason: reason.trim(), at: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    };
    await this.cases.set(key, key, updated);
    return copyCase(updated);
  }

  getCase(dealId: string): ReviewCase | null {
    const key = dealId.toLowerCase();
    const stored = this.cases.get(key, key);
    return stored ? copyCase(stored) : null;
  }

  listOpen(): ReviewCase[] {
    const out: ReviewCase[] = [];
    for (const dealId of this.cases.dealIds()) {
      for (const stored of this.cases.list(dealId)) out.push(copyCase(stored));
    }
    return out;
  }

  isRecused(dealId: string, wallet: string): boolean {
    const stored = this.getCase(dealId);
    if (!stored) return false;
    return stored.recusals.some((r) => r.reviewer.toLowerCase() === wallet.toLowerCase());
  }

  /** Eligible (non-recused) members of one house. Recusal raises the visible bar. */
  eligible(dealId: string, house: ReviewHouse): Address[] {
    const stored = this.getCase(dealId);
    if (!stored) return [];
    const recused = new Set(stored.recusals.map((r) => r.reviewer.toLowerCase()));
    return (house === "primary" ? stored.primary : stored.fallback).filter(
      (entry) => !recused.has(entry.toLowerCase()),
    );
  }

  clear(): void {
    for (const dealId of this.cases.dealIds()) void this.cases.clearDeal(dealId);
  }
}

/** Process-wide registry used by routes (tests reset via __resetReviewRegistryForTests). */
export const reviewRegistry = new InMemoryReviewRegistry();

// ---------------------------------------------------------------------------
// Assignment authority (Round-2, requirement 6)
//
// Only an explicit `arbitration` operator may change panels; the route guard
// authenticates that role. These helpers perform the authority-independent
// validation (address shape, disjointness, participant conflicts) and persist
// the append-only audit trail through the AuthPersistence adapter.
// ---------------------------------------------------------------------------

export interface AssignmentValidationContext {
  readonly buyer?: string | null;
  readonly seller?: string | null;
}

/** Validate a proposed panel set; throws 400/403 on invalid or conflicting input. */
export function validateProposedAssignment(
  dealId: string,
  panels: { primary: string[]; fallback: string[] },
  ctx: AssignmentValidationContext = {},
): { primary: Address[]; fallback: Address[] } {
  if (!DEAL_RE.test(dealId)) throw httpError(400, "Invalid dealId");
  if (!Array.isArray(panels.primary) || !Array.isArray(panels.fallback)) {
    throw httpError(400, "primary and fallback must be arrays");
  }
  if (panels.primary.length === 0 || panels.fallback.length === 0) {
    throw httpError(400, "primary and fallback panels must each be non-empty");
  }
  const primary = dedupe(panels.primary.map((entry, i) => asAddress(entry, `primary[${i}]`)));
  const fallback = dedupe(panels.fallback.map((entry, i) => asAddress(entry, `fallback[${i}]`)));
  const primarySet = new Set(primary.map((entry) => entry.toLowerCase()));
  const overlap = fallback.filter((entry) => primarySet.has(entry.toLowerCase()));
  if (overlap.length > 0) throw httpError(400, "primary and fallback panels must be disjoint");
  const buyer = (ctx.buyer ?? "").toLowerCase();
  const seller = (ctx.seller ?? "").toLowerCase();
  for (const entry of [...primary, ...fallback]) {
    const wallet = entry.toLowerCase();
    if ((buyer && wallet === buyer) || (seller && wallet === seller)) {
      throw httpError(403, "Proposed reviewer conflicts with a deal participant");
    }
  }
  return { primary, fallback };
}

/** Append an assignment change to the durable audit trail. */
export async function recordAssignmentAudit(entry: AssignmentAuditEntry): Promise<void> {
  await getAuthPersistence().appendAssignmentAudit(entry);
}

/** Read the assignment audit trail (optionally scoped to one deal). */
export function listAssignmentAudit(dealId?: string): Promise<AssignmentAuditEntry[]> {
  return getAuthPersistence().listAssignmentAudit(dealId);
}


export function assignReviewers(
  dealId: string,
  panels: { primary: string[]; fallback: string[] },
): Promise<ReviewCase> {
  return reviewRegistry.assignReviewers(dealId, panels);
}

export function recordRecusal(dealId: string, reviewer: string, reason: string): Promise<ReviewCase> {
  return reviewRegistry.recordRecusal(dealId, reviewer, reason);
}

export function getCase(dealId: string): ReviewCase | null {
  return reviewRegistry.getCase(dealId);
}

export function listOpen(): ReviewCase[] {
  return reviewRegistry.listOpen();
}

/**
 * Switch the shared review registry to durable mode and rehydrate. The lead
 * wires this in server.ts: `await configureRegistry(adapter)`.
 */
export async function configureRegistry(adapter: RegistryAdapter | null, dealIds?: string[]): Promise<void> {
  reviewRegistry.setAdapter(adapter);
  await reviewRegistry.hydrate(dealIds);
}

/** Sync test hook: attach an adapter without hydrating. */
export function __setRegistryForTests(adapter: RegistryAdapter | null): void {
  reviewRegistry.setAdapter(adapter);
}

/** Await queued durable writes (tests only). */
export function __flushReviewRegistryForTests(): Promise<void> {
  return reviewRegistry.flush();
}

/** Test-only reset (drops all tracked cases and recusals). */
export function __resetReviewRegistryForTests(): void {
  reviewRegistry.clear();
  reviewRegistry.setAdapter(null);
}
