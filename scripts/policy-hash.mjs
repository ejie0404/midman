// Canonical, deterministic policy-record hashing for the Midman release
// manifest (Phase 12). The hash is keccak256 over a deterministic JSON
// serialization: object keys sorted recursively, no insignificant whitespace,
// and every primitive rendered exactly. All money/second quantities live in
// the policy records as exact integer strings, so the serialization is stable
// across platforms.
//
// Usage:
//   node scripts/policy-hash.mjs [policiesDir]
//
// Exports:
//   canonicalize(value)                -> deterministic JSON string
//   policyContentHash(record)          -> 0x-prefixed 32-byte keccak256 hex
//   loadPolicyRecords(dir)             -> [{ file, id, record }]
//   hashAll(dir)                       -> { [policyId]: hash }
//   loadViem()                         -> viem module (resolved from workspace)

import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_POLICIES_DIR = path.join(REPO_ROOT, 'deploy', 'policies');

export const POLICY_IDS = [
  'fee-v1',
  'category-v1',
  'readiness-v1',
  'evidence-v1',
  'bond-v1',
  'arbitration-v1',
  'outage-v1',
  'catastrophic-v1',
];

const VIEM_BASES = [
  REPO_ROOT,
  path.join(REPO_ROOT, 'packages', 'chain'),
  path.join(REPO_ROOT, 'apps', 'api'),
  path.join(REPO_ROOT, 'apps', 'web'),
  path.join(REPO_ROOT, 'apps', 'worker'),
  path.join(REPO_ROOT, 'node_modules', '.pnpm'),
];

// Resolve viem from whichever workspace package has it linked. Root scripts
// are not themselves a package, so a plain `import 'viem'` cannot see it.
export function loadViem(bases = VIEM_BASES) {
  const req = createRequire(import.meta.url);
  let lastError;
  for (const base of bases) {
    if (!existsSync(base)) continue;
    try {
      const resolved = req.resolve('viem', { paths: [base] });
      return req(resolved);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Unable to resolve viem from workspace. Tried: ${bases.join(', ')}. ` +
      `Last error: ${lastError && lastError.message}`,
  );
}

// Deterministic serializer. This is the single source of truth for the hash
// preimage; tests pin its exact output. Rules:
//   - object keys sorted ascending (Unicode code-point order)
//   - no whitespace
//   - integers rendered as exact decimal digits (no quotes)
//   - strings JSON-escaped and quoted
//   - arrays preserve order
export function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number': {
      if (!Number.isFinite(value)) throw new TypeError('canonicalize: non-finite number');
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonicalize: unsafe/non-integer number ${value}; use an exact string`);
      }
      return String(value);
    }
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
      }
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }
}

export function policyContentHash(record, viem = loadViem()) {
  return viem.keccak256(viem.stringToHex(canonicalize(record)));
}

export async function loadPolicyRecords(dir = DEFAULT_POLICIES_DIR) {
  const entries = (await readdir(dir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const records = [];
  for (const file of entries) {
    const fullPath = path.join(dir, file);
    const record = JSON.parse(await readFile(fullPath, 'utf8'));
    records.push({ file, path: fullPath, id: record.id, record });
  }
  return records;
}

// Returns { [policyId]: hash } for every record in the directory.
export async function hashAll(dir = DEFAULT_POLICIES_DIR, viem = loadViem()) {
  const records = await loadPolicyRecords(dir);
  const hashes = {};
  for (const { id, record } of records) {
    hashes[id] = policyContentHash(record, viem);
  }
  return hashes;
}

export async function main(argv = process.argv.slice(2)) {
  const dir = argv.find((arg) => !arg.startsWith('-')) || DEFAULT_POLICIES_DIR;
  const hashes = await hashAll(dir);
  const ids = Object.keys(hashes);
  for (const id of ids) {
    console.log(`${id} ${hashes[id]}`);
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(hashes, null, 2));
  }
  return hashes;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`policy-hash failed: ${error && error.message}`);
    process.exitCode = 1;
  });
}
