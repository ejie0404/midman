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

  private async state(sponsor: string): Promise<SponsorNonceState> {
    const existing = await this.store.kvGet(NS, sponsor.toLowerCase(), KEY);
    if (
      existing !== null &&
      typeof existing === "object" &&
      typeof (existing as { base?: unknown }).base === "number"
    ) {
      return existing as SponsorNonceState;
    }
    const base = await this.sync();
    const seeded: SponsorNonceState = { base, allocated: null };
    await this.store.kvPut(NS, sponsor.toLowerCase(), KEY, seeded);
    return seeded;
  }

  /** Next nonce for the sponsor; persisted so it survives restarts. */
  async allocate(sponsor: string): Promise<number> {
    const lower = sponsor.toLowerCase();
    const current = await this.state(lower);
    // The monotonic sequence is the cross-worker coordination point. Jump
    // ahead of any previously persisted allocation so a reset/partial store
    // can never hand out a nonce that was already used.
    let nonce = current.base + ((await this.store.nextSeq(this.seqName(lower))) - 1);
    while (current.allocated !== null && nonce <= current.allocated) {
      nonce = current.base + ((await this.store.nextSeq(this.seqName(lower))) - 1);
    }
    // Record the high-water mark. We only advance (never regress) so a stale
    // concurrent writer cannot hand out an already-used nonce.
    if (current.allocated === null || nonce > current.allocated) {
      await this.store.kvPut(NS, lower, KEY, { base: current.base, allocated: nonce });
    }
    return nonce;
  }

  /** Highest nonce reserved so far, for diagnostics/reports. */
  async reserved(sponsor: string): Promise<number | null> {
    const state = (await this.store.kvGet(NS, sponsor.toLowerCase(), KEY)) as SponsorNonceState | null;
    return state?.allocated ?? null;
  }
}
