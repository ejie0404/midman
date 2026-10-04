// Pre-deploy release-manifest verifier (Phase 12). Validates the manifest
// shape, pinned Base constants, recomputed policy content hashes, EIP-712
// domain, role panels, pinned dependencies, and (when Foundry artifacts exist)
// the keccak256 of each contract's deployedBytecode.
//
// Placeholders are reported as `unresolved` warnings, not failures, so the
// example manifest passes in non-strict mode. `--strict` promotes every
// unresolved/artifacts-missing warning to a blocking failure for release.
//
// Usage:
//   node scripts/verify-manifest.mjs [manifestPath] [--strict] [--json]
//     [--policies=<dir>] [--artifacts=<dir>]
//
// Exports:
//   verifyManifest(manifestPath, options) -> result
//   computeBytecodeHashes(artifactsDir)   -> { hashes, missing, available }
//   formatTable(result)                   -> string

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import {
  DEFAULT_POLICIES_DIR,
  POLICY_IDS,
  REPO_ROOT,
  loadPolicyRecords,
  loadViem,
  policyContentHash,
} from './policy-hash.mjs';

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_NAME = 'base';
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const SEQUENCER_FEED_BASE = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433';
export const BYTECODE_CONTRACTS = ['MidmanHub', 'MidmanPolicies', 'HubDispute'];
export const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, 'deploy', 'manifest.example.json');
export const DEFAULT_ARTIFACTS_DIR = path.join(REPO_ROOT, 'packages', 'contracts', 'out');

const REQUIRED_TOP_LEVEL = [
  'manifestVersion',
  'network',
  'deploymentStatus',
  'contracts',
  'roles',
  'policyHashes',
  'domain',
  'bytecodeHashes',
  'dependencies',
  'releaseCommit',
];

const REQUIRED_DEPENDENCIES = [
  'node',
  'pnpm',
  'solc',
  'viaIr',
  'optimizerRuns',
  'openzeppelin',
  'forgeStd',
  'viem',
  'next',
  'fastify',
  'bullmq',
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

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

function addressesEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

// Returns array of dotted paths to numeric leaves (exact-string policy rule).
function findNumericLeaves(value, prefix = '$') {
  const found = [];
  if (typeof value === 'number') {
    found.push(prefix);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => found.push(...findNumericLeaves(entry, `${prefix}[${index}]`)));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(...findNumericLeaves(child, `${prefix}.${key}`));
    }
  }
  return found;
}

export async function computeBytecodeHashes(artifactsDir = DEFAULT_ARTIFACTS_DIR, viem = loadViem()) {
  const hashes = {};
  const missing = [];
  for (const name of BYTECODE_CONTRACTS) {
    const artifactPath = path.join(artifactsDir, `${name}.sol`, `${name}.json`);
    if (!existsSync(artifactPath)) {
      missing.push(name);
      continue;
    }
    let artifact;
    try {
      artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    } catch {
      missing.push(name);
      continue;
    }
    const object = artifact && artifact.deployedBytecode && artifact.deployedBytecode.object;
    if (typeof object !== 'string' || object === '0x' || object.length < 4) {
      missing.push(name);
      continue;
    }
    hashes[name] = viem.keccak256(object);
  }
  return { hashes, missing, available: Object.keys(hashes).length > 0 };
}

export async function verifyManifest(manifestPath = DEFAULT_MANIFEST_PATH, options = {}) {
  const {
    strict = false,
    policiesDir = DEFAULT_POLICIES_DIR,
    artifactsDir = DEFAULT_ARTIFACTS_DIR,
  } = options;

  const checks = [];
  const add = (id, status, detail = '') => checks.push({ id, status, detail });

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    add('manifest.read', 'fail', `cannot read/parse ${manifestPath}: ${error && error.message}`);
    return summarize(manifestPath, strict, checks);
  }

  // 1. Schema shape.
  const missingKeys = REQUIRED_TOP_LEVEL.filter((key) => !(key in manifest));
  if (missingKeys.length > 0) {
    add('schema', 'fail', `missing top-level keys: ${missingKeys.join(', ')}`);
  } else {
    add('schema', 'pass', 'required top-level keys present');
  }

  // 2. Network + domain chain id.
  const chainOk =
    manifest.network &&
    manifest.network.chainId === BASE_CHAIN_ID &&
    manifest.domain &&
    manifest.domain.chainId === BASE_CHAIN_ID;
  add(
    'chainId',
    chainOk ? 'pass' : 'fail',
    chainOk
      ? `network+domain chainId == ${BASE_CHAIN_ID}`
      : `expected network/domain chainId == ${BASE_CHAIN_ID}`,
  );

  const nameOk = manifest.network && manifest.network.name === BASE_CHAIN_NAME;
  add('network.name', nameOk ? 'pass' : 'fail', nameOk ? `name == ${BASE_CHAIN_NAME}` : `expected name ${BASE_CHAIN_NAME}`);

  // 3. Pinned token + feed.
  const usdc = manifest.contracts && manifest.contracts.usdc;
  if (isPlaceholder(usdc)) add('contracts.usdc', 'unresolved', 'USDC address is a placeholder');
  else if (addressesEqual(usdc, USDC_BASE)) add('contracts.usdc', 'pass', USDC_BASE);
  else add('contracts.usdc', 'fail', `expected ${USDC_BASE}, got ${usdc}`);

  const feed = manifest.contracts && manifest.contracts.sequencerFeed;
  if (isPlaceholder(feed)) add('contracts.sequencerFeed', 'unresolved', 'sequencer feed address is a placeholder');
  else if (addressesEqual(feed, SEQUENCER_FEED_BASE)) add('contracts.sequencerFeed', 'pass', SEQUENCER_FEED_BASE);
  else add('contracts.sequencerFeed', 'fail', `expected ${SEQUENCER_FEED_BASE}, got ${feed}`);

  // 4. Policy records + recomputed hashes.
  let viem;
  try {
    viem = loadViem();
  } catch (error) {
    add('viem', 'fail', error && error.message);
    return summarize(manifestPath, strict, checks);
  }

  let records = [];
  try {
    records = await loadPolicyRecords(policiesDir);
  } catch (error) {
    add('policyRecords', 'fail', `cannot load ${policiesDir}: ${error && error.message}`);
  }

  if (records.length > 0) {
    const ids = records.map((entry) => entry.id);
    const missingIds = POLICY_IDS.filter((id) => !ids.includes(id));
    const extraIds = ids.filter((id) => !POLICY_IDS.includes(id));
    const versionOk = records.every((entry) => entry.record.version === 1 && typeof entry.record.id === 'string');
    const numericLeaves = records.flatMap((entry) => findNumericLeaves(entry.record.values, `${entry.id}.values`));
    if (missingIds.length > 0 || extraIds.length > 0 || !versionOk || numericLeaves.length > 0) {
      const details = [];
      if (missingIds.length) details.push(`missing ids: ${missingIds.join(', ')}`);
      if (extraIds.length) details.push(`unexpected ids: ${extraIds.join(', ')}`);
      if (!versionOk) details.push('record version/id invalid');
      if (numericLeaves.length) details.push(`non-string quantities: ${numericLeaves.slice(0, 5).join(', ')}`);
      add('policyRecords', 'fail', details.join('; '));
    } else {
      add('policyRecords', 'pass', `${records.length} records, version 1, exact integer strings`);
    }
  }

  const policyHashes = (manifest && manifest.policyHashes) || {};
  const mismatches = [];
  const unresolvedHashes = [];
  const matched = [];
  for (const { id, record } of records) {
    const expected = policyContentHash(record, viem);
    const actual = policyHashes[id];
    if (actual === undefined) {
      mismatches.push(`${id}: missing from manifest`);
    } else if (isPlaceholder(actual)) {
      unresolvedHashes.push(id);
    } else if (typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase()) {
      matched.push(id);
    } else {
      mismatches.push(`${id}: ${actual} != ${expected}`);
    }
  }
  const missingPolicyKeys = POLICY_IDS.filter((id) => !(id in policyHashes));
  if (missingPolicyKeys.length > 0) {
    mismatches.push(`missing policyIds in manifest: ${missingPolicyKeys.join(', ')}`);
  }
  if (mismatches.length > 0) {
    add('policyHashes', 'fail', mismatches.join('; '));
  } else if (unresolvedHashes.length > 0) {
    add('policyHashes', 'unresolved', `placeholder hashes: ${unresolvedHashes.join(', ')}`);
  } else {
    add('policyHashes', 'pass', `${matched.length}/${POLICY_IDS.length} recomputed hashes match`);
  }

  // 5. EIP-712 domain name + version.
  const domainName = manifest.domain && manifest.domain.name;
  if (domainName === 'MidmanEscrow') add('domain.name', 'pass', 'domain name == "MidmanEscrow"');
  else add('domain.name', 'fail', `expected domain.name "MidmanEscrow", got ${JSON.stringify(domainName)}`);

  const version = manifest.domain && manifest.domain.version;
  if (version === '1') add('domain.version', 'pass', 'domain version == "1"');
  else add('domain.version', 'fail', `expected domain.version "1", got ${JSON.stringify(version)}`);

  const verifyingContract = manifest.domain && manifest.domain.verifyingContract;
  if (isPlaceholder(verifyingContract)) add('domain.verifyingContract', 'unresolved', 'hub address is a placeholder');
  else if (addressesEqual(verifyingContract, manifest.contracts && manifest.contracts.hub))
    add('domain.verifyingContract', 'pass', 'matches contracts.hub');
  else add('domain.verifyingContract', 'fail', 'domain.verifyingContract != contracts.hub');

  // 6. Bytecode hashes (only when Foundry artifacts exist).
  let bytecode;
  try {
    bytecode = await computeBytecodeHashes(artifactsDir, viem);
  } catch (error) {
    bytecode = { hashes: {}, missing: [...BYTECODE_CONTRACTS], available: false, error };
  }
  const manifestBytecode = (manifest && manifest.bytecodeHashes) || {};
  if (!bytecode.available) {
    add(
      'bytecodeHashes',
      'artifacts-missing',
      `no compiled artifacts under ${artifactsDir} (run forge build)`,
    );
  } else {
    const bad = [];
    const pending = [];
    let okCount = 0;
    for (const name of Object.keys(bytecode.hashes)) {
      const expected = bytecode.hashes[name];
      const actual = manifestBytecode[name];
      if (isPlaceholder(actual)) pending.push(name);
      else if (typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase()) okCount += 1;
      else bad.push(`${name}: ${actual} != ${expected}`);
    }
    if (bad.length > 0) add('bytecodeHashes', 'fail', bad.join('; '));
    else if (pending.length > 0) add('bytecodeHashes', 'unresolved', `placeholder hashes: ${pending.join(', ')}`);
    else add('bytecodeHashes', 'pass', `${okCount} deployedBytecode hashes match`);
  }

  // 7. Role panels and addresses.
  const roles = (manifest && manifest.roles) || {};
  const panels = ['primaryPanel', 'fallbackPanel', 'vetoPanel'];
  const panelProblems = panels.filter((key) => !Array.isArray(roles[key]) || roles[key].length < 3);
  const addressKeys = [
    'governanceTimelock',
    'pauser',
    'admissionSigner',
    'treasury',
    'platformFeeRecipient',
    'arbitrationCostRecipient',
  ];
  const badAddresses = addressKeys.filter((key) => {
    const value = roles[key];
    return !isPlaceholder(value) && !ADDRESS_RE.test(typeof value === 'string' ? value : '');
  });
  const roleValues = [...addressKeys.map((key) => roles[key]), ...panels.flatMap((key) => roles[key] || [])];
  const anyRealRole = roleValues.some((value) => !isPlaceholder(value));
  if (panelProblems.length > 0 || badAddresses.length > 0) {
    const details = [];
    if (panelProblems.length) details.push(`panels <3 entries: ${panelProblems.join(', ')}`);
    if (badAddresses.length) details.push(`invalid addresses: ${badAddresses.join(', ')}`);
    add('roles', 'fail', details.join('; '));
  } else if (!anyRealRole) {
    add('roles', 'unresolved', 'all role holders and panel members are placeholders');
  } else {
    add('roles', 'pass', 'panels >=3 and role addresses valid');
  }

  // 8. Pinned dependencies (no floating ranges).
  const deps = (manifest && manifest.dependencies) || {};
  const missingDeps = REQUIRED_DEPENDENCIES.filter((key) => !(key in deps));
  const floating = Object.entries(deps)
    .filter(([, value]) => typeof value === 'string' && /[\^~*x]|\b(latest|next)\b/.test(value))
    .map(([key]) => key);
  if (missingDeps.length > 0 || floating.length > 0) {
    const details = [];
    if (missingDeps.length) details.push(`missing: ${missingDeps.join(', ')}`);
    if (floating.length) details.push(`floating ranges: ${floating.join(', ')}`);
    add('dependencies', 'fail', details.join('; '));
  } else {
    add('dependencies', 'pass', `${REQUIRED_DEPENDENCIES.length} pinned dependencies`);
  }

  // 9. Release commit + freeze date.
  const commit = manifest.releaseCommit;
  if (isPlaceholder(commit)) add('releaseCommit', 'unresolved', 'release commit is a placeholder');
  else if (COMMIT_RE.test(commit)) add('releaseCommit', 'pass', commit);
  else add('releaseCommit', 'fail', `expected 40-hex commit, got ${commit}`);

  add(
    'freezeDate',
    manifest.freezeDate === null || isPlaceholder(manifest.freezeDate) ? 'unresolved' : 'pass',
    manifest.freezeDate === null || isPlaceholder(manifest.freezeDate)
      ? 'release not frozen (freezeDate null)'
      : String(manifest.freezeDate),
  );

  // 10. Deployment status + declared unresolved list.
  if (manifest.deploymentStatus === 'UNVERIFIED_PLACEHOLDER') {
    add('deploymentStatus', 'unresolved', 'deploymentStatus == UNVERIFIED_PLACEHOLDER');
  } else {
    add('deploymentStatus', 'pass', String(manifest.deploymentStatus));
  }
  add(
    'unresolvedDeclared',
    Array.isArray(manifest.unresolved) ? 'pass' : 'fail',
    Array.isArray(manifest.unresolved) ? `${manifest.unresolved.length} unresolved items declared` : 'missing unresolved[]',
  );

  return summarize(manifestPath, strict, checks);
}

function summarize(manifestPath, strict, checks) {
  const failures = checks.filter((check) => check.status === 'fail').length;
  const unresolved = checks.filter(
    (check) => check.status === 'unresolved' || check.status === 'artifacts-missing',
  ).length;
  const ok = failures === 0 && (!strict || unresolved === 0);
  return { manifestPath, strict, ok, failures, unresolved, checks };
}

export function formatTable(result) {
  const rows = [['CHECK', 'STATUS', 'DETAIL']];
  for (const check of result.checks) {
    rows.push([check.id, check.status.toUpperCase(), check.detail]);
  }
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column].length)));
  const lines = [];
  rows.forEach((row, index) => {
    lines.push(row.map((cell, column) => cell.padEnd(widths[column])).join('  '));
    if (index === 0) lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  });
  const mode = result.strict ? 'strict' : 'non-strict';
  const header = `manifest: ${result.manifestPath}`;
  const summary = `mode: ${mode}   checks: ${result.checks.length}   failed: ${result.failures}   unresolved: ${result.unresolved}`;
  const verdict = result.ok ? 'VERIFY: PASS' : 'VERIFY: FAIL';
  return `${header}\n${summary}\n\n${lines.join('\n')}\n\n${verdict}`;
}

export function parseArgs(args) {
  const opts = { strict: false, json: false, manifest: undefined, policiesDir: undefined, artifactsDir: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--strict') opts.strict = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--manifest=')) opts.manifest = arg.slice('--manifest='.length);
    else if (arg === '--manifest') opts.manifest = args[++index];
    else if (arg.startsWith('--policies=')) opts.policiesDir = arg.slice('--policies='.length);
    else if (arg === '--policies') opts.policiesDir = args[++index];
    else if (arg.startsWith('--artifacts=')) opts.artifactsDir = arg.slice('--artifacts='.length);
    else if (arg === '--artifacts') opts.artifactsDir = args[++index];
    else if (!arg.startsWith('-') && opts.manifest === undefined) opts.manifest = arg;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = await verifyManifest(opts.manifest || DEFAULT_MANIFEST_PATH, {
    strict: opts.strict,
    policiesDir: opts.policiesDir,
    artifactsDir: opts.artifactsDir,
  });
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatTable(result));
  return result;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((result) => {
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(`verify-manifest failed: ${error && error.message}`);
      process.exitCode = 1;
    });
}
