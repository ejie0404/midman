// Pure orchestration tests for scripts/verify-release.mjs. No real suites or
// tools are executed: every test injects a stubbed runner, so this file proves
// the *gate semantics* (missing tool fails in mandatory mode, --optional
// downgrades to skipped, a failing suite still fails, adversarial coverage must
// be present) deterministically.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVERSARIAL_COVERAGE,
  REQUIRED_SUITES,
  classifyOutcome,
  formatTable,
  parseArgs,
  verifyRelease,
} from './verify-release.mjs';

// Return the stdout a real suite would produce for its scenarios.
function coverageOutput(suiteId, { drop } = {}) {
  return ADVERSARIAL_COVERAGE.filter((entry) => entry.suites.includes(suiteId))
    .map((entry) => (entry.expect === drop ? '' : `[PASS] ${entry.expect}`))
    .join('\n');
}

function makeRunner({ fail = [], missing = [], drop, throwFor = [] } = {}) {
  return (suite) => {
    if (throwFor.includes(suite.id)) throw new Error(`boom ${suite.id}`);
    if (missing.includes(suite.id)) return { status: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
    if (fail.includes(suite.id)) return { status: 1, stdout: coverageOutput(suite.id, { drop }), stderr: 'failure' };
    return { status: 0, stdout: coverageOutput(suite.id, { drop }), stderr: '' };
  };
}

function findCheck(result, id) {
  const check = result.checks.find((entry) => entry.id === id);
  assert.ok(check, `expected check ${id}`);
  return check;
}

describe('mandatory mode', () => {
  it('passes when every required suite succeeds and coverage is present', async () => {
    const result = await verifyRelease({ run: makeRunner() });
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => c.status === 'fail')));
    assert.equal(result.failures, 0);
    assert.equal(findCheck(result, 'suite.forge-e2e').status, 'pass');
    for (const coverage of ADVERSARIAL_COVERAGE) {
      assert.equal(findCheck(result, `coverage.${coverage.scenario}`).status, 'pass', coverage.scenario);
    }
  });

  it('fails when a required runner is missing', async () => {
    const result = await verifyRelease({ run: makeRunner({ missing: ['forge-test'] }) });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'suite.forge-test').status, 'fail');
  });

  it('treats an ENOENT outcome as a failure for a required suite', async () => {
    const result = await verifyRelease({ run: makeRunner({ missing: ['anvil-e2e'] }) });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'suite.anvil-e2e').status, 'fail');
  });

  it('fails when a required suite exits non-zero', async () => {
    const result = await verifyRelease({ run: makeRunner({ fail: ['script-suites'] }) });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'suite.script-suites').status, 'fail');
  });

  it('fails when a runner throws', async () => {
    const result = await verifyRelease({ run: makeRunner({ throwFor: ['spec-model'] }) });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'suite.spec-model').status, 'fail');
  });

  it('fails when an adversarial scenario did not run', async () => {
    const result = await verifyRelease({ run: makeRunner({ drop: 'testAcceptance02_PartialAwardBothBonds' }) });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'coverage.partial award').status, 'fail');
  });
});

describe('optional mode', () => {
  it('downgrades a missing tool to skipped and still passes', async () => {
    const result = await verifyRelease({
      run: makeRunner({ missing: ['forge-test', 'forge-e2e', 'forge-adversarial', 'anvil-e2e'] }),
      optional: true,
    });
    assert.equal(result.ok, true);
    assert.equal(findCheck(result, 'suite.forge-test').status, 'skipped');
    assert.equal(findCheck(result, 'suite.anvil-e2e').status, 'skipped');
  });

  it('reports coverage backed only by skipped suites as unresolved', async () => {
    const result = await verifyRelease({
      run: makeRunner({ missing: ['forge-e2e', 'forge-adversarial'] }),
      optional: true,
    });
    assert.equal(findCheck(result, 'coverage.partial award').status, 'unresolved');
    assert.equal(findCheck(result, 'coverage.outage').status, 'unresolved');
    assert.equal(result.ok, true);
  });

  it('still fails when an available suite exits non-zero', async () => {
    const result = await verifyRelease({ run: makeRunner({ fail: ['forge-test'] }), optional: true });
    assert.equal(result.ok, false);
    assert.equal(findCheck(result, 'suite.forge-test').status, 'fail');
  });
});

describe('classification and formatting', () => {
  it('classifies ENOENT as fail in mandatory and skipped in optional', () => {
    const outcome = { status: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
    assert.equal(classifyOutcome(outcome, { optional: false, suite: { required: true } }).status, 'fail');
    assert.equal(classifyOutcome(outcome, { optional: true, suite: { required: true } }).status, 'skipped');
  });

  it('classifies exit 127 as missing and exit 0 as pass', () => {
    assert.equal(classifyOutcome({ status: 127 }, { suite: {} }).status, 'fail');
    assert.equal(classifyOutcome({ status: 0 }, { suite: {} }).status, 'pass');
    assert.equal(classifyOutcome({ status: 2 }, { suite: {} }).status, 'fail');
  });

  it('renders PASS/FAIL verdicts and mode', async () => {
    const pass = await verifyRelease({ run: makeRunner() });
    assert.match(formatTable(pass), /RELEASE: PASS/);
    assert.match(formatTable(pass), /mode: mandatory/);
    const optional = await verifyRelease({ run: makeRunner(), optional: true });
    assert.match(formatTable(optional), /mode: optional/);
  });

  it('parses --optional, --json and --verbose flags', () => {
    assert.deepEqual(parseArgs(['--optional', '--json', '--verbose']), { optional: true, json: true, verbose: true });
    assert.deepEqual(parseArgs([]), { optional: false, json: false, verbose: false });
  });

  it('registers all nine required suites and nine coverage scenarios', () => {
    assert.equal(REQUIRED_SUITES.length, 9);
    assert.ok(REQUIRED_SUITES.every((suite) => suite.id && suite.command && Array.isArray(suite.args)));
    assert.equal(ADVERSARIAL_COVERAGE.length, 9);
  });
});
