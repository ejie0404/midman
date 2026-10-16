// Outage-watermark keeper (P-09 liveness). The hub refuses every time-derived
// action (timeouts, non-delivery refunds, delivery, escalation, rulings) while
// MidmanPolicies.lastAuditedRound lags the sequencer-feed head, so after every
// Base sequencer status change someone must consume the new rounds:
//   - next round DOWN (with a recovery after it) -> reportOutage(round)
//   - next round UP (e.g. the first round of a new proxy phase) -> advanceWatermark()
// Both calls are permissionless and can only extend clocks, never shorten them.
//
// The keeper signs with its own KEEPER_KEY (never the relay sponsor key, so it
// cannot race the sponsor's nonce coordinator). Without a key it only alerts;
// operators can then run `cast send <policies> "reportOutage(uint80)" <round>`
// or `cast send <policies> "advanceWatermark()"` by hand.
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HUB_ABI, POLICIES_ABI } from "@midman/chain";
import type { Alert } from "../monitoring/thresholds.js";

const FEED_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** One read of the watermark versus the live feed head. */
export interface WatermarkState {
  readonly policies: Address;
  readonly lastAuditedRound: bigint;
  readonly headRound: bigint;
  readonly headUp: boolean;
  readonly covered: boolean;
  /** Next un-audited round, or null when the watermark is at the head. */
  readonly nextRound: bigint | null;
  /** Status of nextRound: true = up, false = down, null when there is none. */
  readonly nextUp: boolean | null;
}

export type KeeperStep = { readonly kind: "report"; readonly round: bigint } | { readonly kind: "advance" };

export interface OutageChain {
  readWatermark(): Promise<WatermarkState>;
}

/** Submits one keeper step and resolves once it is included (throws on revert). */
export interface KeeperSubmitter {
  submit(policies: Address, step: KeeperStep): Promise<Hash>;
}

/** Cross-pass memory: when the watermark first fell behind. */
export interface KeeperMemory {
  behindSince: number | null;
}

export interface KeeperOptions {
  readonly chain: OutageChain;
  readonly submitter: KeeperSubmitter | null;
  readonly memory: KeeperMemory;
  readonly nowSeconds: number;
  /** Alert once the watermark has lagged this long. */
  readonly maxLagSeconds: number;
  /** Upper bound on steps per pass (each waits for inclusion). */
  readonly maxSteps?: number;
}

export interface KeeperResult {
  readonly status: "covered" | "advanced" | "behind" | "unknown";
  readonly submitted: readonly Hash[];
  readonly alerts: readonly Alert[];
  readonly state: WatermarkState | null;
}

export const DEFAULT_MAX_LAG_SECONDS = 600;
const DEFAULT_MAX_STEPS = 8;

/** The step that consumes the next round, or null when none is consumable yet. */
export function nextStep(state: WatermarkState): KeeperStep | null {
  if (state.covered || state.nextRound === null || state.nextUp === null) return null;
  if (state.nextUp) return { kind: "advance" };
  // A down round is reportable only once its recovery exists, i.e. it is not
  // the live head (an ongoing outage at the head is already covered).
  if (state.nextRound === state.headRound) return null;
  return { kind: "report", round: state.nextRound };
}

function alert(
  id: string,
  severity: Alert["severity"],
  summary: string,
  details: Record<string, string>,
  atUnix: number,
): Alert {
  return { id, severity, summary, details, atUnix };
}

/** One keeper pass: read, consume up to maxSteps rounds, alert on sustained lag. */
export async function runOutageKeeper(options: KeeperOptions): Promise<KeeperResult> {
  const { chain, submitter, memory, nowSeconds, maxLagSeconds } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const submitted: Hash[] = [];
  let failure: string | null = null;

  let state: WatermarkState;
  try {
    state = await chain.readWatermark();
  } catch (error) {
    return {
      status: "unknown",
      submitted,
      state: null,
      alerts: [
        alert(
          "outage_watermark_unknown",
          "warning",
          "Outage watermark could not be read; hub deadlines may be UNKNOWN",
          { error: error instanceof Error ? error.message : String(error) },
          nowSeconds,
        ),
      ],
    };
  }

  for (let i = 0; i < maxSteps && submitter !== null; i++) {
    const step = nextStep(state);
    if (step === null) break;
    try {
      submitted.push(await submitter.submit(state.policies, step));
      state = await chain.readWatermark();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  if (state.covered) {
    memory.behindSince = null;
    return { status: submitted.length > 0 ? "advanced" : "covered", submitted, alerts: [], state };
  }

  memory.behindSince ??= nowSeconds;
  const lag = nowSeconds - memory.behindSince;
  const alerts: Alert[] = [];
  if (lag >= maxLagSeconds || failure !== null) {
    alerts.push(
      alert(
        "outage_watermark_behind",
        "critical",
        "Outage watermark lags the sequencer feed: hub timeouts, deliveries and rulings revert until it is caught up",
        {
          policies: state.policies,
          lastAuditedRound: state.lastAuditedRound.toString(),
          headRound: state.headRound.toString(),
          nextRound: state.nextRound === null ? "none" : state.nextRound.toString(),
          lagSeconds: String(lag),
          keeper: submitter === null ? "no KEEPER_KEY configured" : "enabled",
          ...(failure !== null ? { lastError: failure } : {}),
        },
        nowSeconds,
      ),
    );
  }
  return { status: "behind", submitted, alerts, state };
}

/** Live viem-backed chain view over the hub's policies registry and its feed. */
export function createOutageChain(rpcUrls: string[], hub: Address, policiesOverride: Address | null): OutageChain {
  const client = createPublicClient({ chain: base, transport: fallback(rpcUrls.map((url) => http(url))) });
  return {
    async readWatermark() {
      const policies =
        policiesOverride ?? ((await client.readContract({ address: hub, abi: HUB_ABI, functionName: "policies" })) as Address);
      const read = (functionName: string, args: readonly unknown[] = []) =>
        client.readContract({ address: policies, abi: POLICIES_ABI, functionName, args } as never) as Promise<unknown>;
      const feed = (await read("sequencerFeed")) as Address;
      const lastAuditedRound = BigInt((await read("lastAuditedRound")) as bigint);
      const [headRound, headAnswer] = (await client.readContract({
        address: feed,
        abi: FEED_ABI,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const headUp = headAnswer === 0n;
      const covered = (await read("watermarkCovers", [headRound, headUp])) as boolean;
      const [hasNext, next] = (await read("successorRound", [lastAuditedRound])) as readonly [boolean, bigint];
      let nextUp: boolean | null = null;
      if (hasNext) {
        const round = (await client.readContract({
          address: feed,
          abi: FEED_ABI,
          functionName: "getRoundData",
          args: [next],
        })) as readonly [bigint, bigint, bigint, bigint, bigint];
        nextUp = round[1] === 0n;
      }
      return {
        policies,
        lastAuditedRound,
        headRound,
        headUp,
        covered,
        nextRound: hasNext ? next : null,
        nextUp,
      };
    },
  };
}

/** Keeper signer from KEEPER_KEY; null (alert-only) when unset. */
export function createKeeperSubmitter(rpcUrls: string[], key: string | null): KeeperSubmitter | null {
  if (key === null || !/^0x[0-9a-fA-F]{64}$/.test(key.trim())) return null;
  const account = privateKeyToAccount(key.trim() as Hex);
  const transport = fallback(rpcUrls.map((url) => http(url)));
  const wallet = createWalletClient({ account, chain: base, transport });
  const client = createPublicClient({ chain: base, transport });
  return {
    async submit(policies, step) {
      const hash =
        step.kind === "report"
          ? await wallet.writeContract({
              address: policies,
              abi: POLICIES_ABI,
              functionName: "reportOutage",
              args: [step.round],
            } as never)
          : await wallet.writeContract({
              address: policies,
              abi: POLICIES_ABI,
              functionName: "advanceWatermark",
              args: [],
            } as never);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`keeper tx ${hash} reverted`);
      return hash;
    },
  };
}

/** Env wiring: POLICIES_ADDRESS overrides hub.policies(); KEEPER_KEY enables writes. */
export function keeperFromEnv(
  rpcUrls: string[],
  hub: Address,
  env: NodeJS.ProcessEnv = process.env,
): { chain: OutageChain; submitter: KeeperSubmitter | null; maxLagSeconds: number } {
  const rawPolicies = (env["POLICIES_ADDRESS"] ?? "").trim();
  const policies = /^0x[0-9a-fA-F]{40}$/.test(rawPolicies) ? (rawPolicies as Address) : null;
  const lag = Number(env["OUTAGE_WATERMARK_MAX_LAG_SECONDS"] ?? DEFAULT_MAX_LAG_SECONDS);
  return {
    chain: createOutageChain(rpcUrls, hub, policies),
    submitter: createKeeperSubmitter(rpcUrls, env["KEEPER_KEY"] ?? null),
    maxLagSeconds: Number.isFinite(lag) && lag >= 0 ? lag : DEFAULT_MAX_LAG_SECONDS,
  };
}
