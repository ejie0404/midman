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

export const POLICY_GETTERS = {
  'fee-v1': { fn: 'feePolicies', existsIndex: 0, hashIndex: 1 },
  'category-v1': { fn: 'categoryPolicies', existsIndex: 0, hashIndex: 1 },
  'readiness-v1': { fn: 'readinessPolicies', existsIndex: 0, hashIndex: 1 },
  'evidence-v1': { fn: 'evidencePolicies', existsIndex: 0, hashIndex: 1 },
  'bond-v1': { fn: 'bondPolicies', existsIndex: 0, hashIndex: 1 },
  'arbitration-v1': { fn: 'arbitrationPolicies', existsIndex: 0, hashIndex: 1 },
  'outage-v1': { fn: 'outagePolicies', existsIndex: 0, hashIndex: 1 },
  'catastrophic-v1': { fn: 'catastrophicPolicies', existsIndex: 0, hashIndex: 1 },
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
  const add = (id, status, detail = '') => checks.push({ id, status, detail });
  const ok = (id, detail) => add(id, 'pass', detail);
  const bad = (id, detail) => add(id, 'fail', detail);
  const skip = (id, detail) => add(id, 'unresolved', detail);

  const contracts = (manifest && manifest.contracts) || {};
  const roles = (manifest && manifest.roles) || {};
  const domain = (manifest && manifest.domain) || {};
  const policyHashes = (manifest && manifest.policyHashes) || {};
  const chainId = options.chainId ?? (manifest && manifest.network && manifest.network.chainId);
  const hub = contracts.hub;
  const policies = contracts.policies;

  if (!ADDRESS_RE.test(typeof hub === 'string' ? hub : '')) {
    bad('contracts.hub', `invalid or placeholder hub address: ${hub}`);
  }
  if (!ADDRESS_RE.test(typeof policies === 'string' ? policies : '')) {
    bad('contracts.policies', `invalid or placeholder policies address: ${policies}`);
  }

  // (a) code presence + optional deployedBytecode hash pinning.
  let hubCode;
  let policiesCode;
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

  const bytecodeHashes = (manifest && manifest.bytecodeHashes) || {};
  for (const [name, address, code] of [
    ['MidmanHub', hub, hubCode],
    ['MidmanPolicies', policies, policiesCode],
  ]) {
    const pinned = bytecodeHashes[name];
    if (isPlaceholder(pinned)) {
      skip(`codeHash.${name}`, 'manifest bytecode hash is a placeholder');
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
    add(`codeHash.${name}`, eqHex(actual, pinned) ? 'pass' : 'fail', actual);
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
      } catch (error) {
        bad(`policy.${policyType}`, errMessage(error));
      }
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
  return {
    manifestPath: options.manifestPath,
    chainId,
    ok: failures === 0,
    failures,
    unresolved,
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
  const summary = `checks: ${result.checks.length}   failed: ${result.failures}   unresolved: ${result.unresolved}`;
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
