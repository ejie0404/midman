// End-to-end release-gate harness on a local anvil chain.
//
// Proves the *deployment + release-verification* path against a live EVM:
//   1. deploy the dev stack (MockUSDC + MockFeed + policies + hub) on anvil
//   2. build deploy/manifest.31337.json from the deterministic anvil deployment
//   3. run scripts/verify-deployment.mjs against it and assert PASS
//
// This is intentionally separate from the Foundry unit/e2e suites (which cover
// the contract lifecycle) and from verify-manifest (offline config checks): it
// is the live-RPC complement the audit's Phase 7 completion check asks for.
//
// Usage: node scripts/e2e-anvil.mjs            (starts anvil itself)
//        node scripts/e2e-anvil.mjs --no-spawn (use an existing anvil on 8545)
//
// It is skipped (exit 0 with a notice) when the foundry toolchain is absent so
// it never breaks a machine without anvil/forge.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashAll } from "./policy-hash.mjs";
import { EXPECTED_HUB_TIERS, POLICY_ID_PREIMAGES } from "./verify-deployment.mjs";

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const CONTRACTS_DIR = path.join(REPO_ROOT, "packages", "contracts");
export const ANVIL_RPC = "http://127.0.0.1:8545";
export const ANVIL_CHAIN_ID = 31337;
export const ANVIL_ACCOUNT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const ANVIL_ACCOUNT0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Fixed dev panel members (must match script/DeployDev.s.sol — 5/5/3).
export const DEV_PANELS = {
  primary: [
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  ],
  fallback: [
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
    "0xBcd4042DE499D14e55001CcbB24a551F3b954096",
  ],
  veto: [
    "0x71bE63f3384f5fb98995898A86B02Fb2426c5788",
    "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a",
    "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec",
  ],
};

function foundryBin(name) {
  const candidates = [
    process.env[`${name.toUpperCase()}_BIN`],
    path.join(REPO_ROOT, "..", "opencode", "foundry", `${name}.exe`),
    `${name}`,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === name || existsSync(c)) return c;
  }
  return name;
}

function findForge() {
  for (const c of [
    process.env["FORGE_BIN"],
    "C:/Users/subze/AppData/Local/Temp/opencode/foundry/forge.exe",
    "forge",
  ]) {
    if (c && (c === "forge" || existsSync(c))) return c;
  }
  return null;
}

function findAnvil() {
  for (const c of [
    process.env["ANVIL_BIN"],
    "C:/Users/subze/AppData/Local/Temp/opencode/foundry/anvil.exe",
    "anvil",
  ]) {
    if (c && (c === "anvil" || existsSync(c))) return c;
  }
  return null;
}

/** Parse the deterministic addresses from DeployDev's broadcast artifact. */
export function parseDeploymentFromArtifact(artifact) {
  const contracts = {};
  for (const tx of artifact.transactions ?? []) {
    const name = tx.contractName;
    if (name && tx.contractAddress) contracts[name] = tx.contractAddress;
  }
  if (!contracts.MidmanHub || !contracts.MidmanPolicies || !contracts.MockUSDC || !contracts.MockFeed || !contracts.HubDispute) {
    throw new Error("DeployDev artifact missing expected contracts (incl. HubDispute library)");
  }
  return {
    hub: contracts.MidmanHub,
    policies: contracts.MidmanPolicies,
    usdc: contracts.MockUSDC,
    feed: contracts.MockFeed,
    disputeLibrary: contracts.HubDispute,
  };
}

export function policyIdFor(policyType) {
  const preimage = POLICY_ID_PREIMAGES[policyType];
  if (!preimage) throw new Error(`Unknown policy type ${policyType}`);
  return preimage;
}

export function buildAnvilManifest(deployment, contentHashes) {
  return {
    manifestVersion: 1,
    deploymentStatus: "ANVIL_E2E",
    network: { name: "anvil", chainId: ANVIL_CHAIN_ID },
    contracts: {
      usdc: deployment.usdc,
      sequencerFeed: deployment.feed,
      policies: deployment.policies,
      hub: deployment.hub,
      disputeLibrary: deployment.disputeLibrary,
    },
    roles: {
      governanceTimelock: ANVIL_ACCOUNT0,
      pauser: ANVIL_ACCOUNT0,
      admissionSigner: ANVIL_ACCOUNT0,
      treasury: ANVIL_ACCOUNT0,
      sequencerFeed: deployment.feed,
      primaryPanel: DEV_PANELS.primary,
      fallbackPanel: DEV_PANELS.fallback,
      vetoPanel: DEV_PANELS.veto,
    },
    domain: { name: "MidmanEscrow", version: "1", chainId: ANVIL_CHAIN_ID, verifyingContract: deployment.hub },
    policyHashes: contentHashes,
    policyValues: {
      "category-v1": { minInspectionSeconds: "3600" },
      "readiness-v1": { required: false },
      "bond-v1": { claimantBondUnits: "5000000", respondentBondUnits: "5000000" },
      "arbitration-v1": { tiersAllowed: "7" },
      "outage-v1": { gracePeriodSeconds: "1800", maxIntervals: "8" },
    },
    governance: {
      rotationDelaySeconds: "259200",
      unpauseDelaySeconds: "86400",
      vetoQuorum: "2",
      minPanelSizes: { primary: "5", fallback: "5", veto: "3" },
    },
    hubTiers: EXPECTED_HUB_TIERS.map((tier) => ({ ...tier })),
    expectedPrincipals: [],
    bytecodeHashes: {},
  };
}

async function waitForRpc(timeoutMs) {
  const cast = process.env["CAST_BIN"] ?? "C:/Users/subze/AppData/Local/Temp/opencode/foundry/cast.exe";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync(cast, ["block-number", "--rpc-url", ANVIL_RPC], { encoding: "utf8" });
    if (r.status === 0) return true;
    await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

async function main() {
  const noSpawn = process.argv.includes("--no-spawn");
  const forge = findForge();
  const anvil = findAnvil();
  if (!forge || !anvil) {
    console.log("ANVIL E2E: SKIPPED (foundry toolchain not available)");
    process.exit(0);
  }

  let anvilProc = null;
  if (!noSpawn) {
    anvilProc = spawn(anvil, ["--port", "8545", "--silent"], { stdio: "ignore", detached: false });
  }
  try {
    if (!(await waitForRpc(15_000))) throw new Error("anvil did not become ready");
    const run = spawnSync(
      forge,
      [
        "script",
        "script/DeployDev.s.sol",
        "--rpc-url",
        ANVIL_RPC,
        "--broadcast",
        "--sender",
        ANVIL_ACCOUNT0,
        "--private-key",
        ANVIL_ACCOUNT0_KEY,
      ],
      { cwd: CONTRACTS_DIR, encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`forge script failed: ${run.stderr || run.stdout}`);

    const artifactPath = path.join(CONTRACTS_DIR, "broadcast", "DeployDev.s.sol", String(ANVIL_CHAIN_ID), "run-latest.json");
    if (!existsSync(artifactPath)) throw new Error(`missing broadcast artifact ${artifactPath}`);
    const { readFileSync } = await import("node:fs");
    const deployment = parseDeploymentFromArtifact(JSON.parse(readFileSync(artifactPath, "utf8")));
    const contentHashes = await hashAll();
    const manifest = buildAnvilManifest(deployment, contentHashes);
    const manifestPath = path.join(REPO_ROOT, "deploy", "manifest.31337.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const verify = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "verify-deployment.mjs"), manifestPath, `--chain=${ANVIL_CHAIN_ID}`, `--rpc-url=${ANVIL_RPC}`],
      { encoding: "utf8" },
    );
    process.stdout.write(verify.stdout || "");
    if (verify.status !== 0) {
      process.stderr.write(verify.stderr || "");
      throw new Error("verify-deployment reported failure");
    }
    console.log("ANVIL E2E: PASS (deploy + live release verification)");
  } finally {
    if (anvilProc) anvilProc.kill();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error("ANVIL E2E: FAIL", error.message);
    process.exit(1);
  });
}
