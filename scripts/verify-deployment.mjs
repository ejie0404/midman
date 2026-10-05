// Live deployment verifier (Phase 12 release gate). This is the on-chain
// complement to scripts/verify-manifest.mjs, which is fully offline. Given a
// release manifest it checks the *deployed* contracts against the manifest:
//
//   (a) code exists at the hub and policies addresses (and, when the manifest
//       pins deployedBytecode hashes, that keccak256(eth_getCode) matches);
//   (b) hub.usdc() and the EIP-712 domain (name/version/chainId/
//       verifyingContract read from eip712Domain()) — the recomputed domain
//       separator is compared to manifest.domain.separator when pinned;
//   (c) policies.sequencerFeed(), governance(), pauser(), admissionSigner()
//       and treasury() match the manifest roles;
//   (d) each of the 8 policy types is registered under its canonical on-chain
//       ID with the manifest's content hash;
//   (e) isPrimary/isFallback for every primary/fallback panel member at the
//       declared epoch (default 1), and isVeto for every veto member;
//   (f) solvency: hub.totalLiabilities() <= USDC.balanceOf(hub), plus no
//       funded deals when the manifest declares none expected.
//
// Any mismatch is a FAIL; the process exits 1 if there is at least one. Run
// this against a public RPC as the final release gate after broadcasting
// DeployProd.s.sol.
//
// Usage:
//   BASE_RPC_URL=https://... node scripts/verify-deployment.mjs \
//     [deploy/manifest.8453.json] [--rpc-url=...] [--chain=8453] [--json]
//
// Exports (all unit-tested in scripts/verify-deployment.test.mjs):
//   computeDomainSeparator(viem, domain)        -> 0x-prefixed bytes32
//   onchainPolicyId(viem, policyType)           -> 0x-prefixed bytes32
//   verifyDeployment(manifest, options)         -> { ok, failures, checks, ... }
//   formatTable(result)                         -> string
//   parseArgs(args)                             -> options

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { loadViem, REPO_ROOT } from './policy-hash.mjs';

export const BASE_CHAIN_ID = 8453;
export const DEFAULT_CHAIN_ID = BASE_CHAIN_ID;
export const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, 'deploy', `manifest.${DEFAULT_CHAIN_ID}.json`);
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const ZERO_HASH = `0x${'00'.repeat(32)}`;

// Manifest policyHashes keys -> canonical on-chain policy ID preimages. These
// must stay in lockstep with DeployPolicyIds in script/DeployProd.s.sol.
export const POLICY_ID_PREIMAGES = {
  'fee-v1': 'MIDMAN.FEE.v1',
  'category-v1': 'MIDMAN.CATEGORY.v1',
  'readiness-v1': 'MIDMAN.READINESS.NONE.v1',
  'evidence-v1': 'MIDMAN.EVIDENCE.v1',
  'bond-v1': 'MIDMAN.BOND.5USDC.v1',
  'arbitration-v1': 'MIDMAN.ARBITRATION.ALL.v1',
  'outage-v1': 'MIDMAN.OUTAGE.v1',
  'catastrophic-v1': 'MIDMAN.CATASTROPHIC.v1',
};

// Getter metadata. `valueIndexes` maps the manifest `policyValues.<type>` keys
// to the position of that field in the getter's return tuple (the fields after
// `exists` + `contentHash`). Fee/evidence/catastrophic carry no on-chain values
// beyond existence + hash, so they have none.
export const POLICY_GETTERS = {
  'fee-v1': { fn: 'feePolicies', existsIndex: 0, hashIndex: 1, valueIndexes: {} },
  'category-v1': {
    fn: 'categoryPolicies',
    existsIndex: 0,
    hashIndex: 1,
    valueIndexes: { minInspectionSeconds: 2 },
  },
  'readiness-v1': { fn: 'readinessPolicies', existsIndex: 0, hashIndex: 1, valueIndexes: { required: 2 } },
  'evidence-v1': { fn: 'evidencePolicies', existsIndex: 0, hashIndex: 1, valueIndexes: {} },
  'bond-v1': {
    fn: 'bondPolicies',
    existsIndex: 0,
    hashIndex: 1,
    valueIndexes: { claimantBondUnits: 2, respondentBondUnits: 3 },
  },
  'arbitration-v1': { fn: 'arbitrationPolicies', existsIndex: 0, hashIndex: 1, valueIndexes: { tiersAllowed: 2 } },
  'outage-v1': {
    fn: 'outagePolicies',
    existsIndex: 0,
    hashIndex: 1,
    valueIndexes: { gracePeriodSeconds: 2, maxIntervals: 3 },
  },
  'catastrophic-v1': { fn: 'catastrophicPolicies', existsIndex: 0, hashIndex: 1, valueIndexes: {} },
};

// Value kinds for comparison against the manifest `policyValues` block.
export const POLICY_VALUE_KINDS = {
  'category-v1': { minInspectionSeconds: 'uint' },
  'readiness-v1': { required: 'bool' },
  'bond-v1': { claimantBondUnits: 'uint', respondentBondUnits: 'uint' },
  'arbitration-v1': { tiersAllowed: 'uint' },
  'outage-v1': { gracePeriodSeconds: 'uint', maxIntervals: 'uint' },
};

// Canonical hub per-tier quorum/delay expectations (MidmanHub.fund + DealTypes).
// These are not exposed by a getter, so the manifest `hubTiers` block is
// cross-checked against this frozen table: a contract change to the tier table
// must be mirrored here and in the manifest or verification fails.
export const EXPECTED_HUB_TIERS = [
  { name: 'T1', maxPrincipalUnits: '1000000000', primaryQuorum: '2', fallbackQuorum: '2', executionDelaySeconds: '86400' },
  { name: 'T2', maxPrincipalUnits: '10000000000', primaryQuorum: '3', fallbackQuorum: '3', executionDelaySeconds: '172800' },
  { name: 'T3', unbounded: true, primaryQuorum: '3', fallbackQuorum: '3', executionDelaySeconds: '259200' },
];

// Canonical governance delays + panel floors (MidmanPolicies constants).
export const EXPECTED_GOVERNANCE = {
  rotationDelaySeconds: '259200',
  unpauseDelaySeconds: '86400',
  vetoQuorum: '2',
  minPanelSizes: { primary: '5', fallback: '5', veto: '3' },
};


const f = (name, inputs = [], outputs = []) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs,
  outputs,
});
const t = (type) => ({ type });

export const HUB_ABI = [
  f('usdc', [], [t('address')]),
  f('policies', [], [t('address')]),
  f('totalLiabilities', [], [t('uint256')]),
  f('ledgerTotals', [], [t('uint256'), t('uint256'), t('uint256')]),
  f('eip712Domain', [], [
    t('bytes1'),
    t('string'),
    t('string'),
    t('uint256'),
    t('address'),
    t('bytes32'),
    t('uint256[]'),
  ]),
];

export const POLICIES_ABI = [
  f('governance', [], [t('address')]),
  f('pauser', [], [t('address')]),
  f('admissionSigner', [], [t('address')]),
  f('treasury', [], [t('address')]),
  f('sequencerFeed', [], [t('address')]),
  f('authEpoch', [], [t('uint64')]),
  f('ROTATION_DELAY', [], [t('uint256')]),
  f('UNPAUSE_DELAY', [], [t('uint256')]),
  f('isPrimary', [t('uint64'), t('address')], [t('bool')]),
  f('isFallback', [t('uint64'), t('address')], [t('bool')]),
  f('isVeto', [t('address')], [t('bool')]),
  f('feePolicies', [t('bytes32')], [t('bool'), t('bytes32')]),
  f('categoryPolicies', [t('bytes32')], [t('bool'), t('bytes32'), t('uint32')]),
  f('readinessPolicies', [t('bytes32')], [t('bool'), t('bytes32'), t('bool')]),
  f('evidencePolicies', [t('bytes32')], [t('bool'), t('bytes32')]),
  f('bondPolicies', [t('bytes32')], [t('bool'), t('bytes32'), t('uint256'), t('uint256')]),
  f('arbitrationPolicies', [t('bytes32')], [t('bool'), t('bytes32'), t('uint8')]),
  f('outagePolicies', [t('bytes32')], [t('bool'), t('bytes32'), t('uint32'), t('uint8')]),
  f('catastrophicPolicies', [t('bytes32')], [t('bool'), t('bytes32')]),
];

export const ERC20_ABI = [
  f('decimals', [], [t('uint8')]),
  f('balanceOf', [t('address')], [t('uint256')]),
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isPlaceholder(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (/[<>]/.test(trimmed)) return true;
  if (trimmed.includes('...')) return true;
  if (/^0x\.+$/i.test(trimmed)) return true;
  return false;
}

function eqAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function eqHex(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isCode(code) {
  return typeof code === 'string' && code.length > 2;
}

function pick(result, index) {
  if (Array.isArray(result)) return result[index];
  if (result && typeof result === 'object') return Object.values(result)[index];
  return result;
}

// Compare a manifest-encoded policy value to its on-chain read.
// `kind` is 'uint' (compared as BigInt so "3600" == 3600n) or 'bool'.
export function policyValueMatches(kind, expected, actual) {
  if (expected === undefined || expected === null) return false;
  if (kind === 'bool') {
    const normalized = expected === true || expected === 'true' || expected === 1 || expected === '1';
    return Boolean(actual) === normalized;
  }
  try {
    return BigInt(expected) === BigInt(actual);
  } catch {
    return false;
  }
}

// Compare a bigint-ish on-chain read to a decimal string/BigInt expectation.
function numericEquals(expected, actual) {
  try {
    return BigInt(expected) === BigInt(actual);
  } catch {
    return false;
  }
}

// Structural equality for the frozen tier table (order-sensitive).
export function tiersMatch(manifestTiers, expectedTiers = EXPECTED_HUB_TIERS) {
  if (!Array.isArray(manifestTiers) || manifestTiers.length !== expectedTiers.length) return false;
  for (let i = 0; i < expectedTiers.length; i += 1) {
    const a = manifestTiers[i] || {};
    const b = expectedTiers[i];
    if (a.name !== b.name) return false;
    if (Boolean(a.unbounded) !== Boolean(b.unbounded)) return false;
    if (!b.unbounded && !numericEquals(a.maxPrincipalUnits, b.maxPrincipalUnits)) return false;
    if (!numericEquals(a.primaryQuorum, b.primaryQuorum)) return false;
    if (!numericEquals(a.fallbackQuorum, b.fallbackQuorum)) return false;
    if (!numericEquals(a.executionDelaySeconds, b.executionDelaySeconds)) return false;
  }
  return true;
}

// Map a principal (decimal string) to a hub tier index using the frozen table.
// Returns 0/1/2, or -1 when the principal is below the tier-1 minimum (unfundable).
export function tierForPrincipal(principal, expectedTiers = EXPECTED_HUB_TIERS) {
  let p;
  try {
    p = BigInt(principal);
  } catch {
    return -1;
  }
  for (let i = 0; i < expectedTiers.length; i += 1) {
    const tier = expectedTiers[i];
    if (tier.unbounded) return p > 0n ? i : -1;
    if (p > 0n && p <= BigInt(tier.maxPrincipalUnits)) return i;
  }
  return -1;
}

function tierAllowed(tiersAllowed, tierIndex) {
  if (tierIndex < 0 || tierIndex > 7) return false;
  try {
    return (BigInt(tiersAllowed) & (1n << BigInt(tierIndex))) !== 0n;
  } catch {
    return false;
  }
}

function errMessage(error) {
  return error && error.message ? error.message : String(error);
}

export function onchainPolicyId(viem, policyType) {
  const preimage = POLICY_ID_PREIMAGES[policyType];
  if (!preimage) throw new Error(`unknown policy type ${policyType}`);
  return viem.keccak256(viem.stringToHex(preimage));
}

/// @notice Recompute the EIP-712 domain separator for the given domain fields.
/// Handles the optional salt member; extensions change the type string and are
/// not used by MidmanHub.
export function computeDomainSeparator(viem, domain = {}) {
  const name = domain.name;
  const version = domain.version;
  const chainId = BigInt(domain.chainId);
  const verifyingContract = domain.verifyingContract;
  const salt = domain.salt;
  const hasSalt = typeof salt === 'string' && salt.toLowerCase() !== ZERO_HASH;

  const typeString = hasSalt
    ? 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)'
    : 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
  const types = [t('bytes32'), t('bytes32'), t('bytes32'), t('uint256'), t('address')];
  const values = [
    viem.keccak256(viem.stringToHex(typeString)),
    viem.keccak256(viem.stringToHex(String(name))),
    viem.keccak256(viem.stringToHex(String(version))),
    chainId,
    verifyingContract,
  ];
  if (hasSalt) {
    types.push(t('bytes32'));
    values.push(salt);
  }
  return viem.keccak256(viem.encodeAbiParameters(types, values));
}

async function read(client, address, abi, functionName, args = []) {
  return client.readContract({ address, abi, functionName, args });
}

/// @notice viem renamed getCode -> getBytecode across versions; support both so
/// the live path works regardless of the pinned viem minor.
async function getCodeCompat(client, address) {
  if (typeof client.getCode === "function") return client.getCode({ address });
  if (typeof client.getBytecode === "function") return client.getBytecode({ address });
  throw new Error("rpc client exposes neither getCode nor getBytecode");
}

/// @notice Verify a deployed manifest against live chain state. `options.client`
/// must expose getCode({address}) and readContract({address, abi, functionName,
/// args}); viem's PublicClient satisfies both, and tests inject a stub.
export async function verifyDeployment(manifest, options = {}) {
  const viem = options.viem || loadViem();
  const client = options.client;
  if (!client) throw new Error('verifyDeployment: options.client is required');

  const checks = [];
  // `advisory` unresolved checks (optional manifest pins) do not block release;
  // REQUIRED unresolved checks (code presence/hashes/link) DO.
  const add = (id, status, detail = '', advisory = false) => checks.push({ id, status, detail, advisory });
  const ok = (id, detail) => add(id, 'pass', detail);
  const bad = (id, detail) => add(id, 'fail', detail);
  const skip = (id, detail, advisory = true) => add(id, 'unresolved', detail, advisory);

  const contracts = (manifest && manifest.contracts) || {};
  const roles = (manifest && manifest.roles) || {};
  const domain = (manifest && manifest.domain) || {};
  const policyHashes = (manifest && manifest.policyHashes) || {};
  const policyValues = (manifest && manifest.policyValues) || {};
  const governance = (manifest && manifest.governance) || {};
  const chainId = options.chainId ?? (manifest && manifest.network && manifest.network.chainId);
  const hub = contracts.hub;
  const policies = contracts.policies;
  const disputeLibrary = contracts.disputeLibrary;

  if (!ADDRESS_RE.test(typeof hub === 'string' ? hub : '')) {
    bad('contracts.hub', `invalid or placeholder hub address: ${hub}`);
  }
  if (!ADDRESS_RE.test(typeof policies === 'string' ? policies : '')) {
    bad('contracts.policies', `invalid or placeholder policies address: ${policies}`);
  }

  // (a) code presence + optional deployedBytecode hash pinning.
  let hubCode;
  let policiesCode;
  let disputeCode;
  if (ADDRESS_RE.test(typeof hub === 'string' ? hub : '')) {
    try {
      hubCode = await getCodeCompat(client, hub);
    } catch (error) {
      bad('code.hub', errMessage(error));
    }
    if (hubCode !== undefined) add('code.hub', isCode(hubCode) ? 'pass' : 'fail', isCode(hubCode) ? 'code present' : 'no code');
  }
  if (ADDRESS_RE.test(typeof policies === 'string' ? policies : '')) {
    try {
      policiesCode = await getCodeCompat(client, policies);
    } catch (error) {
      bad('code.policies', errMessage(error));
    }
    if (policiesCode !== undefined) {
      add('code.policies', isCode(policiesCode) ? 'pass' : 'fail', isCode(policiesCode) ? 'code present' : 'no code');
    }
  }
  // HubDispute is a *linked* library: the hub runtime bytecode embeds its
  // address. Pin the deployed library address (and optionally its codehash) so
  // the delegatecall target is a known, reviewed artifact.
  if (ADDRESS_RE.test(typeof disputeLibrary === 'string' ? disputeLibrary : '')) {
    try {
      disputeCode = await getCodeCompat(client, disputeLibrary);
    } catch (error) {
      bad('code.disputeLibrary', errMessage(error));
    }
    if (disputeCode !== undefined) {
      add(
        'code.disputeLibrary',
        isCode(disputeCode) ? 'pass' : 'fail',
        isCode(disputeCode) ? 'code present' : 'no code at disputeLibrary',
      );
    }
  } else {
    skip('code.disputeLibrary', `disputeLibrary is not a pinned address: ${disputeLibrary}`, false);
  }

  const bytecodeHashes = (manifest && manifest.bytecodeHashes) || {};
  const hubIsLinked = ADDRESS_RE.test(typeof disputeLibrary === 'string' ? disputeLibrary : '');
  for (const [name, address, code] of [
    ['MidmanHub', hub, hubCode],
    ['MidmanPolicies', policies, policiesCode],
    ['HubDispute', disputeLibrary, disputeCode],
  ]) {
    const pinned = bytecodeHashes[name];
    if (isPlaceholder(pinned)) {
      // A release manifest MUST pin every deployed bytecode hash.
      skip(`codeHash.${name}`, 'manifest bytecode hash is a placeholder', false);
      continue;
    }
    if (!HASH_RE.test(typeof pinned === 'string' ? pinned : '')) {
      bad(`codeHash.${name}`, `invalid pinned hash ${pinned}`);
      continue;
    }
    if (!isCode(code)) {
      bad(`codeHash.${name}`, 'cannot hash code: no code at address');
      continue;
    }
    const actual = viem.keccak256(code);
    if (eqHex(actual, pinned)) {
      add(`codeHash.${name}`, 'pass', actual);
    } else {
      // A linked-hub bytecode mismatch is a FAILURE, not an unresolved
      // advisory: the manifest must pin the deployed (linked) runtime hash.
      bad(`codeHash.${name}`, `expected ${pinned} got ${actual}`);
    }
  }

  // HubDispute linking consistency: the hub runtime code must embed the pinned
  // library address (case-insensitive byte substring).
  if (isCode(hubCode) && hubIsLinked) {
    const needle = disputeLibrary.slice(2).toLowerCase();
    add(
      'link.hub',
      hubCode.toLowerCase().includes(needle) ? 'pass' : 'fail',
      `hub code ${hubCode.toLowerCase().includes(needle) ? 'contains' : 'does not embed'} disputeLibrary ${disputeLibrary}`,
    );
  } else if (!isCode(hubCode)) {
    skip('link.hub', 'hub code unavailable', false);
  } else {
    skip('link.hub', 'disputeLibrary is not a pinned address', false);
  }

  // (b) hub immutables + EIP-712 domain.
  if (isCode(hubCode)) {
    try {
      const usdcOnchain = await read(client, hub, HUB_ABI, 'usdc');
      add('hub.usdc', eqAddress(usdcOnchain, contracts.usdc) ? 'pass' : 'fail', `onchain=${usdcOnchain} manifest=${contracts.usdc}`);
    } catch (error) {
      bad('hub.usdc', errMessage(error));
    }
    try {
      const policiesOnchain = await read(client, hub, HUB_ABI, 'policies');
      add(
        'hub.policies',
        eqAddress(policiesOnchain, policies) ? 'pass' : 'fail',
        `onchain=${policiesOnchain} manifest=${policies}`,
      );
    } catch (error) {
      bad('hub.policies', errMessage(error));
    }

    try {
      const d = await read(client, hub, HUB_ABI, 'eip712Domain');
      const name = pick(d, 1);
      const version = pick(d, 2);
      const onchainChainId = pick(d, 3);
      const verifying = pick(d, 4);
      const salt = pick(d, 5);
      add('domain.name', name === domain.name ? 'pass' : 'fail', `onchain=${name} manifest=${domain.name}`);
      add(
        'domain.version',
        String(version) === String(domain.version) ? 'pass' : 'fail',
        `onchain=${version} manifest=${domain.version}`,
      );
      add(
        'domain.chainId',
        BigInt(onchainChainId) === BigInt(chainId) ? 'pass' : 'fail',
        `onchain=${onchainChainId} manifest=${chainId}`,
      );
      add('domain.verifyingContract', eqAddress(verifying, hub) ? 'pass' : 'fail', `onchain=${verifying}`);
      const recomputed = computeDomainSeparator(viem, {
        name,
        version: String(version),
        chainId: onchainChainId,
        verifyingContract: verifying,
        salt,
      });
      if (isPlaceholder(domain.separator)) {
        skip('domain.separator', `recomputed=${recomputed} (manifest not pinned)`);
      } else {
        add(
          'domain.separator',
          eqHex(recomputed, domain.separator) ? 'pass' : 'fail',
          `recomputed=${recomputed} manifest=${domain.separator}`,
        );
      }
    } catch (error) {
      bad('domain.read', errMessage(error));
    }
  }

  // (c) policy role ownership.
  if (isCode(policiesCode)) {
    const roleReads = [
      ['governance', roles.governanceTimelock],
      ['pauser', roles.pauser],
      ['admissionSigner', roles.admissionSigner],
      ['treasury', roles.treasury],
      ['sequencerFeed', contracts.sequencerFeed],
    ];
    for (const [fn, expected] of roleReads) {
      try {
        const actual = await read(client, policies, POLICIES_ABI, fn);
        add(`role.${fn}`, eqAddress(actual, expected) ? 'pass' : 'fail', `onchain=${actual} manifest=${expected}`);
      } catch (error) {
        bad(`role.${fn}`, errMessage(error));
      }
    }

    // (d) policy records: registered under the canonical id with pinned hash.
    for (const policyType of Object.keys(POLICY_GETTERS)) {
      const getter = POLICY_GETTERS[policyType];
      let onchainId;
      try {
        onchainId = onchainPolicyId(viem, policyType);
      } catch (error) {
        bad(`policy.${policyType}`, errMessage(error));
        continue;
      }
      try {
        const res = await read(client, policies, POLICIES_ABI, getter.fn, [onchainId]);
        const exists = Boolean(pick(res, getter.existsIndex));
        const hash = pick(res, getter.hashIndex);
        const expected = policyHashes[policyType];
        const hashOk = !isPlaceholder(expected) && eqHex(hash, expected);
        add(
          `policy.${policyType}`,
          exists && hashOk ? 'pass' : 'fail',
          `exists=${exists} onchain=${hash} manifest=${expected}`,
        );

        // Values: identifiers are not enough. Compare each registered on-chain
        // value (category minInspection, readiness required, bond amounts,
        // arbitration tier bitmask, outage grace/intervals) to the manifest
        // `policyValues` block and fail on any mismatch.
        const kinds = POLICY_VALUE_KINDS[policyType] || {};
        const expectedValues = policyValues[policyType];
        if (Object.keys(kinds).length === 0) {
          // fee/evidence/catastrophic carry no on-chain values beyond
          // existence + content hash.
        } else if (!expectedValues || typeof expectedValues !== 'object') {
          skip(`policyValues.${policyType}`, 'manifest has no policyValues entry for this policy');
        } else {
          for (const [key, kind] of Object.entries(kinds)) {
            const valueIndex = getter.valueIndexes[key];
            const onchainValue = pick(res, valueIndex);
            const expectedValue = expectedValues[key];
            const match = exists && policyValueMatches(kind, expectedValue, onchainValue);
            add(
              `policyValue.${policyType}.${key}`,
              match ? 'pass' : 'fail',
              `onchain=${onchainValue} manifest=${expectedValue}`,
            );
          }
        }
      } catch (error) {
        bad(`policy.${policyType}`, errMessage(error));
      }
    }

    // (c2) Approved category matrix + readiness-required variant. A release
    // MUST instantiate every approved category minimum, not just one.
    const CATEGORY_MATRIX = [
      ['INSTANT_CODE', 3_600n],
      ['GAME_ITEM', 43_200n],
      ['GAME_CURRENCY', 43_200n],
      ['DIGITAL_GOOD', 43_200n],
      ['SERVICE', 43_200n],
      ['GAME_ACCOUNT', 86_400n],
    ];
    for (const [name, expectedMin] of CATEGORY_MATRIX) {
      const id = viem.keccak256(viem.stringToHex(`MIDMAN.CATEGORY.${name}.v1`));
      try {
        const res = await read(client, policies, POLICIES_ABI, 'categoryPolicies', [id]);
        const exists = res && res[0] === true;
        const onchainMin = BigInt((res && res[2]) ?? 0);
        add(
          `category.matrix.${name}`,
          exists && onchainMin === expectedMin ? 'pass' : 'fail',
          `onchain=${onchainMin} expected=${expectedMin}`,
        );
      } catch (error) {
        bad(`category.matrix.${name}`, errMessage(error));
      }
    }
    try {
      const readinessId = viem.keccak256(viem.stringToHex('MIDMAN.READINESS.REQUIRED.v1'));
      const res = await read(client, policies, POLICIES_ABI, 'readinessPolicies', [readinessId]);
      const exists = res && res[0] === true;
      const required = res && res[2] === true;
      add('readiness.required', exists && required ? 'pass' : 'fail', `exists=${exists} required=${required}`);
    } catch (error) {
      bad('readiness.required', errMessage(error));
    }

    // (e) reviewer panels at the declared epoch.
    let epoch = 1n;
    if (!isPlaceholder(roles.authEpoch) && roles.authEpoch !== undefined) {
      try {
        epoch = BigInt(roles.authEpoch);
      } catch {
        epoch = 1n;
      }
    }
    try {
      const liveEpoch = await read(client, policies, POLICIES_ABI, 'authEpoch');
      add('authEpoch', BigInt(liveEpoch) >= BigInt(epoch) ? 'pass' : 'fail', `onchain=${liveEpoch} expected>=${epoch}`);
    } catch (error) {
      bad('authEpoch', errMessage(error));
    }

    const primary = Array.isArray(roles.primaryPanel) ? roles.primaryPanel : [];
    const fallback = Array.isArray(roles.fallbackPanel) ? roles.fallbackPanel : [];
    const veto = Array.isArray(roles.vetoPanel) ? roles.vetoPanel : [];
    for (let i = 0; i < primary.length; i += 1) {
      try {
        const member = await read(client, policies, POLICIES_ABI, 'isPrimary', [epoch, primary[i]]);
        add(`panel.primary[${i}]`, member ? 'pass' : 'fail', primary[i]);
      } catch (error) {
        bad(`panel.primary[${i}]`, errMessage(error));
      }
    }
    for (let i = 0; i < fallback.length; i += 1) {
      try {
        const member = await read(client, policies, POLICIES_ABI, 'isFallback', [epoch, fallback[i]]);
        add(`panel.fallback[${i}]`, member ? 'pass' : 'fail', fallback[i]);
      } catch (error) {
        bad(`panel.fallback[${i}]`, errMessage(error));
      }
    }
    for (let i = 0; i < veto.length; i += 1) {
      try {
        const member = await read(client, policies, POLICIES_ABI, 'isVeto', [veto[i]]);
        add(`panel.veto[${i}]`, member ? 'pass' : 'fail', veto[i]);
      } catch (error) {
        bad(`panel.veto[${i}]`, errMessage(error));
      }
    }

    // (g) governance delay mechanism (ROTATION_DELAY / UNPAUSE_DELAY constants).
    for (const [id, fn, expected] of [
      ['rotationDelay', 'ROTATION_DELAY', governance.rotationDelaySeconds],
      ['unpauseDelay', 'UNPAUSE_DELAY', governance.unpauseDelaySeconds],
    ]) {
      if (isPlaceholder(expected)) {
        skip(`governance.${id}`, `manifest governance.${id} not pinned`);
        continue;
      }
      try {
        const actual = await read(client, policies, POLICIES_ABI, fn);
        add(
          `governance.${id}`,
          numericEquals(expected, actual) ? 'pass' : 'fail',
          `onchain=${actual} manifest=${expected}`,
        );
      } catch (error) {
        bad(`governance.${id}`, errMessage(error));
      }
    }

    // (h) full membership for all three houses + disjointness, checked against
    // the manifest panel lists (the on-chain membership checks above prove the
    // lists are admitted; this proves the lists themselves are well-formed).
    const houses = { primary, fallback, veto };
    const panelProblems = [];
    for (const [house, list] of Object.entries(houses)) {
      if (list.length === 0) panelProblems.push(`${house} empty`);
      const lowered = list.map((entry) => String(entry).toLowerCase());
      if (new Set(lowered).size !== lowered.length) panelProblems.push(`${house} has duplicates`);
    }
    const seen = new Map();
    for (const [house, list] of Object.entries(houses)) {
      for (const entry of list) {
        const key = String(entry).toLowerCase();
        if (seen.has(key) && seen.get(key) !== house) {
          panelProblems.push(`${key} appears in ${seen.get(key)} and ${house}`);
        }
        seen.set(key, house);
      }
    }
    add(
      'panel.completeness',
      panelProblems.length === 0 ? 'pass' : 'fail',
      panelProblems.length === 0
        ? `primary=${primary.length} fallback=${fallback.length} veto=${veto.length}, distinct and disjoint`
        : panelProblems.join('; '),
    );

    // (i) hub per-tier quorum/delay expectations vs the frozen canonical table.
    const manifestTiers = Array.isArray(manifest && manifest.hubTiers) ? manifest.hubTiers : null;
    if (!manifestTiers) {
      skip('hubTiers', 'manifest has no hubTiers block');
    } else {
      add(
        'hubTiers',
        tiersMatch(manifestTiers) ? 'pass' : 'fail',
        tiersMatch(manifestTiers) ? 'matches canonical tier table' : 'manifest hubTiers differ from canonical tier table',
      );
    }

    // (j) panel quorum coverage: a 5-member panel must support the highest tier
    // quorum (3), and the veto house must support the veto quorum (2).
    const coverageTiers = manifestTiers && tiersMatch(manifestTiers) ? manifestTiers : EXPECTED_HUB_TIERS;
    const maxNumeric = (values) => values.reduce((max, value) => (BigInt(value) > BigInt(max) ? value : max));
    const maxPrimaryQuorum = maxNumeric(coverageTiers.map((tier) => tier.primaryQuorum));
    const maxFallbackQuorum = maxNumeric(coverageTiers.map((tier) => tier.fallbackQuorum));
    const vetoQuorum = isPlaceholder(governance.vetoQuorum) ? EXPECTED_GOVERNANCE.vetoQuorum : governance.vetoQuorum;
    const coverageOk =
      primary.length >= Number(maxPrimaryQuorum) &&
      fallback.length >= Number(maxFallbackQuorum) &&
      veto.length >= Number(vetoQuorum);
    add(
      'panel.coverage',
      coverageOk ? 'pass' : 'fail',
      `primary=${primary.length}/${maxPrimaryQuorum} fallback=${fallback.length}/${maxFallbackQuorum} veto=${veto.length}/${vetoQuorum}`,
    );

    // Structural floors (5 primary, 5 fallback, 3 veto) applied identically at
    // construction and rotation; a panel can never be shrunk below these.
    const minSizes = governance.minPanelSizes || EXPECTED_GOVERNANCE.minPanelSizes;
    const minSizesOk =
      primary.length >= Number(minSizes.primary) &&
      fallback.length >= Number(minSizes.fallback) &&
      veto.length >= Number(minSizes.veto);
    add(
      'panel.minSizes',
      minSizesOk ? 'pass' : 'fail',
      `primary=${primary.length}/${minSizes.primary} fallback=${fallback.length}/${minSizes.fallback} veto=${veto.length}/${minSizes.veto}`,
    );

    // (k) arbitration tier bitmask must allow every principal the manifest says
    // is present (or expected to be funded).
    let tiersAllowedOnchain;
    try {
      const arbId = onchainPolicyId(viem, 'arbitration-v1');
      const arbRes = await read(client, policies, POLICIES_ABI, POLICY_GETTERS['arbitration-v1'].fn, [arbId]);
      tiersAllowedOnchain = pick(arbRes, POLICY_GETTERS['arbitration-v1'].valueIndexes.tiersAllowed);
    } catch (error) {
      bad('tierAllows', errMessage(error));
    }
    if (tiersAllowedOnchain !== undefined) {
      const principals = Array.isArray(manifest && manifest.expectedPrincipals) ? manifest.expectedPrincipals : [];
      for (let i = 0; i < principals.length; i += 1) {
        const tierIndex = tierForPrincipal(principals[i]);
        add(
          `tierAllows[${i}]`,
          tierAllowed(tiersAllowedOnchain, tierIndex) ? 'pass' : 'fail',
          `principal=${principals[i]} tier=${tierIndex} tiersAllowed=${tiersAllowedOnchain}`,
        );
      }
    }
  }

  // (f) solvency and (optionally) no funded deals.
  if (isCode(hubCode) && ADDRESS_RE.test(typeof contracts.usdc === 'string' ? contracts.usdc : '')) {
    try {
      const liabilities = BigInt(await read(client, hub, HUB_ABI, 'totalLiabilities'));
      const balance = BigInt(await read(client, contracts.usdc, ERC20_ABI, 'balanceOf', [hub]));
      add(
        'solvency',
        liabilities <= balance ? 'pass' : 'fail',
        `liabilities=${liabilities} usdcBalance=${balance}`,
      );
      const expectNoDeals =
        (manifest && manifest.expectedFundedDeals === 0) || Boolean(manifest && manifest.solvency && manifest.solvency.expectNoDeals);
      if (expectNoDeals) {
        add('noDeals', liabilities === 0n ? 'pass' : 'fail', `liabilities=${liabilities}`);
      }
    } catch (error) {
      bad('solvency', errMessage(error));
    }
    try {
      const decimals = await read(client, contracts.usdc, ERC20_ABI, 'decimals');
      add('usdc.decimals', Number(decimals) === 6 ? 'pass' : 'fail', `decimals=${decimals}`);
    } catch (error) {
      bad('usdc.decimals', errMessage(error));
    }
  }

  const failures = checks.filter((check) => check.status === 'fail').length;
  const unresolved = checks.filter((check) => check.status === 'unresolved').length;
  // REQUIRED unresolved checks (bytecode/link pins, not optional manifest
  // fields) block the PASS verdict: a release must not go green with an
  // unpinned/unverified runtime.
  const requiredUnresolved = checks.filter(
    (check) => check.status === 'unresolved' && check.advisory !== true,
  ).length;
  return {
    manifestPath: options.manifestPath,
    chainId,
    ok: failures === 0 && requiredUnresolved === 0,
    failures,
    unresolved,
    requiredUnresolved,
    checks,
  };
}

export function formatTable(result) {
  const rows = [['CHECK', 'STATUS', 'DETAIL']];
  for (const check of result.checks) {
    rows.push([check.id, check.status.toUpperCase(), String(check.detail || '')]);
  }
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column].length)));
  const lines = [];
  rows.forEach((row, index) => {
    lines.push(row.map((cell, column) => cell.padEnd(widths[column])).join('  '));
    if (index === 0) lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  });
  const header = `manifest: ${result.manifestPath || '(inline)'}`;
  const required = result.requiredUnresolved ?? 0;
  const summary = `checks: ${result.checks.length}   failed: ${result.failures}   unresolved: ${result.unresolved}   required-unresolved: ${required}`;
  const verdict = result.ok ? 'DEPLOYMENT: PASS' : 'DEPLOYMENT: FAIL';
  return `${header}\n${summary}\n\n${lines.join('\n')}\n\n${verdict}`;
}

export function resolveRpcUrl(env = process.env) {
  if (env.BASE_RPC_URL && env.BASE_RPC_URL.trim() !== '') return env.BASE_RPC_URL.trim();
  if (env.BASE_RPC_URLS) {
    const first = env.BASE_RPC_URLS.split(',').map((entry) => entry.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return undefined;
}

function redactRpc(url) {
  if (typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function parseArgs(args) {
  const opts = { json: false, manifest: undefined, rpcUrl: undefined, chain: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--manifest=')) opts.manifest = arg.slice('--manifest='.length);
    else if (arg === '--manifest') opts.manifest = args[++index];
    else if (arg.startsWith('--rpc-url=')) opts.rpcUrl = arg.slice('--rpc-url='.length);
    else if (arg === '--rpc-url') opts.rpcUrl = args[++index];
    else if (arg.startsWith('--chain=')) opts.chain = Number(arg.slice('--chain='.length));
    else if (arg === '--chain') opts.chain = Number(args[++index]);
    else if (!arg.startsWith('-') && opts.manifest === undefined) opts.manifest = arg;
  }
  return opts;
}

function emit(result, opts) {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatTable(result));
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const manifestPath = opts.manifest || (opts.chain ? path.join(REPO_ROOT, 'deploy', `manifest.${opts.chain}.json`) : DEFAULT_MANIFEST_PATH);

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    const result = {
      manifestPath,
      ok: false,
      failures: 1,
      unresolved: 0,
      checks: [{ id: 'manifest.read', status: 'fail', detail: `cannot read/parse ${manifestPath}: ${errMessage(error)}` }],
    };
    emit(result, opts);
    return result;
  }

  const rpcUrl = opts.rpcUrl || resolveRpcUrl();
  if (!rpcUrl) {
    const result = {
      manifestPath,
      ok: false,
      failures: 1,
      unresolved: 0,
      checks: [{ id: 'rpc', status: 'fail', detail: 'BASE_RPC_URL(S) or --rpc-url required' }],
    };
    emit(result, opts);
    return result;
  }

  const viem = loadViem();
  let client;
  try {
    client = viem.createPublicClient({ transport: viem.http(rpcUrl) });
  } catch (error) {
    const result = {
      manifestPath,
      ok: false,
      failures: 1,
      unresolved: 0,
      checks: [{ id: 'rpc', status: 'fail', detail: errMessage(error) }],
    };
    emit(result, opts);
    return result;
  }

  const result = await verifyDeployment(manifest, {
    client,
    viem,
    chainId: opts.chain,
    manifestPath,
  });
  result.rpcUrl = redactRpc(rpcUrl);
  emit(result, opts);
  return result;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((result) => {
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(`verify-deployment failed: ${error && error.message}`);
      process.exitCode = 1;
    });
}
