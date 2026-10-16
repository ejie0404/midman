// End-to-end funding integration: real Fastify API -> real JSON bundle ->
// real web parser/signers -> relay-fund enqueue -> execute on anvil ->
// DealFunded confirmed.
//
// This is the test the API/web funding contract must pass: no hand-built
// fixtures anywhere in the funding path. The bundle parsed here is the exact
// HTTP response of GET /drafts/:id/funding-bundle, the signatures are real
// EIP-712 wallet signatures, and the executed calldata is byte-identical to
// what the web builds locally.
//
// Usage: node scripts/e2e-funding.mjs            (starts anvil itself)
//        node scripts/e2e-funding.mjs --no-spawn (use an existing anvil on 8545)
//
// Requires built workspace dist (pnpm build): apps/api, @midman/api-client,
// @midman/chain, @midman/store. Web lib/*.ts files are erasable TypeScript
// and load directly under Node 24.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ANVIL_RPC,
  CONTRACTS_DIR,
  ANVIL_ACCOUNT0,
  ANVIL_ACCOUNT0_KEY,
  parseDeploymentFromArtifact,
} from "./e2e-anvil.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// Standard anvil test accounts (buyer/seller); account0 is deployer/roles.
// Keys verified against the anvil mnemonic via `cast wallet address`.
const BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SELLER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const ERC20_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
];

function reqFrom(mod) {
  return createRequire(path.join(REPO_ROOT, mod, "package.json"));
}

function loadWorkspaceModule(mod, sub) {
  const req = reqFrom(mod);
  const resolved = req.resolve(sub, { paths: [path.join(REPO_ROOT, mod)] });
  return req(resolved);
}

function viemEsmUrl(...parts) {
  const req = reqFrom("apps/api");
  const pkgJson = req.resolve("viem/package.json", { paths: [path.join(REPO_ROOT, "apps", "api")] });
  return pathToFileURL(path.join(path.dirname(pkgJson), "_esm", ...parts)).href;
}

// ESM build (the CJS build mangles 0x-prefixed keys). Top-level await is
// fine in an .mjs script.
const viem = await import(viemEsmUrl("index.js"));
const { privateKeyToAccount } = await import(viemEsmUrl("accounts", "privateKeyToAccount.js"));
const { anvil } = await import(viemEsmUrl("chains", "index.js"));
const apiClient = loadWorkspaceModule("apps/api", "@midman/api-client");

const buyer = privateKeyToAccount(BUYER_KEY);
const seller = privateKeyToAccount(SELLER_KEY);
const operator = privateKeyToAccount(ANVIL_ACCOUNT0_KEY);

const bytes32 = (seed) => `0x${Buffer.from(seed).toString("hex").padStart(64, "0").slice(0, 64)}`;
const policyId = (name) => viem.keccak256(viem.stringToHex(name));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitForRpc(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ANVIL_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json && typeof json.result === "string") return true;
      }
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  return false;
}

function checkStatus(res, label, expected = 200) {
  if (res.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${res.status}: ${res.text.slice(0, 300)}`);
  }
  return res.json;
}

async function main() {
  const noSpawn = process.argv.includes("--no-spawn");
  let anvilProc = null;
  const savedEnv = {};
  for (const key of ["PORT", "DATABASE_URL", "REDIS_URL", "HUB_ADDRESS", "USDC_ADDRESS", "BASE_CHAIN_ID", "BASE_RPC_URLS", "MIDMAN_AUTH_ENFORCE", "NODE_ENV"]) {
    savedEnv[key] = process.env[key];
  }
  try {
    if (!noSpawn) {
      anvilProc = spawn("anvil", ["--port", "8545", "--silent"], { stdio: "ignore", detached: false });
    }
    if (!(await waitForRpc(15_000))) throw new Error("anvil did not become ready");

    // 1. Deploy the dev stack (forge must be on PATH: CI foundry-toolchain).
    const run = spawnSync(
      "forge",
      ["script", "script/DeployDev.s.sol", "--rpc-url", ANVIL_RPC, "--broadcast", "--sender", ANVIL_ACCOUNT0, "--private-key", ANVIL_ACCOUNT0_KEY],
      { cwd: CONTRACTS_DIR, encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`forge script failed: ${run.stderr || run.stdout}`);
    const artifactPath = path.join(CONTRACTS_DIR, "broadcast", "DeployDev.s.sol", "31337", "run-latest.json");
    if (!existsSync(artifactPath)) throw new Error(`missing broadcast artifact ${artifactPath}`);
    const deployment = parseDeploymentFromArtifact(JSON.parse(readFileSync(artifactPath, "utf8")));
    const { hub, usdc } = deployment;
    console.log(`deployed hub=${hub} usdc=${usdc}`);

    // 2. Boot the real API in-process (memory store, dev auth off).
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.MIDMAN_AUTH_ENFORCE;
    delete process.env.NODE_ENV;
    process.env.PORT = "0";
    process.env.HUB_ADDRESS = hub;
    process.env.USDC_ADDRESS = usdc;
    process.env.BASE_CHAIN_ID = "31337";
    process.env.BASE_RPC_URLS = ANVIL_RPC;
    // Pinned deployment binding (server ignores client recipients/policies)
    // and the automated admission service, signing as the dev admission
    // signer (DeployDev sets admissionSigner = deployer = anvil account 0).
    process.env.MIDMAN_POLICY_IDS = JSON.stringify({
      fee: policyId("MIDMAN.FEE.v1"),
      category: policyId("MIDMAN.CATEGORY.GAME_ITEM.v1"),
      readiness: policyId("MIDMAN.READINESS.NONE.v1"),
      evidence: policyId("MIDMAN.EVIDENCE.v1"),
      bond: policyId("MIDMAN.BOND.5USDC.v1"),
      arbitration: policyId("MIDMAN.ARBITRATION.ALL.v1"),
      outage: policyId("MIDMAN.OUTAGE.v1"),
      catastrophic: policyId("MIDMAN.CATASTROPHIC.v1"),
    });
    process.env.PLATFORM_FEE_RECIPIENT = ANVIL_ACCOUNT0;
    process.env.ARBITRATION_COST_RECIPIENT = ANVIL_ACCOUNT0;
    process.env.ADMISSION_SIGNER_KEY = ANVIL_ACCOUNT0_KEY;
    process.env.ADMISSION_MAX_PRINCIPAL_UNITS = "1000000000";
    const { buildServerAsync } = await import(pathToFileURL(path.join(REPO_ROOT, "apps/api/dist/server.js")).href);
    // Real web code (erasable TS, loaded directly).
    const webFunding = await import(pathToFileURL(path.join(REPO_ROOT, "apps/web/lib/funding.ts")).href);
    const { confirmEvent } = await import(pathToFileURL(path.join(REPO_ROOT, "apps/web/lib/wallet.ts")).href);
    const { app, store } = await buildServerAsync();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const apiPort = app.server.address().port;
    const api = `http://127.0.0.1:${apiPort}`;
    const call = async (method, url, body) => {
      const init = { method };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`${api}${url}`, init);
      const text = await res.text().catch(() => "");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON body; text preserved for diagnostics.
      }
      return { status: res.status, json, text };
    };

    const publicClient = viem.createPublicClient({ chain: anvil, transport: viem.http(ANVIL_RPC) });
    const walletFor = (account) =>
      viem.createWalletClient({ account, chain: anvil, transport: viem.http(ANVIL_RPC) });
    const buyerClient = walletFor(buyer);
    const sellerClient = walletFor(seller);
    const operatorClient = walletFor(operator);
    const send = async (client, to, data, value = 0n) => {
      const hash = await client.sendTransaction({ to, data, value, chain: anvil });
      return publicClient.waitForTransactionReceipt({ hash });
    };

    // 3. Draft -> invite -> accept (real API routes).
    const agreementHash = `0x${randomBytes(32).toString("hex")}`;
    const categoryPolicyId = policyId("MIDMAN.CATEGORY.GAME_ITEM.v1");
    const draftBody = {
      creatorWallet: buyer.address,
      counterpartyHint: seller.address,
      terms: {
        buyer: buyer.address,
        seller: seller.address,
        principalUnits: "100000000",
        buyerFeeBps: 10000,
        deliverySeconds: 86400,
        inspectionSeconds: 86400,
        category: "GAME_ITEM",
        agreementHash,
        policyIds: {
          fee: policyId("MIDMAN.FEE.v1"),
          category: categoryPolicyId,
          readiness: policyId("MIDMAN.READINESS.NONE.v1"),
          evidence: policyId("MIDMAN.EVIDENCE.v1"),
          bond: policyId("MIDMAN.BOND.5USDC.v1"),
          arbitration: policyId("MIDMAN.ARBITRATION.ALL.v1"),
          outage: policyId("MIDMAN.OUTAGE.v1"),
          catastrophic: policyId("MIDMAN.CATASTROPHIC.v1"),
        },
        platformFeeRecipient: ANVIL_ACCOUNT0,
        arbitrationCostRecipient: ANVIL_ACCOUNT0,
        hub,
        token: usdc,
        chainId: 31337,
      },
    };
    const created = checkStatus(await call("POST", "/drafts", draftBody), "create draft");
    const draftId = created.id;
    checkStatus(await call("POST", `/drafts/${draftId}/invite`), "invite");
    checkStatus(await call("POST", `/drafts/${draftId}/accept`, { counterpartyAddress: seller.address }), "accept");

    // 4. GET the REAL funding bundle -> parse with the REAL web parser.
    const bundleRaw = checkStatus(await call("GET", `/drafts/${draftId}/funding-bundle`), "funding-bundle");
    const bundle = webFunding.parseFundingBundle(bundleRaw, draftId);
    if (bundle.token.toLowerCase() !== usdc.toLowerCase()) throw new Error("bundle token is not the deployed MockUSDC");
    if (bundle.principalUnits !== "100000000") throw new Error(`unexpected principal ${bundle.principalUnits}`);
    if (bundle.fundedUnits !== "100700000") throw new Error(`unexpected tier math: funded=${bundle.fundedUnits}`);
    if (bundle.readiness.required !== false) throw new Error("long deal must not require readiness");
    if (bundle.admission.granted !== null) throw new Error("admission must be null before grant");
    if (bundle.signatures.buyer !== null || bundle.signatures.seller !== null) throw new Error("sigs must start null");

    // 5. Sign DealTerms (buyer + seller wallets) -> record on the draft.
    const buyerSig = await webFunding.signDealTerms(buyer.address, bundle.dealTermsTypedData, { walletClient: buyerClient });
    const sellerSig = await webFunding.signDealTerms(seller.address, bundle.dealTermsTypedData, { walletClient: sellerClient });
    checkStatus(await call("POST", `/drafts/${draftId}/deal-signatures`, { role: "buyer", signature: buyerSig }), "buyer sign");
    checkStatus(await call("POST", `/drafts/${draftId}/deal-signatures`, { role: "seller", signature: sellerSig }), "seller sign");

    // 6. Automated admission: a party requests, the risk rules decide and the
    //    service signs as the admission signer the hub verifies at fund().
    const admissionRes = checkStatus(await call("POST", `/drafts/${draftId}/admission/request`, {}), "admission request");
    const admissionSig = admissionRes.admission.signature;
    if (admissionRes.admission.minPolicyId.toLowerCase() !== bundle.fullTerms.categoryPolicyId.toLowerCase())
      throw new Error("admission is not bound to the signed category policy");

    // 7. Re-fetch: signatures + granted admission must now be IN the bundle.
    const bundle2 = webFunding.parseFundingBundle(
      checkStatus(await call("GET", `/drafts/${draftId}/funding-bundle`), "funding-bundle#2"),
      draftId,
    );
    if (bundle2.signatures.buyer !== buyerSig || bundle2.signatures.seller !== sellerSig)
      throw new Error("recorded signatures missing from bundle");
    if (!bundle2.admission.granted || bundle2.admission.granted.signature !== admissionSig)
      throw new Error("granted admission missing from bundle");

    // 8. Fund the buyer + approve the hub (allowance path needs ERC20 approval).
    const mintHash = await operatorClient.writeContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [buyer.address, 1000000000n],
      chain: anvil,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    const approveHash = await buyerClient.writeContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [hub, BigInt(bundle2.fundedUnits)],
      chain: anvil,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // 9. Buyer signs the allowance intent -> assemble the canonical relay body.
    const allowanceSig = await webFunding.signAllowance(
      buyer.address,
      {
        dealId: bundle2.dealId,
        agreementDigest: bundle2.agreementDigest,
        payer: buyer.address,
        amount: BigInt(bundle2.fundedUnits),
        paymentSalt: bundle2.allowance.paymentSalt,
        nonce: bundle2.allowance.nonce,
        expiresAt: bundle2.allowance.expiresAt,
      },
      { chainId: bundle2.chainId, hub: bundle2.hub },
      { walletClient: buyerClient },
    );
    const sigs = { buyer: buyerSig, seller: sellerSig, allowance: allowanceSig };
    const payload = webFunding.assembleRelayPayload(bundle2, sigs);
    apiClient.validateRelayFundPayload(payload); // canonical contract, verbatim
    const relayed = checkStatus(await call("POST", `/drafts/${draftId}/relay-fund`, payload), "relay-fund");
    if (relayed.inserted !== true) throw new Error("relay job was not inserted");

    // 10. The queued calldata must equal what the web builds locally.
    const job = await store.getRelay(payload.idempotencyKey);
    if (!job || job.action !== "fund" || !job.params || typeof job.params.data !== "string")
      throw new Error("relay job missing fund calldata");
    const localCalldata = webFunding.buildFundCalldata(bundle2, sigs);
    if (localCalldata.toLowerCase() !== job.params.data.toLowerCase())
      throw new Error("web-built calldata differs from API-enqueued calldata");

    // 11. Execute as a permissionless relayer -> DealFunded confirmed.
    const receipt = await send(operatorClient, hub, job.params.data);
    if (receipt.status !== "success") throw new Error("fund() transaction reverted");
    const event = confirmEvent(receipt, hub, "DealFunded", (args) =>
      String(args["dealId"]).toLowerCase() === bundle2.dealId.toLowerCase(),
    );
    const hubBalance = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [hub] });
    if (hubBalance !== BigInt(bundle2.fundedUnits)) throw new Error(`hub balance ${hubBalance} != funded ${bundle2.fundedUnits}`);

    console.log(`FUNDED deal=${bundle2.dealId} tx=${receipt.transactionHash}`);
    console.log(`event DealFunded args.dealId=${event.args["dealId"]}`);
    console.log("E2E FUNDING: PASS (api -> web -> relay -> anvil -> DealFunded)");
    await app.close();
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (anvilProc) {
      anvilProc.kill();
      // Let stdio handles close before exit (Windows libuv teardown race).
      await sleep(500);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error("E2E FUNDING: FAIL", error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
