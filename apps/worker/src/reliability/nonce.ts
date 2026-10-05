// Durable sponsor nonce coordination.
//
// Multiple workers share one sponsor key, so a per-process counter is not
// enough: two workers can fetch the same pending count and hand out the same
// nonce. This coordinator persists the sponsor's base nonce and allocates
// every subsequent nonce through `store.nextSeq`, which is atomic in both the
// in-memory and Postgres stores. `sync` (a chain read) is only consulted when
// no reservation exists yet, matching the audit requirement to re-sync from
// chain only when there is nothing reserved.
import type { Store } from "@midman/store";

export interface SponsorNonceState {
  /** Chain pending count observed when the reservation was created. */
  readonly base: number;
  /** Last nonce handed out (or null before the first allocation). */
  readonly allocated: number | null;
}

const NS = "sponsor.nonce";
const KEY = "state";

/**
 * Allocate the next sponsor nonce for `sponsor`, durably and collision-free
 * across workers. The returned nonce is also recorded so a restart resumes
 * above it instead of re-minting an already-used nonce.
 */
export class SponsorNonceCoordinator {
  constructor(
    private readonly store: Store,
    private readonly sync: () => Promise<number>,
  ) {}

  private seqName(sponsor: string): string {
    return `sponsor-nonce:${sponsor.toLowerCase()}`;
  }

  private isState(value: unknown): value is SponsorNonceState {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { base?: unknown }).base === "number"
    );
  }

  /**
   * Establish the sponsor's base ONCE. Two workers that both observe an empty
   * reservation must not each seed their own base (that is the "7 and 6 both
   * allocate 7" race): the first create-if-absent wins and every worker reads
   * the same base afterwards.
   */
  private async state(sponsor: string): Promise<SponsorNonceState> {
    const lower = sponsor.toLowerCase();
    const existing = await this.store.kvGet(NS, lower, KEY);
    if (this.isState(existing)) return existing;
    const seeded: SponsorNonceState = { base: await this.sync(), allocated: null };
    const created = await this.store.kvPutIfAbsent(NS, lower, KEY, seeded);
    if (created) return seeded;
    // Lost the seed race: adopt the winner's base.
    const raced = await this.store.kvGet(NS, lower, KEY);
    return this.isState(raced) ? raced : seeded;
  }

  /** Next nonce for the sponsor; persisted so it survives restarts. */
  async allocate(sponsor: string): Promise<number> {
    const lower = sponsor.toLowerCase();
    const current = await this.state(lower);
    // With a single shared base, the atomic sequence alone makes allocations
    // distinct. The high-water floor guards a store that lost `allocated`.
    const seq = await this.store.nextSeq(this.seqName(lower));
    const floor = current.allocated === null ? current.base - 1 : current.allocated;
    const nonce = Math.max(current.base + (seq - 1), floor + 1);
    await this.store.kvPut(NS, lower, KEY, { base: current.base, allocated: nonce });
    return nonce;
  }

  /** Highest nonce reserved so far, for diagnostics/reports. */
  async reserved(sponsor: string): Promise<number | null> {
    const state = (await this.store.kvGet(NS, sponsor.toLowerCase(), KEY)) as SponsorNonceState | null;
    return state?.allocated ?? null;
  }
}
