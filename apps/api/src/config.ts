// Structured config. No secrets in code; all from environment (see /.env.example).
export interface AppConfig {
  readonly port: number;
  readonly chainId: number | null;
  readonly rpcUrls: string[];
  readonly usdcAddress: string;
  readonly databaseUrl: string | null;
  readonly redisUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rpcUrls = (env["BASE_RPC_URLS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    port: Number(env["PORT"] ?? 3001),
    chainId: env["BASE_CHAIN_ID"] ? Number(env["BASE_CHAIN_ID"]) : null,
    rpcUrls,
    usdcAddress: env["USDC_ADDRESS"] ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    databaseUrl: env["DATABASE_URL"] ?? null,
    redisUrl: env["REDIS_URL"] ?? null,
  };
}
