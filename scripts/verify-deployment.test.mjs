// Unit tests for the live deployment verifier. All tests stub the viem client
// (no network) and use real viem for hashing/encoding so the EIP-712 recompute
// vector is exercised end to end.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadViem } from './policy-hash.mjs';
import {
  POLICY_GETTERS,
  POLICY_ID_PREIMAGES,
  ZERO_HASH,
  computeDomainSeparator,
  formatTable,
  onchainPolicyId,
  verifyDeployment,
} from './verify-deployment.mjs';

const H = (n) => `0x${n.repeat(20)}`;

function baseManifest() {
  const types = Object.keys(POLICY_ID_PREIMAGES);
  const policyHashes = {};
  types.forEach((type, index) => {
    policyHashes[type] = `0x${(index + 1).toString(16).padStart(2, '0').repeat(32)}`;
  });
  return {
    manifestVersion: 1,
    network: { name: 'base', chainId: 8453 },
    deploymentStatus: 'VERIFIED',
    contracts: {
      usdc: H('33'),
      sequencerFeed: H('44'),
      policies: H('22'),
      hub: H('11'),
      disputeLibrary: H('99'),
    },
    roles: {
      governanceTimelock: H('55'),
      pauser: H('66'),
      admissionSigner: H('77'),
      treasury: H('88'),
      platformFeeRecipient: H('91'),
      arbitrationCostRecipient: H('92'),
      primaryPanel: [H('a1'), H('a2'), H('a3'), H('a4'), H('a5')],
      fallbackPanel: [H('b1'), H('b2'), H('b3'), H('b4'), H('b5')],
      vetoPanel: [H('c1'), H('c2'), H('c3')],
    },
    policyHashes,
    domain: { name: 'MidmanEscrow', version: '1', chainId: 8453, verifyingContract: H('11') },
    bytecodeHashes: { MidmanHub: '0x...', MidmanPolicies: '0x...' },
    dependencies: {},
    releaseCommit: null,
    expectedFundedDeals: 0,
  };
}

function buildHandlers(manifest) {
  const hub = manifest.contracts.hub.toLowerCase();
  const policies = manifest.contracts.policies.toLowerCase();
  const usdc = manifest.contracts.usdc.toLowerCase();
  const handlers = {
    [`${hub}:usdc`]: () => manifest.contracts.usdc,
    [`${hub}:policies`]: () => manifest.contracts.policies,
    [`${hub}:totalLiabilities`]: () => 0n,
    [`${hub}:eip712Domain`]: () => [
      '0x0f',
      manifest.domain.name,
      manifest.domain.version,
      BigInt(manifest.network.chainId),
      manifest.contracts.hub,
      ZERO_HASH,
      [],
    ],
    [`${policies}:governance`]: () => manifest.roles.governanceTimelock,
    [`${policies}:pauser`]: () => manifest.roles.pauser,
    [`${policies}:admissionSigner`]: () => manifest.roles.admissionSigner,
    [`${policies}:treasury`]: () => manifest.roles.treasury,
    [`${policies}:sequencerFeed`]: () => manifest.contracts.sequencerFeed,
    [`${policies}:authEpoch`]: () => 1n,
    [`${policies}:isPrimary`]: () => true,
    [`${policies}:isFallback`]: () => true,
    [`${policies}:isVeto`]: () => true,
    [`${usdc}:balanceOf`]: () => 0n,
    [`${usdc}:decimals`]: () => 6,
  };
  for (const [type, getter] of Object.entries(POLICY_GETTERS)) {
    handlers[`${policies}:${getter.fn}`] = () => [true, manifest.policyHashes[type]];
  }
  return handlers;
}

const FAKE_CODE = `0x60806040${'00'.repeat(20)}`;

function makeClient(manifest, { reads = {}, codes = {} } = {}) {
  const handlers = { ...buildHandlers(manifest), ...reads };
  const calls = [];
  return {
    calls,
    async getCode({ address }) {
      const key = address.toLowerCase();
      if (key in codes) return codes[key];
      return FAKE_CODE;
    },
    async readContract({ address, functionName, args }) {
      const key = `${address.toLowerCase()}:${functionName}`;
      calls.push({ address: address.toLowerCase(), functionName, args: args || [] });
      const handler = handlers[key];
      if (!handler) throw new Error(`no stub for ${key}`);
      return typeof handler === 'function' ? handler() : handler;
    },
  };
}

function findCheck(result, id) {
  const check = result.checks.find((entry) => entry.id === id);
  assert.ok(check, `expected check ${id}`);
  return check;
}

async function run(manifest, overrides) {
  const client = makeClient(manifest, overrides);
  const result = await verifyDeployment(manifest, { client, manifestPath: 'inline' });
  return { result, client };
}

describe('passing deployment', () => {
  it('verifies a manifest whose contracts match on-chain state', async () => {
    const { result } = await run(baseManifest());
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => c.status === 'fail')));
    assert.equal(result.failures, 0);
    assert.equal(findCheck(result, 'code.hub').status, 'pass');
    assert.equal(findCheck(result, 'domain.name').status, 'pass');
    assert.equal(findCheck(result, 'role.governance').status, 'pass');
    assert.equal(findCheck(result, 'policy.fee-v1').status, 'pass');
    assert.equal(findCheck(result, 'panel.primary[0]').status, 'pass');
    assert.equal(findCheck(result, 'solvency').status, 'pass');
  });

  it('renders a PASS table', async () => {
    const { result } = await run(baseManifest());
    assert.match(formatTable(result), /DEPLOYMENT: PASS/);
  });
});

describe('failure detection', () => {
  it('fails when the policies address has no code', async () => {
    const manifest = baseManifest();
    const { result } = await run(manifest, { codes: { [manifest.contracts.policies.toLowerCase()]: '0x' } });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'code.policies').status, 'fail');
  });

  it('fails on a wrong governance role', async () => {
    const manifest = baseManifest();
    const policies = manifest.contracts.policies.toLowerCase();
    const { result } = await run(manifest, { reads: { [`${policies}:governance`]: () => H('de') } });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'role.governance').status, 'fail');
  });

  it('fails when a policy is unregistered', async () => {
    const manifest = baseManifest();
    const policies = manifest.contracts.policies.toLowerCase();
    const getter = `${policies}:${POLICY_GETTERS['evidence-v1'].fn}`;
    const { result } = await run(manifest, { reads: { [getter]: () => [false, ZERO_HASH] } });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'policy.evidence-v1').status, 'fail');
  });

  it('fails on a panel membership mismatch', async () => {
    const manifest = baseManifest();
    const policies = manifest.contracts.policies.toLowerCase();
    const { result } = await run(manifest, { reads: { [`${policies}:isPrimary`]: () => false } });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'panel.primary[0]').status, 'fail');
  });

  it('fails on insolvency', async () => {
    const manifest = baseManifest();
    const hub = manifest.contracts.hub.toLowerCase();
    const { result } = await run(manifest, { reads: { [`${hub}:totalLiabilities`]: () => 1000n } });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'solvency').status, 'fail');
  });

  it('fails on a hub.usdc mismatch', async () => {
    const manifest = baseManifest();
    const hub = manifest.contracts.hub.toLowerCase();
    const { result } = await run(manifest, { reads: { [`${hub}:usdc`]: () => H('ee') } });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'hub.usdc').status, 'fail');
  });

  it('fails on a domain version mismatch', async () => {
    const manifest = baseManifest();
    const hub = manifest.contracts.hub.toLowerCase();
    const { result } = await run(manifest, {
      reads: {
        [`${hub}:eip712Domain`]: () => ['0x0f', manifest.domain.name, '2', 8453n, manifest.contracts.hub, ZERO_HASH, []],
      },
    });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'domain.version').status, 'fail');
  });
});

describe('policy id + domain encoding', () => {
  it('reads policies using the canonical on-chain id', async () => {
    const manifest = baseManifest();
    const { client } = await run(manifest);
    const viem = loadViem();
    const expected = viem.keccak256(viem.stringToHex(POLICY_ID_PREIMAGES['fee-v1']));
    const call = client.calls.find((entry) => entry.functionName === 'feePolicies');
    assert.ok(call, 'feePolicies called');
    assert.equal(String(call.args[0]).toLowerCase(), expected.toLowerCase());
    assert.equal(onchainPolicyId(viem, 'fee-v1'), expected);
  });

  it('recomputes the canonical EIP-712 domain separator vector', () => {
    const viem = loadViem();
    const separator = computeDomainSeparator(viem, {
      name: 'Ether Mail',
      version: '1',
      chainId: 1n,
      verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
    });
    assert.equal(separator, '0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f');
  });

  it('matches the hub domain separator when the manifest pins it', async () => {
    const viem = loadViem();
    const manifest = baseManifest();
    manifest.domain.separator = computeDomainSeparator(viem, {
      name: manifest.domain.name,
      version: manifest.domain.version,
      chainId: manifest.network.chainId,
      verifyingContract: manifest.contracts.hub,
    });
    const { result } = await run(manifest);
    assert.equal(findCheck(result, 'domain.separator').status, 'pass');
  });

  it('fails when the pinned code hash does not match on-chain code', async () => {
    const viem = loadViem();
    const manifest = baseManifest();
    manifest.bytecodeHashes.MidmanPolicies = viem.keccak256(`0x${'99'.repeat(32)}`);
    const { result } = await run(manifest);
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'codeHash.MidmanPolicies').status, 'fail');
  });
});
