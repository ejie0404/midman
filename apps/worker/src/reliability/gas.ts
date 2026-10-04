// Gas estimation with a safety buffer for Base. Handles EIP-1559 pricing
// (baseFeePerGas from the latest block) with a legacy getGasPrice fallback,
// and degrades to a documented fixed gas limit when estimation fails.
//
// Money is bigint throughout; no floating point is allowed to touch wei.
import type { Address, Hex } from "viem";

/** Minimal client surface so tests can stub estimation and pricing. */
export interface GasClient {
  estimateGas(args: { to: Address; data: Hex }): Promise<bigint>;
  getBlock(args: { blockTag: "latest" }): Promise<{ baseFeePerGas: bigint | null }>;
  getGasPrice(): Promise<bigint>;
}

export interface GasEstimate {
  readonly gasLimit: bigint;
  readonly fallback: boolean;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
}

export const DEFAULT_GAS_BUFFER_BPS = 2_500; // +25%
export const DEFAULT_GAS_FALLBACK = 400_000n;

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function feesFor(client: GasClient): Promise<{
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}> {
  let baseFee: bigint | null = null;
  try {
    const block = await client.getBlock({ blockTag: "latest" });
    baseFee = block.baseFeePerGas;
  } catch {
    baseFee = null;
  }
  if (baseFee !== null) {
    let priority = 0n;
    try {
      const gasPrice = await client.getGasPrice();
      priority = gasPrice > baseFee ? gasPrice - baseFee : 0n;
    } catch {
      priority = 0n;
    }
    return { maxPriorityFeePerGas: priority, maxFeePerGas: baseFee * 2n + priority };
  }
  try {
    const gasPrice = await client.getGasPrice();
    return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
  } catch {
    return {};
  }
}

/**
 * Estimate `gasLimit` for `tx` and apply a basis-point buffer.
 *
 * On estimation failure the result is `{ gasLimit: GAS_FALLBACK, fallback: true }`
 * so callers can submit defensively (and surface the flag) instead of dropping
 * a time-sensitive call. Fee fields are best-effort and may be absent.
 */
export async function estimateGasWithBuffer(
  client: GasClient,
  tx: { to: Address; data: Hex },
  bufferBps: number = DEFAULT_GAS_BUFFER_BPS,
): Promise<GasEstimate> {
  const fallbackLimit = envBigInt("GAS_FALLBACK", DEFAULT_GAS_FALLBACK);
  const bps = BigInt(Number.isFinite(bufferBps) && bufferBps > 0 ? Math.floor(bufferBps) : 0);

  let gasLimit: bigint;
  let fallback = false;
  try {
    const estimate = await client.estimateGas({ to: tx.to, data: tx.data });
    gasLimit = (estimate * (10_000n + bps)) / 10_000n;
  } catch {
    gasLimit = fallbackLimit;
    fallback = true;
  }

  const fees = await feesFor(client);
  const result: {
    gasLimit: bigint;
    fallback: boolean;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  } = { gasLimit, fallback };
  if (fees.maxFeePerGas !== undefined) result.maxFeePerGas = fees.maxFeePerGas;
  if (fees.maxPriorityFeePerGas !== undefined) result.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  return result;
}
