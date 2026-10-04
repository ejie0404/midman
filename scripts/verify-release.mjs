// Mandatory release-verification orchestrator (Round-2 Phase 7).
//
// This is the single command that proves a checkout is *verified* — not merely
// implemented. It runs every required integration suite and FAILS if a required
// tool or step is unavailable, so a release cannot silently pass because anvil,
// forge, pnpm or a suite was skipped.
//
// Required suites:
//   spec-model        node specs/validate-spec.mjs          (567,700 model cases)
//   workspace-build   pnpm -r build                         (deterministic test discovery)
//   node-suites       pnpm -r test                          (all workspace packages)
//   script-suites     pnpm test:scripts                     (release-gate scripts)
//   forge-build       forge build                           (packages/contracts)
//   forge-test        forge test                            (unit/fuzz/invariant)
//   forge-e2e         forge test --match-path test/e2e/*    (normal + adversarial journeys)
//   forge-adversarial forge test --match-path test/Adversarial.t.sol (veto/outage/rotation)
//   anvil-e2e         node scripts/e2e-anvil.mjs            (live deploy + verify)
//
// Adversarial acceptance: after the Foundry suites run, the orchestrator asserts
// the expected coverage test names actually appear in the captured output for
// the required scenarios (normal, partial award, zero respondent bond, lapse,
// veto/fallback, stale signature, outage, restart, direct recovery).
//
// --optional is the local convenience mode: an *unavailable* tool becomes a
// skipped check instead of a failure. A suite that runs and fails still fails,
// and coverage backed only by skipped suites is reported `unresolved`.
//
// Usage:
//   node scripts/verify-release.mjs             # mandatory (CI gate)
//   node scripts/verify-release.mjs --optional  # local: skip unavailable tools
//   node scripts/verify-release.mjs --json
//
// Exports (unit tested in scripts/verify-release.test.mjs):
//   REQUIRED_SUITES, ADVERSARIAL_COVERAGE
//   classifyOutcome(outcome, { optional, suite })
//   verifyRelease({ run, optional, suites })
//   formatTable(result), parseArgs(args)

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const NODE = process.execPath;
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const FORGE_FALLBACK = 'C:/Users/subze/AppData/Local/Temp/opencode/foundry/forge.exe';

export const REQUIRED_SUITES = [
  {
    id: 'spec-model',
    required: true,
    description: 'spec/reference model validation',
    command: NODE,
    args: ['specs/validate-spec.mjs'],
  },
  {
    id: 'workspace-build',
    required: true,
    description: 'workspace build (makes node test discovery deterministic)',
    command: PNPM,
    args: ['-r', 'build'],
  },
  {
    id: 'node-suites',
    required: true,
    description: 'workspace node test suites',
    command: PNPM,
    args: ['-r', 'test'],
  },
  {
    id: 'script-suites',
    required: true,
    description: 'release-gate script suites',
    command: PNPM,
    args: ['test:scripts'],
  },
  {
    id: 'forge-build',
    required: true,
    description: 'contract build',
    command: 'forge',
    args: ['build'],
    cwd: 'packages/contracts',
  },
  {
    id: 'forge-test',
    required: true,
    description: 'contract unit/fuzz/invariant tests',
    command: 'forge',
    args: ['test'],
    cwd: 'packages/contracts',
  },
  {
    id: 'forge-e2e',
    required: true,
    description: 'contract e2e journeys (normal + partial + lapse + veto + stale + recovery)',
    command: 'forge',
    args: ['test', '--match-path', 'test/e2e/*.t.sol'],
    cwd: 'packages/contracts',
  },
  {
    id: 'forge-adversarial',
    required: true,
    description: 'contract adversarial suite (outage + rotation + keeper inactivity)',
    command: 'forge',
    args: ['test', '--match-path', 'test/Adversarial.t.sol'],
    cwd: 'packages/contracts',
  },
  {
    id: 'anvil-e2e',
    required: true,
    description: 'live anvil deploy + release verification',
    command: NODE,
    args: ['scripts/e2e-anvil.mjs'],
  },
];

// Scenario -> the Foundry test that must have run and passed. `suites` names the
// orchestrator suites whose captured stdout is searched.
export const ADVERSARIAL_COVERAGE = [
  { scenario: 'normal journey', expect: 'testJourneyA_HappyPath', suites: ['forge-e2e'] },
  { scenario: 'partial award', expect: 'testAcceptance02_PartialAwardBothBonds', suites: ['forge-e2e'] },
  { scenario: 'zero respondent bond', expect: 'testAcceptance04_MissingRespondent', suites: ['forge-e2e'] },
  { scenario: 'lapsed escalation', expect: 'testAcceptance03_LapsedEscalation', suites: ['forge-e2e'] },
  { scenario: 'veto/fallback', expect: 'testAcceptance06_VetoThenFallback', suites: ['forge-e2e'] },
  { scenario: 'stale/revoked signature', expect: 'testAcceptance07_RevokedTerms', suites: ['forge-e2e'] },
  { scenario: 'outage', expect: 'testOutageExtendsDelivery', suites: ['forge-adversarial'] },
  { scenario: 'restart/keeper inactivity', expect: 'testKeeperInactivity', suites: ['forge-adversarial'] },
  { scenario: 'direct recovery', expect: 'testAcceptance11_PermissionlessRelayer', suites: ['forge-e2e'] },
];

export function resolveForge() {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;
  try {
    if (spawnSync(FORGE_FALLBACK, ['--version'], { encoding: 'utf8' }).status === 0) return FORGE_FALLBACK;
  } catch {
    // fall through
  }
  return 'forge';
}

function resolveCommand(command) {
  if (command === 'forge') return resolveForge();
  return command;
}

export function defaultRunner(suite, { cwd = REPO_ROOT } = {}) {
  const command = resolveCommand(suite.command);
  const suiteCwd = suite.cwd ? path.join(REPO_ROOT, suite.cwd) : cwd;
  const usesShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const result = spawnSync(command, suite.args || [], {
    cwd: suiteCwd,
    encoding: 'utf8',
    env: process.env,
    shell: usesShell,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

/// @notice Classify a runner outcome. `missing` means the tool could not be
/// executed at all (ENOENT / 127); in mandatory mode that is a failure, in
/// --optional mode it is downgraded to skipped.
export function classifyOutcome(outcome = {}, { optional = false, suite = {} } = {}) {
  const required = suite.required !== false;
  const error = outcome.error;
  if (error && error.code === 'ENOENT') {
    return required && !optional
      ? { status: 'fail', detail: 'required tool unavailable (ENOENT)' }
      : { status: 'skipped', detail: 'tool unavailable (optional mode)' };
  }
  if (outcome.status === 127 || (outcome.status === null && error)) {
    return required && !optional
      ? { status: 'fail', detail: `required tool unavailable (${error && error.message ? error.message : 'not found'})` }
      : { status: 'skipped', detail: 'tool unavailable (optional mode)' };
  }
  if (outcome.status === 0) return { status: 'pass', detail: 'ok' };
  return { status: 'fail', detail: `exit ${outcome.status}` };
}

/// @notice Pure orchestration: every suite is executed through the injected
/// `run` function, results classified, then adversarial coverage asserted from
/// the captured output. Tests inject a stubbed `run`.
export async function verifyRelease(options = {}) {
  const run = options.run || defaultRunner;
  const suites = options.suites || REQUIRED_SUITES;
  const optional = Boolean(options.optional);
  const verbose = options.verbose ?? (process.env.VERIFY_RELEASE_VERBOSE === '1');
  const checks = [];
  const outputs = {};

  for (const suite of suites) {
    let outcome;
    try {
      outcome = await run(suite, { cwd: REPO_ROOT, optional });
    } catch (error) {
      outcome = { error: error || new Error('runner threw') };
    }
    const classified = classifyOutcome(outcome, { optional, suite });
    outputs[suite.id] = `${(outcome && outcome.stdout) || ''}\n${(outcome && outcome.stderr) || ''}`;
    checks.push({ id: `suite.${suite.id}`, status: classified.status, detail: classified.detail });
    if (verbose && classified.status === 'fail') {
      const tail = String((outcome && outcome.stdout) || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-25)
        .join('\n');
      console.error(`\n--- ${suite.id} FAILED (${classified.detail}) ---\n${tail}\n`);
    }
  }

  const statusOf = (id) => {
    const check = checks.find((entry) => entry.id === `suite.${id}`);
    return check ? check.status : 'missing';
  };

  for (const coverage of ADVERSARIAL_COVERAGE) {
    const sourceStatuses = coverage.suites.map(statusOf);
    if (sourceStatuses.every((status) => status === 'skipped')) {
      checks.push({
        id: `coverage.${coverage.scenario}`,
        status: 'unresolved',
        detail: `suite(s) ${coverage.suites.join(', ')} skipped (optional mode)`,
      });
      continue;
    }
    const haystack = coverage.suites.map((id) => outputs[id] || '').join('\n');
    checks.push({
      id: `coverage.${coverage.scenario}`,
      status: haystack.includes(coverage.expect) ? 'pass' : 'fail',
      detail: coverage.expect,
    });
  }

  const failures = checks.filter((check) => check.status === 'fail').length;
  const skipped = checks.filter((check) => check.status === 'skipped').length;
  const unresolved = checks.filter((check) => check.status === 'unresolved').length;
  return { ok: failures === 0, failures, skipped, unresolved, optional, checks };
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
  const mode = result.optional ? 'optional' : 'mandatory';
  const summary = `mode: ${mode}   checks: ${result.checks.length}   failed: ${result.failures}   skipped: ${result.skipped}   unresolved: ${result.unresolved}`;
  const verdict = result.ok ? 'RELEASE: PASS' : 'RELEASE: FAIL';
  return `${summary}\n\n${lines.join('\n')}\n\n${verdict}`;
}

export function parseArgs(args) {
  const opts = { optional: false, json: false, verbose: false };
  for (const arg of args) {
    if (arg === '--optional') opts.optional = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--verbose') opts.verbose = true;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = await verifyRelease({ optional: opts.optional, verbose: opts.verbose });
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatTable(result));
  return result;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((result) => {
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(`verify-release failed: ${error && error.message}`);
      process.exitCode = 1;
    });
}
