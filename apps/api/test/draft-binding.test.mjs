import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../dist/server.js";
import { resolveDraftBinding } from "../dist/dealsMeta.js";

const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const POLICY_IDS = {
  fee: h(1),
  category: h(2),
  readiness: h(3),
  evidence: h(4),
  bond: h(5),
  arbitration: h(6),
  outage: h(7),
  catastrophic: h(8),
};
const HUB = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PLATFORM = "0x000000000000000000000000000000000000fee1";
const ARBITRATION = "0x000000000000000000000000000000000000a4b1";
const BUYER = "0x1111111111111111111111111111111111111111";
const SELLER = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x00000000000000000000000000000000000bad01";

const ENV = {
  HUB_ADDRESS: HUB,
  USDC_ADDRESS: USDC,
  BASE_CHAIN_ID: "8453",
  MIDMAN_POLICY_IDS: JSON.stringify(POLICY_IDS),
  PLATFORM_FEE_RECIPIENT: PLATFORM,
  ARBITRATION_COST_RECIPIENT: ARBITRATION,
};

/** A creator trying to redirect fees/costs and pick other policies/contracts. */
function hostileTerms() {
  return {
    buyer: BUYER,
    seller: SELLER,
    principalUnits: "100000000",
    buyerFeeBps: 10000,
    deliverySeconds: 3600,
    inspectionSeconds: 86400,
    category: "GAME_ACCOUNT",
    agreementHash: h(0xabc),
    policyIds: { ...POLICY_IDS, category: h(0xbad), fee: h(0xbad) },
    platformFeeRecipient: ATTACKER,
    arbitrationCostRecipient: ATTACKER,
    hub: "0x00000000000000000000000000000000000000bb",
    token: "0x00000000000000000000000000000000000000cc",
    chainId: 1,
  };
}

describe("server-pinned draft binding", () => {
  it("overrides recipients, contracts, chain and policy ids from the deployment", () => {
    const result = resolveDraftBinding(hostileTerms(), ENV);
    assert.equal(result.ok, true);
    assert.equal(result.pinned, true);
    assert.equal(result.input.platformFeeRecipient, PLATFORM);
    assert.equal(result.input.arbitrationCostRecipient, ARBITRATION);
    assert.equal(result.input.hub, HUB);
    assert.equal(result.input.token, USDC);
    assert.equal(result.input.chainId, 8453);
    assert.deepEqual(result.input.policyIds, POLICY_IDS);
    // Non-binding deal fields are the creator's to choose.
    assert.equal(result.input.principalUnits, "100000000");
    assert.equal(result.input.seller, SELLER);
  });

  it("uses the per-category policy id when MIDMAN_CATEGORY_POLICY_IDS maps the category", () => {
    const env = { ...ENV, MIDMAN_CATEGORY_POLICY_IDS: JSON.stringify({ GAME_ACCOUNT: h(0x24) }) };
    const result = resolveDraftBinding(hostileTerms(), env);
    assert.equal(result.input.policyIds.category, h(0x24));
    const other = resolveDraftBinding({ ...hostileTerms(), category: "SERVICE" }, env);
    assert.equal(other.input.policyIds.category, POLICY_IDS.category);
  });

  it("fails closed in production when the deployment binding is not configured", () => {
    const result = resolveDraftBinding(hostileTerms(), { NODE_ENV: "production" });
    assert.equal(result.ok, false);
    assert.match(result.error, /Deal configuration unavailable/);
  });

  it("keeps client values only outside production when unconfigured", () => {
    const result = resolveDraftBinding(hostileTerms(), {});
    assert.equal(result.ok, true);
    assert.equal(result.pinned, false);
    assert.equal(result.input.platformFeeRecipient, ATTACKER);
  });
});

describe("POST /drafts pins the binding", () => {
  const saved = {};
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("stores the deployment recipients and policies, not the client's", async () => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    const app = buildServer({ auth: false });
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/drafts", payload: { terms: hostileTerms() } });
    assert.equal(created.statusCode, 200, created.body);
    const { terms } = created.json();
    assert.equal(terms.platformFeeRecipient, PLATFORM);
    assert.equal(terms.arbitrationCostRecipient, ARBITRATION);
    assert.equal(terms.hub, HUB);
    assert.equal(terms.token, USDC);
    assert.equal(terms.chainId, "8453");
    assert.equal(terms["policy:category"], POLICY_IDS.category);
    assert.equal(terms["policy:fee"], POLICY_IDS.fee);
    await app.close();
  });
});

describe("agreement text", () => {
  it("accepts text only when it hashes to the signed agreementHash", async () => {
    const { agreementFromBody } = await import("../dist/routes.js");
    const { keccak256, stringToHex } = await import("viem");
    const text = "1x Rare skin bundle, delivered by in-game trade.";
    const hash = keccak256(stringToHex(text));
    assert.deepEqual(agreementFromBody({ title: " Rare skin ", agreementText: text }, hash), {
      title: "Rare skin",
      text,
    });
    assert.match(agreementFromBody({ agreementText: "something else" }, hash).error, /does not match/);
    assert.match(agreementFromBody({ title: "" }, hash).error, /title/);
    assert.deepEqual(agreementFromBody({}, hash), { title: null, text: null });
  });
});
