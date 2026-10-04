// ChainReader: narrow interface over viem so the indexer, workers, and API
// can run against live RPCs or scripted fakes. Contract state is always
// authoritative for payments and entitlements; DB projections are display.
import {
  createPublicClient,
  fallback,
  http,
  decodeEventLog,
  type Address,
  type Hash,
  type Log,
} from "viem";
import { base } from "viem/chains";
import { HUB_ABI, POLICIES_ABI } from "./abi.js";

export interface ChainLog {
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
  readonly transactionHash: Hash;
  readonly logIndex: number;
  readonly address: Address;
  readonly data: Hash;
  readonly topics: readonly Hash[];
  readonly removed: boolean;
}

export interface ChainBlock {
  readonly number: bigint;
  readonly hash: Hash;
  readonly parentHash: Hash;
  readonly timestamp: number;
}

export interface TransactionReceipt {
  readonly status: boolean;
  readonly blockNumber: bigint;
}

export interface ChainReader {
  getLatestBlockNumber(): Promise<bigint>;
  getBlock(number: bigint): Promise<ChainBlock>;
  getBlockByTag(tag: "safe" | "finalized"): Promise<ChainBlock | null>;
  getLogs(params: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]>;
  getTransactionReceipt(txHash: Hash): Promise<TransactionReceipt | null>;
  getDeal(hub: Address, dealId: Hash): Promise<Record<string, bigint | string | boolean | number>>;
  getClaim(hub: Address, claimId: Hash): Promise<{ recipient: Address; amount: bigint }>;
  getLiabilities(hub: Address): Promise<bigint>;
  getTokenBalance(token: Address, account: Address): Promise<bigint>;
  // Phase 9 (additive): reviewer-panel + bond-policy views on the policies
  // registry. Epoch-scoped per P-07 rotation; queue-time checks are on-chain.
  isPanelMember(
    policies: Address,
    epoch: bigint,
    house: "primary" | "fallback",
    wallet: Address,
  ): Promise<boolean>;
  getBondPolicy(policies: Address, id: Hash): Promise<{ claimantBond: bigint; respondentBond: bigint }>;
}

export function createViemReader(rpcUrls: string[]): ChainReader {
  const transports = rpcUrls.map((url) => http(url));
  const client = createPublicClient({
    chain: base,
    transport: transports.length > 1 ? fallback(transports) : transports[0]!,
  });
  const erc20Balance = [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as const;
  return {
    async getLatestBlockNumber(): Promise<bigint> {
      return client.getBlockNumber();
    },
    async getBlock(number: bigint): Promise<ChainBlock> {
      const block = await client.getBlock({ blockNumber: number });
      return {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: Number(block.timestamp),
      };
    },
    async getBlockByTag(tag: "safe" | "finalized"): Promise<ChainBlock | null> {
      try {
        const block = await client.getBlock({ blockTag: tag });
        return {
          number: block.number,
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: Number(block.timestamp),
        };
      } catch {
        return null;
      }
    },
    async getLogs(params: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]> {
      if (params.toBlock < params.fromBlock) return [];
      const logs: Log[] = await client.getLogs({
        address: params.address,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock,
      });
      return logs
        .filter(
          (log): log is Log & { blockNumber: bigint; blockHash: Hash; transactionHash: Hash; logIndex: number } =>
            log.blockNumber !== null &&
            log.blockHash !== null &&
            log.transactionHash !== null &&
            log.logIndex !== null,
        )
        .map((log) => ({
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          address: log.address,
          data: log.data as Hash,
          topics: log.topics as readonly Hash[],
          removed: log.removed,
        }));
    },
    async getTransactionReceipt(txHash: Hash): Promise<TransactionReceipt | null> {
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        return { status: receipt.status === "success", blockNumber: receipt.blockNumber };
      } catch {
        return null;
      }
    },
    async getDeal(hub: Address, dealId: Hash): Promise<Record<string, bigint | string | boolean | number>> {
      const deal = (await client.readContract({
        address: hub,
        abi: HUB_ABI,
        functionName: "getDeal",
        args: [dealId],
      })) as Record<string, bigint | string | boolean | number>;
      return deal;
    },
    async getClaim(hub: Address, claimId: Hash): Promise<{ recipient: Address; amount: bigint }> {
      const [recipient, amount] = (await client.readContract({
        address: hub,
        abi: HUB_ABI,
        functionName: "getClaim",
        args: [claimId],
      })) as [Address, bigint];
      return { recipient, amount };
    },
    async getLiabilities(hub: Address): Promise<bigint> {
      return (await client.readContract({
        address: hub,
        abi: HUB_ABI,
        functionName: "totalLiabilities",
      })) as bigint;
    },
    async getTokenBalance(token: Address, account: Address): Promise<bigint> {
      return (await client.readContract({
        address: token,
        abi: erc20Balance,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
    },
    async isPanelMember(
      policies: Address,
      epoch: bigint,
      house: "primary" | "fallback",
      wallet: Address,
    ): Promise<boolean> {
      return (await client.readContract({
        address: policies,
        abi: POLICIES_ABI,
        functionName: house === "primary" ? "isPrimary" : "isFallback",
        args: [epoch, wallet],
      })) as boolean;
    },
    async getBondPolicy(policies: Address, id: Hash): Promise<{ claimantBond: bigint; respondentBond: bigint }> {
      // MidmanPolicies.bondPolicies returns the full record:
      // (bool exists, bytes32 contentHash, uint256 claimantBond, uint256 respondentBond).
      const result = (await client.readContract({
        address: policies,
        abi: POLICIES_ABI,
        functionName: "bondPolicies",
        args: [id],
      })) as unknown as
        | { exists: boolean; contentHash: Hash; claimantBond: bigint; respondentBond: bigint }
        | [boolean, Hash, bigint, bigint];
      if (Array.isArray(result)) {
        return { claimantBond: result[2] as bigint, respondentBond: result[3] as bigint };
      }
      return { claimantBond: result.claimantBond, respondentBond: result.respondentBond };
    },
  };
}

/// @notice Decode a hub log into {eventName, args} or null when unknown.
export function decodeHubLog(log: Pick<ChainLog, "data" | "topics">): {
  eventName: string;
  args: Record<string, unknown>;
} | null {
  try {
    const decoded = decodeEventLog({
      abi: HUB_ABI,
      data: log.data,
      topics: log.topics as [Hash, ...Hash[]],
    });
    return { eventName: decoded.eventName, args: decoded.args as Record<string, unknown> };
  } catch {
    return null;
  }
}
