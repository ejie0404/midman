// Phase 10 outage / token-restriction drills.
//
// Fully injected: no live chain, no RPC. The caller supplies a reader and a
// sequencer feed (real or simulated) whose behaviors encode the failure
// scenario; the drill only asserts the required fail-closed / fail-open
// outcomes and returns per-step results.
import type { DrillResult, DrillStep } from "./restore.js";

export interface OutageOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface OutageReader {
  /** Timeout-gated action while the sequencer is down: must fail closed. */
  timeoutWithSequencerDown(): Promise<OutageOutcome>;
  /** Dispute admission while the sequencer is down: rights stay open. */
  admitDisputeWithSequencerDown(): Promise<OutageOutcome>;
  /** Primary RPC read with the primary down: must fail. */
  readPrimaryDown(): Promise<OutageOutcome>;
  /** Pooled RPC read: must succeed via failover. */
  readWithFailover(): Promise<OutageOutcome>;
  /** Claim attempt under a token-wide restriction: expected to fail. */
  claimUnderRestriction(): Promise<OutageOutcome>;
  /** Outstanding liability immediately before the failed claim. */
  liabilityBeforeFailedClaim(): Promise<bigint>;
  /** Outstanding liability immediately after the failed claim. */
  liabilityAfterFailedClaim(): Promise<bigint>;
}

export interface OutageFeed {
  /** Sequencer feed health at probe time; false = down. */
  isSequencerUp(): Promise<boolean>;
}

export interface OutageDrillInput {
  readonly reader: OutageReader;
  readonly feed: OutageFeed;
}

/**
 * Runs three scenarios:
 *  (a) sequencer down -> timeout paths fail closed; dispute admission open;
 *  (b) RPC primary down -> pool fails over;
 *  (c) token-wide restriction -> failed claim preserves liability.
 */
export async function outageDrill(input: OutageDrillInput): Promise<DrillResult> {
  const { reader, feed } = input;
  const steps: DrillStep[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
  };

  // (a) Sequencer down: timeouts fail closed, dispute admission stays open.
  const sequencerUp = await feed.isSequencerUp();
  const timeout = await reader.timeoutWithSequencerDown();
  add(
    "sequencer-timeout-fails-closed",
    sequencerUp === false && timeout.ok === false,
    `sequencerUp=${sequencerUp} timeout.ok=${timeout.ok}${timeout.reason ? ` reason=${timeout.reason}` : ""}`,
  );
  const dispute = await reader.admitDisputeWithSequencerDown();
  add(
    "sequencer-dispute-admission-open",
    dispute.ok === true,
    `dispute.ok=${dispute.ok} (direct/offline rights remain exercisable)`,
  );

  // (b) RPC primary down: pool failover serves reads.
  const primary = await reader.readPrimaryDown();
  add(
    "rpc-primary-down",
    primary.ok === false,
    `primary.ok=${primary.ok}${primary.reason ? ` reason=${primary.reason}` : ""}`,
  );
  const failover = await reader.readWithFailover();
  add(
    "rpc-pool-failover",
    failover.ok === true,
    `failover.ok=${failover.ok}${failover.reason ? ` reason=${failover.reason}` : ""}`,
  );

  // (c) Token-wide restriction: failed claim preserves liability.
  const before = await reader.liabilityBeforeFailedClaim();
  const claim = await reader.claimUnderRestriction();
  const after = await reader.liabilityAfterFailedClaim();
  add(
    "token-claim-failed",
    claim.ok === false,
    `claim.ok=${claim.ok}${claim.reason ? ` reason=${claim.reason}` : ""}`,
  );
  add(
    "token-liability-preserved",
    before === after && before > 0n,
    `liability ${before.toString()} -> ${after.toString()}`,
  );

  const ok = steps.every((step) => step.ok);
  return {
    ok,
    steps,
    detail: ok ? "outage drills passed" : "outage drills failed",
  };
}

/** Deterministic simulated deps for tests/CI (no live chain). */
export function simulatedOutageDeps(): OutageDrillInput {
  const liability = 1_000_000n;
  return {
    feed: {
      async isSequencerUp(): Promise<boolean> {
        return false;
      },
    },
    reader: {
      async timeoutWithSequencerDown(): Promise<OutageOutcome> {
        return { ok: false, reason: "sequencer-down-fail-closed" };
      },
      async admitDisputeWithSequencerDown(): Promise<OutageOutcome> {
        return { ok: true };
      },
      async readPrimaryDown(): Promise<OutageOutcome> {
        return { ok: false, reason: "primary-rpc-down" };
      },
      async readWithFailover(): Promise<OutageOutcome> {
        return { ok: true };
      },
      async claimUnderRestriction(): Promise<OutageOutcome> {
        return { ok: false, reason: "token-transfer-restricted" };
      },
      async liabilityBeforeFailedClaim(): Promise<bigint> {
        return liability;
      },
      async liabilityAfterFailedClaim(): Promise<bigint> {
        return liability;
      },
    },
  };
}
