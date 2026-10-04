// Structural tests for the generated chain ABIs (scripts/export-abi.mjs).
// Run: node --test scripts/export-abi.test.mjs
//
// Covers the audit findings: bondPolicies 4-field return, escalate /
// postRespondentBond 8-param signatures with the ReserveAuth tuple, the full
// hub event surface (incl. HubDispute events emitted via DELEGATECALL), and
// that no hand-written ABI entries remain in packages/chain/src/abi.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const GEN_DIR = path.join(REPO_ROOT, 'packages', 'chain', 'src', 'abi', 'generated');
const ABI_TS = path.join(REPO_ROOT, 'packages', 'chain', 'src', 'abi.ts');
const HUB_ARTIFACT = path.join(REPO_ROOT, 'packages', 'contracts', 'out', 'MidmanHub.sol', 'MidmanHub.json');
const DISPUTE_LIB_ARTIFACT = path.join(
  REPO_ROOT,
  'packages',
  'contracts',
  'out',
  'HubDispute.sol',
  'HubDispute.json',
);
const POLICIES_ARTIFACT = path.join(
  REPO_ROOT,
  'packages',
  'contracts',
  'out',
  'MidmanPolicies.sol',
  'MidmanPolicies.json',
);

// Root scripts are not a package, so resolve viem from workspace packages.
function loadViem() {
  const bases = [
    path.join(REPO_ROOT, 'packages', 'chain'),
    path.join(REPO_ROOT, 'apps', 'api'),
    path.join(REPO_ROOT, 'apps', 'worker'),
  ];
  const req = createRequire(import.meta.url);
  let lastError;
  for (const base of bases) {
    if (!existsSync(base)) continue;
    try {
      return req(req.resolve('viem', { paths: [base] }));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`export-abi.test: unable to resolve viem (${lastError && lastError.message})`);
}

function canonicalType(param) {
  if (!param.type.startsWith('tuple')) return param.type;
  const suffix = param.type.slice('tuple'.length);
  assert.ok(Array.isArray(param.components), `tuple param ${param.name} without components`);
  return `(${param.components.map(canonicalType).join(',')})${suffix}`;
}

function canonicalSignature(entry) {
  return `${entry.name}(${(entry.inputs ?? []).map(canonicalType).join(',')})`;
}

async function loadJson(file) {
  assert.ok(existsSync(file), `missing generated file ${path.relative(REPO_ROOT, file)}; run node scripts/export-abi.mjs`);
  return JSON.parse(await readFile(file, 'utf8'));
}

const hubGen = await loadJson(path.join(GEN_DIR, 'midmanHub.json'));
const policiesGen = await loadJson(path.join(GEN_DIR, 'midmanPolicies.json'));
const hubArtifact = JSON.parse(await readFile(HUB_ARTIFACT, 'utf8'));
const disputeArtifact = JSON.parse(await readFile(DISPUTE_LIB_ARTIFACT, 'utf8'));
const policiesArtifact = JSON.parse(await readFile(POLICIES_ARTIFACT, 'utf8'));
const viem = loadViem();

function artifactEvent(name) {
  for (const abi of [hubArtifact.abi, disputeArtifact.abi]) {
    const found = abi.find((e) => e.type === 'event' && e.name === name);
    if (found) return found;
  }
  return undefined;
}

// Every (function, input-arity) downstream encodes, with the CORRECT on-chain
// arity. Sources: apps/worker/src/relay.ts buildCalldata,
// packages/chain/src/recovery.ts, apps/api evidence/ruling/veto/mutual sites,
// apps/web openDispute. NOTE: relay.ts currently encodes escalate and
// postRespondentBond with 7 args (missing `reserve`); the table below pins
// the true 8-arg contract shape, so relay calls must add the ReserveAuth
// tuple or their viem encode throws and the job fails as "no-calldata".
const RELAY_CALLS = [
  ['refundForNonDelivery', 1],
  ['finalizeAfterTimeout', 1],
  ['lapseDispute', 1],
  ['advanceToPrimary', 1],
  ['activateFallback', 1],
  ['executeRuling', 1],
  ['markDeadlock', 1],
  ['catastrophicEscape', 1],
  ['claimFor', 2],
  ['markDelivered', 5],
  ['approveSeller', 5],
  ['refundBuyer', 5],
  ['openDispute', 6],
  ['escalate', 8],
  ['postRespondentBond', 8],
  ['mutualSettlement', 9],
  ['submitEvidenceCommitment', 9],
  ['queuePrimaryRuling', 2],
  ['queueFallbackRuling', 2],
  ['vetoPrimaryRuling', 3],
  ['vetoFallbackRuling', 3],
];

describe('export-abi envelopes', () => {
  it('generated files exist, parse, and carry forge provenance', () => {
    for (const [envelope, contract] of [
      [hubGen, 'MidmanHub'],
      [policiesGen, 'MidmanPolicies'],
    ]) {
      assert.equal(envelope.contract, contract);
      assert.equal(envelope.source, 'forge-artifact');
      assert.match(envelope.solc, /^0\.8\.26/);
      assert.match(envelope.abiHash, /^[0-9a-f]{64}$/, 'abiHash must be a deterministic content hash');
      assert.ok(Array.isArray(envelope.abi) && envelope.abi.length > 0);
    }
  });
});

describe('hub ABI matches forge artifacts', () => {
  it('every generated function exists in MidmanHub.json with identical input arity', () => {
    const artifactFns = new Map(
      hubArtifact.abi.filter((e) => e.type === 'function').map((e) => [e.name, e]),
    );
    const generatedFns = hubGen.abi.filter((e) => e.type === 'function');
    assert.ok(generatedFns.length > 0);
    for (const entry of generatedFns) {
      const artifact = artifactFns.get(entry.name);
      assert.ok(artifact, `hub function ${entry.name} missing from MidmanHub.json`);
      assert.equal(
        (entry.inputs ?? []).length,
        (artifact.inputs ?? []).length,
        `hub function ${entry.name} input arity drift`,
      );
      assert.equal(canonicalSignature(entry), canonicalSignature(artifact));
    }
    // No hub function lost: the generated set covers the artifact set.
    assert.equal(generatedFns.length, artifactFns.size);
  });

  it('every event has identical topic0 to the artifact (hub or HubDispute lib)', () => {
    const events = hubGen.abi.filter((e) => e.type === 'event');
    assert.ok(events.length > 0);
    const topics = new Set();
    for (const entry of events) {
      const artifact = artifactEvent(entry.name);
      assert.ok(artifact, `hub event ${entry.name} missing from hub + HubDispute artifacts`);
      const generatedTopic = viem.keccak256(viem.toHex(canonicalSignature(entry)));
      const artifactTopic = viem.keccak256(viem.toHex(canonicalSignature(artifact)));
      assert.equal(generatedTopic, artifactTopic, `topic0 mismatch for ${entry.name}`);
      assert.ok(!topics.has(generatedTopic), `duplicate topic0 for ${entry.name}`);
      topics.add(generatedTopic);
    }
  });

  it('contains the full audit event surface', () => {
    const names = new Set(hubGen.abi.filter((e) => e.type === 'event').map((e) => e.name));
    for (const name of [
      'DealFunded',
      'Delivered',
      'Settled',
      'DisputeOpened',
      'Escalated',
      'DisputeLapsed',
      'BondPosted',
      'EvidenceCommitted',
      'PhaseAdvanced',
      'RulingQueued',
      'RulingVetoed',
      'DeadlockMarked',
      'Escaped',
      'Claimed',
      'FundingPaused',
    ]) {
      assert.ok(names.has(name), `audit event ${name} missing from generated hub ABI`);
    }
  });

  it('escalate and postRespondentBond carry the 8-param ReserveAuth tail', () => {
    for (const name of ['escalate', 'postRespondentBond']) {
      const entry = hubGen.abi.find((e) => e.type === 'function' && e.name === name);
      assert.ok(entry, `${name} missing`);
      assert.equal((entry.inputs ?? []).length, 8, `${name} must take 8 inputs`);
      const tail = entry.inputs[entry.inputs.length - 1];
      assert.equal(tail.name, 'reserve');
      assert.equal(tail.type, 'tuple');
      assert.deepEqual(
        tail.components.map((c) => c.name),
        ['owner', 'sourceClaimId', 'amount', 'party', 'nonce', 'expiresAt', 'signature'],
      );
    }
  });

  it('every worker-relay function exists with matching arity', () => {
    const byName = new Map(
      hubGen.abi.filter((e) => e.type === 'function').map((e) => [e.name, e]),
    );
    for (const [name, arity] of RELAY_CALLS) {
      const entry = byName.get(name);
      assert.ok(entry, `relay function ${name} missing from generated hub ABI`);
      assert.equal((entry.inputs ?? []).length, arity, `relay function ${name} arity drift`);
    }
  });
});

describe('policies ABI matches forge artifacts', () => {
  it('bondPolicies decodes 4 fields', () => {
    const entry = policiesGen.abi.find((e) => e.type === 'function' && e.name === 'bondPolicies');
    assert.ok(entry, 'bondPolicies missing');
    assert.deepEqual(
      (entry.outputs ?? []).map((o) => o.name),
      ['exists', 'contentHash', 'claimantBond', 'respondentBond'],
    );
    const artifact = policiesArtifact.abi.find((e) => e.type === 'function' && e.name === 'bondPolicies');
    assert.equal(canonicalSignature(entry), canonicalSignature(artifact));
  });

  it('contains the reader getters used by indexers and consoles', () => {
    const names = new Set(policiesGen.abi.filter((e) => e.type === 'function').map((e) => e.name));
    for (const name of [
      'isPrimary',
      'isFallback',
      'authEpoch',
      'bondPolicies',
      'outagePolicies',
      'outageAt',
      'outages',
      'outageCount',
      'prunedBefore',
      'outageSaturated',
      'outageSeen',
      'sequencerFeed',
      'feePolicies',
      'categoryPolicies',
      'readinessPolicies',
      'evidencePolicies',
      'arbitrationPolicies',
      'catastrophicPolicies',
    ]) {
      assert.ok(names.has(name), `policies getter ${name} missing`);
    }
  });
});

describe('no hand-written ABI entries remain', () => {
  it('abi.ts re-exports generated modules without inline entries', async () => {
    const source = await readFile(ABI_TS, 'utf8');
    assert.match(source, /from "\.\/abi\/generated\/midmanHub\.js"/);
    assert.match(source, /from "\.\/abi\/generated\/midmanPolicies\.js"/);
    assert.match(source, /export const HUB_ABI/);
    assert.match(source, /export const POLICIES_ABI/);
    assert.match(source, /export const PHASE_NAMES/);
    assert.equal(
      source.match(/\btype:\s*"(function|event|error)"/g)?.length ?? 0,
      0,
      'abi.ts must not contain hand-written ABI entry literals',
    );
  });
});
