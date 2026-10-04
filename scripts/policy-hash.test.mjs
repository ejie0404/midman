import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  POLICY_IDS,
  canonicalize,
  hashAll,
  loadPolicyRecords,
  policyContentHash,
} from './policy-hash.mjs';

const baseRecord = {
  id: 'fee-v1',
  version: 1,
  description: 'fixture',
  values: { a: '1', b: { d: '2', c: '3' } },
  sourceRefs: ['s1', 's2'],
};

const reorderedRecord = {
  sourceRefs: ['s1', 's2'],
  values: { b: { c: '3', d: '2' }, a: '1' },
  description: 'fixture',
  version: 1,
  id: 'fee-v1',
};

describe('canonical serializer', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    assert.equal(
      canonicalize(baseRecord),
      '{"description":"fixture","id":"fee-v1","sourceRefs":["s1","s2"],"values":{"a":"1","b":{"c":"3","d":"2"}},"version":1}',
    );
  });

  it('renders integers exactly and rejects unsafe numbers', () => {
    assert.equal(canonicalize({ n: 25 }), '{"n":25}');
    assert.throws(() => canonicalize({ n: 1.5 }), TypeError);
    assert.throws(() => canonicalize({ n: Number.MAX_SAFE_INTEGER + 1 }), TypeError);
  });
});

describe('policy content hashing', () => {
  it('is deterministic for the same record', () => {
    assert.equal(policyContentHash(baseRecord), policyContentHash({ ...baseRecord }));
  });

  it('is invariant under key reordering (top level and nested)', () => {
    assert.equal(policyContentHash(baseRecord), policyContentHash(reorderedRecord));
  });

  it('changes when any value changes', () => {
    const changed = { ...baseRecord, values: { ...baseRecord.values, a: '2' } };
    assert.notEqual(policyContentHash(baseRecord), policyContentHash(changed));
  });

  it('changes when the identity changes', () => {
    const changed = { ...baseRecord, id: 'bond-v1' };
    assert.notEqual(policyContentHash(baseRecord), policyContentHash(changed));
  });
});

describe('deploy/policies records', () => {
  it('loads all 8 canonical records with unique expected ids and version 1', async () => {
    const records = await loadPolicyRecords();
    assert.equal(records.length, POLICY_IDS.length);
    assert.deepEqual(records.map((entry) => entry.id).sort(), [...POLICY_IDS].sort());
    for (const { record } of records) assert.equal(record.version, 1);
  });

  it('hashes every record to 0x + 64 hex characters', async () => {
    const hashes = await hashAll();
    assert.equal(Object.keys(hashes).length, POLICY_IDS.length);
    for (const id of POLICY_IDS) assert.match(hashes[id], /^0x[0-9a-f]{64}$/);
  });

  it('hashAll agrees with per-record recomputation', async () => {
    const records = await loadPolicyRecords();
    const hashes = await hashAll();
    for (const { id, record } of records) {
      assert.equal(hashes[id], policyContentHash(record));
    }
  });
});
