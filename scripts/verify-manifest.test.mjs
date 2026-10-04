import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BASE_CHAIN_ID,
  DEFAULT_MANIFEST_PATH,
  USDC_BASE,
  computeBytecodeHashes,
  formatTable,
  isPlaceholder,
  verifyManifest,
} from './verify-manifest.mjs';

async function readExample() {
  return JSON.parse(await readFile(DEFAULT_MANIFEST_PATH, 'utf8'));
}

// Writes a mutated copy of the example manifest to a temp dir and runs the
// verifier against it, cleaning up afterwards.
async function withMutatedManifest(mutate, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'midman-manifest-'));
  try {
    const manifest = await readExample();
    mutate(manifest);
    const manifestPath = path.join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return await verifyManifest(manifestPath, options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function findCheck(result, id) {
  const check = result.checks.find((entry) => entry.id === id);
  assert.ok(check, `expected check ${id}`);
  return check;
}

describe('example manifest', () => {
  it('passes in non-strict mode with unresolved warnings only', async () => {
    const result = await verifyManifest();
    assert.equal(result.failures, 0);
    assert.ok(result.unresolved > 0);
    assert.equal(result.ok, true);
  });

  it('fails under --strict because unresolved placeholders remain', async () => {
    const result = await verifyManifest(DEFAULT_MANIFEST_PATH, { strict: true });
    assert.equal(result.failures, 0);
    assert.ok(result.unresolved > 0);
    assert.equal(result.ok, false);
  });

  it('recomputes all 8 policy hashes and matches the manifest', async () => {
    const result = await verifyManifest();
    assert.equal(findCheck(result, 'policyHashes').status, 'pass');
  });

  it('confirms pinned chainId and USDC constants', async () => {
    const result = await verifyManifest();
    assert.equal(findCheck(result, 'chainId').status, 'pass');
    assert.equal(findCheck(result, 'contracts.usdc').status, 'pass');
    assert.equal(findCheck(result, 'contracts.usdc').detail, USDC_BASE);
    assert.equal(BASE_CHAIN_ID, 8453);
  });

  it('renders a table with a verdict', async () => {
    const result = await verifyManifest();
    const table = formatTable(result);
    assert.match(table, /CHECK\s+STATUS\s+DETAIL/);
    assert.match(table, /VERIFY: PASS/);
  });

  it('reports placeholder release metadata as unresolved', async () => {
    const result = await verifyManifest();
    assert.equal(findCheck(result, 'releaseCommit').status, 'unresolved');
    assert.equal(findCheck(result, 'deploymentStatus').status, 'unresolved');
    assert.equal(isPlaceholder('0x...'), true);
    assert.equal(isPlaceholder(USDC_BASE), false);
  });
});

describe('failure detection', () => {
  it('fails on a mismatched USDC address', async () => {
    const result = await withMutatedManifest((manifest) => {
      manifest.contracts.usdc = '0x0000000000000000000000000000000000000000';
    });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'contracts.usdc').status, 'fail');
  });

  it('fails on a mismatched chainId', async () => {
    const result = await withMutatedManifest((manifest) => {
      manifest.network.chainId = 1;
    });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'chainId').status, 'fail');
  });

  it('fails on a mismatched domain version', async () => {
    const result = await withMutatedManifest((manifest) => {
      manifest.domain.version = '2';
    });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'domain.version').status, 'fail');
  });

  it('fails on a missing required top-level key', async () => {
    const result = await withMutatedManifest((manifest) => {
      delete manifest.roles;
    });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'schema').status, 'fail');
  });
});

describe('policy hash reconciliation', () => {
  it('treats a placeholder policy hash as unresolved, not a failure', async () => {
    const result = await withMutatedManifest((manifest) => {
      manifest.policyHashes['fee-v1'] = '0x...';
    });
    assert.equal(result.failures, 0);
    assert.equal(result.ok, true);
    assert.equal(findCheck(result, 'policyHashes').status, 'unresolved');
  });

  it('fails on a plausible but wrong policy hash', async () => {
    const result = await withMutatedManifest((manifest) => {
      manifest.policyHashes['fee-v1'] = `0x${'11'.repeat(32)}`;
    });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'policyHashes').status, 'fail');
  });
});

describe('bytecode hashes', () => {
  it('marks artifacts-missing when the artifacts directory is absent', async () => {
    const result = await verifyManifest(DEFAULT_MANIFEST_PATH, {
      artifactsDir: path.join(os.tmpdir(), 'midman-does-not-exist'),
    });
    assert.equal(findCheck(result, 'bytecodeHashes').status, 'artifacts-missing');
  });

  it('matches manifest bytecode hashes when compiled artifacts are present', async () => {
    const bytecode = await computeBytecodeHashes();
    if (!bytecode.available) {
      const result = await verifyManifest();
      assert.equal(findCheck(result, 'bytecodeHashes').status, 'artifacts-missing');
      return;
    }
    const result = await withMutatedManifest((manifest) => {
      manifest.bytecodeHashes = { ...bytecode.hashes };
    });
    assert.equal(findCheck(result, 'bytecodeHashes').status, 'pass');
  });
});
