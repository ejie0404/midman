// Canonical ABI exporter for @midman/chain — READ ONLY w.r.t. contracts.
//
// Derives the hub + policies ABIs from forge artifacts and writes them to
// packages/chain/src/abi/generated/ as JSON envelopes plus TS modules that
// packages/chain/src/abi.ts re-exports. No hand-written ABI entries remain
// in the chain package after this.
//
// PREREQUISITE: artifacts must be built first. From packages/contracts run:
//   forge build
// (solc 0.8.26 via-IR per foundry.toml). This script never invokes forge and
// never writes outside packages/chain/src/abi/generated/.
//
// WHY HubDispute is merged: the dispute machine executes via DELEGATECALL in
// hub context, so its events/errors are emitted from the HUB address, but
// solc only lists them in the HubDispute library artifact. Only events and
// errors are merged (library functions take storage-struct pointers and are
// not part of the hub's external surface). On name conflicts the hub entry
// wins after verifying identical canonical signatures.
//
// Usage:
//   node scripts/export-abi.mjs
//
// Regeneration contract (checked by scripts/export-abi.test.mjs):
//   - escalate / postRespondentBond carry 8 inputs ending in the ReserveAuth
//     tuple (owner, sourceClaimId, amount, party, nonce, expiresAt, signature)
//   - bondPolicies returns 4 fields (exists, contentHash, claimantBond,
//     respondentBond)
//   - the full hub event surface is present (DealFunded, Delivered, Settled,
//     DisputeOpened, Escalated, DisputeLapsed, BondPosted, EvidenceCommitted,
//     PhaseAdvanced, RulingQueued, RulingVetoed, DeadlockMarked, Escaped,
//     Claimed, FundingPaused, ...)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const HUB_ARTIFACT = 'packages/contracts/out/MidmanHub.sol/MidmanHub.json';
const DISPUTE_LIB_ARTIFACT = 'packages/contracts/out/HubDispute.sol/HubDispute.json';
const POLICIES_ARTIFACT = 'packages/contracts/out/MidmanPolicies.sol/MidmanPolicies.json';
const OUT_DIR = 'packages/chain/src/abi/generated';

const RESERVE_AUTH_COMPONENTS = [
  'owner',
  'sourceClaimId',
  'amount',
  'party',
  'nonce',
  'expiresAt',
  'signature',
];

const REQUIRED_HUB_EVENTS = [
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
];

const REQUIRED_POLICIES_FUNCTIONS = [
  'isPrimary',
  'isFallback',
  'authEpoch',
  'bondPolicies',
  'outagePolicies',
  'outageRecent',
  'outages',
  'outageRetained',
  'outageCount',
  'outageTotal',
  'sequencerFeed',
  'feePolicies',
  'categoryPolicies',
  'readinessPolicies',
  'evidencePolicies',
  'arbitrationPolicies',
  'catastrophicPolicies',
  'governance',
  'pauser',
  'admissionSigner',
  'treasury',
];

function fail(message) {
  throw new Error(`export-abi: ${message}`);
}

async function loadArtifact(relPath) {
  const absPath = path.join(REPO_ROOT, relPath);
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch {
    fail(
      `missing artifact ${relPath}. Build it first: run \`forge build\` in packages/contracts, then re-run this script.`,
    );
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.abi)) fail(`artifact ${relPath} has no .abi array`);
  return parsed;
}

function solcVersion(artifact, relPath) {
  // Forge artifacts carry the full solc metadata; prefer its compiler stamp.
  const metadata = artifact.metadata;
  if (metadata && metadata.compiler && typeof metadata.compiler.version === 'string') {
    return metadata.compiler.version;
  }
  if (typeof artifact.rawMetadata === 'string') {
    try {
      const raw = JSON.parse(artifact.rawMetadata);
      if (raw && raw.compiler && typeof raw.compiler.version === 'string') return raw.compiler.version;
    } catch {
      // fall through to the failure below
    }
  }
  fail(`artifact ${relPath} carries no solc compiler version; rebuild with \`forge build\``);
}

// Canonical signature helpers (dedupe + structural checks).
function canonicalType(param) {
  const { type, components } = param;
  if (typeof type !== 'string') fail(`ABI param without type: ${JSON.stringify(param)}`);
  if (!type.startsWith('tuple')) return type;
  if (!Array.isArray(components)) fail(`tuple param without components: ${JSON.stringify(param)}`);
  const suffix = type.slice('tuple'.length); // e.g. "", "[]", "[3]"
  return `(${components.map(canonicalType).join(',')})${suffix}`;
}

function canonicalSignature(entry) {
  const params = entry.type === 'function' || entry.type === 'event' ? entry.inputs ?? [] : entry.inputs ?? [];
  return `${entry.name}(${params.map(canonicalType).join(',')})`;
}

function mergeLibrarySurface(hubAbi, libAbi) {
  // Merge only events + errors; library functions are not hub-callable.
  const seen = new Map(hubAbi.map((entry) => [`${entry.type}:${entry.name}`, entry]));
  const merged = [...hubAbi];
  for (const entry of libAbi) {
    if (entry.type !== 'event' && entry.type !== 'error') continue;
    const key = `${entry.type}:${entry.name}`;
    const existing = seen.get(key);
    if (!existing) {
      merged.push(entry);
      seen.set(key, entry);
      continue;
    }
    if (canonicalSignature(existing) !== canonicalSignature(entry)) {
      fail(`conflicting ${entry.type} ${entry.name} between hub and HubDispute artifacts`);
    }
  }
  return merged;
}

function requireFunction(abi, name, context) {
  const entry = abi.find((e) => e.type === 'function' && e.name === name);
  if (!entry) fail(`${context}: function ${name} missing from artifact ABI`);
  return entry;
}

function assertReserveAuthTail(entry) {
  const inputs = entry.inputs ?? [];
  if (inputs.length !== 8) {
    fail(`${entry.name}: expected 8 inputs (incl. ReserveAuth), found ${inputs.length}`);
  }
  const tail = inputs[inputs.length - 1];
  if (tail.name !== 'reserve' || tail.type !== 'tuple' || !Array.isArray(tail.components)) {
    fail(`${entry.name}: last input must be the ReserveAuth tuple, found ${JSON.stringify(tail)}`);
  }
  const names = tail.components.map((c) => c.name);
  if (JSON.stringify(names) !== JSON.stringify(RESERVE_AUTH_COMPONENTS)) {
    fail(`${entry.name}: ReserveAuth components mismatch: ${names.join(',')}`);
  }
}

function assertHubShape(hubAbi) {
  assertReserveAuthTail(requireFunction(hubAbi, 'escalate', 'hub'));
  assertReserveAuthTail(requireFunction(hubAbi, 'postRespondentBond', 'hub'));
  const events = new Set(hubAbi.filter((e) => e.type === 'event').map((e) => e.name));
  for (const name of REQUIRED_HUB_EVENTS) {
    if (!events.has(name)) fail(`hub: required event ${name} missing after HubDispute merge`);
  }
}

function assertPoliciesShape(policiesAbi) {
  const bond = requireFunction(policiesAbi, 'bondPolicies', 'policies');
  const outputs = (bond.outputs ?? []).map((o) => o.name);
  const expected = ['exists', 'contentHash', 'claimantBond', 'respondentBond'];
  if (JSON.stringify(outputs) !== JSON.stringify(expected)) {
    fail(`policies: bondPolicies must return 4 fields (${expected.join(',')}), found ${outputs.join(',')}`);
  }
  const fns = new Set(policiesAbi.filter((e) => e.type === 'function').map((e) => e.name));
  for (const name of REQUIRED_POLICIES_FUNCTIONS) {
    if (!fns.has(name)) fail(`policies: required getter ${name} missing from artifact ABI`);
  }
}

function countBy(abi, type) {
  return abi.filter((e) => e.type === type).length;
}

function tsModule(contract, constName, artifactRel, abi) {
  // Precise `as const` (NOT `: Abi`): downstream readers rely on viem's
  // narrow-ABI inference (e.g. decodeEventLog eventName narrowing), exactly
  // as they did with the previous hand-written `as const` arrays. Broad
  // `Abi` typing would break packages/chain/src/reader.ts, which must stay
  // untouched. A side effect is intended: worker relay calls that still pass
  // 7 args to escalate/postRespondentBond now fail typecheck until they add
  // the ReserveAuth tuple (reported downstream bug, not fixed here).
  return (
    `// @generated by scripts/export-abi.mjs from ${artifactRel} — DO NOT EDIT.\n` +
    `// Regenerate with \`node scripts/export-abi.mjs\` (after \`forge build\` in packages/contracts).\n` +
    `\n` +
    `export const ${constName} = ${JSON.stringify(abi, null, 2)} as const;\n`
  );
}

async function main() {
  const hub = await loadArtifact(HUB_ARTIFACT);
  const disputeLib = await loadArtifact(DISPUTE_LIB_ARTIFACT);
  const policies = await loadArtifact(POLICIES_ARTIFACT);

  const hubAbi = mergeLibrarySurface(hub.abi, disputeLib.abi);
  const policiesAbi = policies.abi;
  assertHubShape(hubAbi);
  assertPoliciesShape(policiesAbi);

  const generatedAt = new Date().toISOString();
  const hubSolc = solcVersion(hub, HUB_ARTIFACT);
  const policiesSolc = solcVersion(policies, POLICIES_ARTIFACT);

  const outDir = path.join(REPO_ROOT, OUT_DIR);
  await mkdir(outDir, { recursive: true });

  const hubEnvelope = {
    contract: 'MidmanHub',
    source: 'forge-artifact',
    artifact: HUB_ARTIFACT,
    libraryArtifact: DISPUTE_LIB_ARTIFACT,
    solc: hubSolc,
    generatedAt,
    abi: hubAbi,
  };
  const policiesEnvelope = {
    contract: 'MidmanPolicies',
    source: 'forge-artifact',
    artifact: POLICIES_ARTIFACT,
    solc: policiesSolc,
    generatedAt,
    abi: policiesAbi,
  };

  await writeFile(path.join(outDir, 'midmanHub.json'), `${JSON.stringify(hubEnvelope, null, 2)}\n`);
  await writeFile(path.join(outDir, 'midmanPolicies.json'), `${JSON.stringify(policiesEnvelope, null, 2)}\n`);
  // TS modules exist because the chain tsconfig does not enable
  // resolveJsonModule (which must stay untouched); abi.ts imports these.
  // They are precise `as const` (not `: Abi`) so viem's narrow-ABI inference
  // keeps working for downstream readers exactly as before.
  await writeFile(path.join(outDir, 'midmanHub.ts'), tsModule('MidmanHub', 'MIDMAN_HUB_ABI', HUB_ARTIFACT, hubAbi));
  await writeFile(
    path.join(outDir, 'midmanPolicies.ts'),
    tsModule('MidmanPolicies', 'MIDMAN_POLICIES_ABI', POLICIES_ARTIFACT, policiesAbi),
  );

  for (const [label, abi] of [
    ['MidmanHub (+HubDispute events/errors)', hubAbi],
    ['MidmanPolicies', policiesAbi],
  ]) {
    // eslint-disable-next-line no-console
    console.log(
      `${label}: ${countBy(abi, 'function')} functions, ${countBy(abi, 'event')} events, ${countBy(abi, 'error')} errors`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUT_DIR}/{midmanHub,midmanPolicies}.{json,ts}`);
}

await main();
