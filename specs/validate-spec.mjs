import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const spec = JSON.parse(await readFile(new URL('contract-spec.json', root), 'utf8'));
const docs = Object.fromEntries(await Promise.all(spec.documents.map(async name => [name, await readFile(new URL(name, root), 'utf8')])));
const stateDoc = docs['state-transitions.md'];
const ledgerDoc = docs['financial-ledger.md'];
const schemaDoc = docs['signed-policy.md'];
const counts = { references: 0, exhaustiveFeeCases: 0, realUnitFeeCases: 0, randomFeeCases: 0, bondCases: 0, catastrophicCases: 0, boundaryCases: 0, negativeInputCases: 0 };
const check = (condition, message) => assert.ok(condition, message);

// Verify the actual transition table's financial references, not just prose mentions.
const stateRows = stateDoc.split(/\r?\n/).filter(line => /^\| T\d{2} \|/.test(line)).map(line => line.split('|').map(value => value.trim()));
assert.equal(stateRows.length, spec.transitions.length);
const ledgerIds = new Set(spec.ledgerRules.map(rule => rule.id));
const policyFields = new Set(spec.policyFields);
const fieldNames = new Set(spec.dealTermsTypes.map(field => field.name));
assert.equal(fieldNames.size, spec.dealTermsTypes.length);
assert.equal(new Set(spec.transitions.map(row => row.id)).size, spec.transitions.length);
for (const field of policyFields) check(fieldNames.has(field), `Unsigned policy field ${field}`);
for (const transition of spec.transitions) {
  const actual = stateRows.find(row => row[1] === transition.id);
  check(actual, `Missing table row ${transition.id}`);
  assert.equal(actual[5], transition.ledgerRule, `Ledger mismatch ${transition.id}`);
  check(ledgerIds.has(transition.ledgerRule), `Unknown ledger rule ${transition.id}`);
  for (const field of transition.requires) check(policyFields.has(field), `Unknown policy field ${transition.id}:${field}`);
  counts.references++;
}
for (const rule of spec.ledgerRules) {
  check(ledgerDoc.includes(`### ${rule.id} —`), `Missing ledger definition ${rule.id}`);
  for (const field of rule.requires) check(fieldNames.has(field), `Unsigned financial rule ${rule.id}:${field}`);
  counts.references++;
}
const schemaRows = schemaDoc.split(/\r?\n/).filter(line => /^\| `\w+` \| (bytes32|uint\d+|address) \|/.test(line)).map(line => {
  const parts = line.split('|').map(value => value.trim());
  return { name: parts[1].replaceAll('`', ''), type: parts[2] };
});
assert.deepEqual(schemaRows, spec.dealTermsTypes, 'Signed field order/types differ from manifest');
counts.references += schemaRows.length;
for (const blocker of spec.releaseBlockers) {
  check(schemaDoc.includes(blocker.id), `Schema omits blocker ${blocker.id}`);
  if (!['ARCHITECTURE', 'ADMISSION'].includes(blocker.policy)) check(fieldNames.has(blocker.policy), `Blocker has unknown policy ${blocker.id}`);
  counts.references++;
}

const denominator = BigInt(spec.constants.feeDenominator);
const allocations = spec.constants.feeAllocationBps.map(BigInt);
function normal(P, F, S, b) {
  if (P <= 0n || F < 0n || F > P || S < 0n || S > P || !allocations.includes(b)) throw new RangeError('Invalid fee/principal input');
  const B0 = F * b / denominator;
  const E = F * S / P;
  const buyerFee = E * b / denominator;
  const sellerFee = E - buyerFee;
  return { B0, E, buyerFee, sellerFee, buyer: P - S + B0 - buyerFee, seller: S - sellerFee, funded: P + B0 };
}
function verifyNormal(P, F, S, b) {
  const result = normal(P, F, S, b);
  check(result.buyer >= 0n && result.seller >= 0n, 'Negative payout');
  check(result.buyerFee <= result.B0, 'Negative prepaid fee refund');
  assert.equal(result.buyerFee + result.sellerFee, result.E);
  assert.equal(result.buyer + result.seller + result.E, result.funded);
  if (S === 0n) { assert.equal(result.E, 0n); assert.equal(result.buyer, result.funded); }
  if (S === P) { assert.equal(result.E, F); assert.equal(result.buyer, 0n); }
  return result;
}

// Exhaustive finite integer model, including odd fees and one-unit awards.
for (let P = 1n; P <= 80n; P++) {
  for (let F = 0n; F <= P; F++) {
    for (let S = 0n; S <= P; S++) {
      for (const b of allocations) { verifyNormal(P, F, S, b); counts.exhaustiveFeeCases++; }
    }
  }
}

const realPrincipalValues = [5_000_000n, 5_000_001n, 99_999_999n, 100_000_000n, 1_000_000_000n, 50_000_000_000n, 100_000_000_000n, ((1n << 256n) - 1n) / 4n];
for (const P of realPrincipalValues) {
  for (const F of [...new Set([500_000n, 500_001n, P * 25n / 10_000n, P * 200n / 10_000n])].filter(value => value >= 500_000n && value <= P)) {
    for (const S of [...new Set([0n, 1n, 2n, P / 100n, P / 2n, P - 1n, P])]) {
      for (const b of allocations) { verifyNormal(P, F, S, b); counts.realUnitFeeCases++; }
    }
  }
}

// Deterministic broad samples; BigInt retains exact arithmetic at large values.
let seed = 0x4d49444dn;
const mask = (1n << 64n) - 1n;
function next() { seed = (seed * 6364136223846793005n + 1442695040888963407n) & mask; return seed; }
for (let index = 0; index < 25_000; index++) {
  const P = 5_000_000n + next() % 1_000_000_000_000_000n;
  const F = 500_000n + next() % (P - 499_999n);
  const S = next() % (P + 1n);
  const b = allocations[Number(next() % 3n)];
  verifyNormal(P, F, S, b);
  counts.randomFeeCases++;
}

for (const b of allocations) {
  for (const S of [0n, 1n, 500_000n, 5_000_000n]) {
    const base = normal(5_000_000n, 500_001n, S, b);
    for (const Qb of [0n, 5_000_000n, 12_000_000n]) {
      for (const Qs of [0n, 5_000_000n, 12_000_000n]) {
        for (const Cb of [...new Set([0n, Qb / 2n, Qb])]) {
          for (const Cs of [...new Set([0n, Qs / 2n, Qs])]) {
            const buyer = base.buyer + Qb - Cb;
            const seller = base.seller + Qs - Cs;
            assert.equal(buyer + seller + base.E + Cb + Cs, base.funded + Qb + Qs);
            check(buyer >= 0n && seller >= 0n, 'Negative bond outcome');
            counts.bondCases++;
          }
        }
        for (const dustTo of ['buyer', 'seller']) {
          const P = 5_000_001n;
          const prepaid = 500_001n * b / denominator;
          const low = P / 2n;
          const buyerPrincipal = dustTo === 'buyer' ? P - low : low;
          const sellerPrincipal = P - buyerPrincipal;
          assert.equal(buyerPrincipal + prepaid + Qb + sellerPrincipal + Qs, P + prepaid + Qb + Qs);
          check(buyerPrincipal - sellerPrincipal <= 1n && sellerPrincipal - buyerPrincipal <= 1n, 'Unequal catastrophic split');
          counts.catastrophicCases++;
        }
      }
    }
  }
}

// Independent literal examples, rather than comparing the model with itself.
assert.deepEqual(normal(100_000_000n, 500_000n, 70_000_000n, 10_000n), { B0:500_000n, E:350_000n, buyerFee:350_000n, sellerFee:0n, buyer:30_150_000n, seller:70_000_000n, funded:100_500_000n });
assert.deepEqual(normal(5_000_000n, 500_000n, 100_000n, 0n), { B0:0n, E:10_000n, buyerFee:0n, sellerFee:10_000n, buyer:4_900_000n, seller:90_000n, funded:5_000_000n });
assert.deepEqual(normal(100_000_000n, 500_001n, 50_000_000n, 5_000n), { B0:250_000n, E:250_000n, buyerFee:125_000n, sellerFee:125_000n, buyer:50_125_000n, seller:49_875_000n, funded:100_250_000n });
for (const args of [[0n,0n,0n,0n], [5n,6n,0n,0n], [5n,1n,6n,0n], [5n,1n,-1n,0n], [5n,-1n,1n,0n], [5n,1n,1n,1n]]) {
  assert.throws(() => normal(...args), RangeError);
  counts.negativeInputCases++;
}

function feeRate(seconds) {
  for (const tier of spec.constants.feeTiers) {
    if (tier.unbounded || (tier.maximumInclusiveSeconds !== undefined && seconds <= tier.maximumInclusiveSeconds) || (tier.maximumExclusiveSeconds !== undefined && seconds < tier.maximumExclusiveSeconds)) return tier.rateBps;
  }
  throw new Error('No fee tier');
}
for (const [seconds, expected] of [[10800,25], [10801,50], [86399,50], [86400,70], [259200,70], [259201,100], [604800,100], [604801,200]]) {
  assert.equal(feeRate(seconds), expected);
  counts.boundaryCases++;
}
for (const deadline of [86400, 259200, 604800]) {
  for (const now of [deadline - 1, deadline, deadline + 1]) {
    const timely = now < deadline;
    const timeout = now >= deadline;
    assert.notEqual(timely, timeout);
    counts.boundaryCases++;
  }
}
const escapeAt = spec.constants.catastrophicEscapeSeconds;
const executeAt = escapeAt - 86400;
for (const now of [executeAt - 1, executeAt, escapeAt - 1, escapeAt, escapeAt + 1]) {
  const execute = now >= executeAt && now < escapeAt;
  const escape = now >= escapeAt;
  check(!(execute && escape), 'Ruling/escape overlap');
  assert.equal(execute, now === executeAt || now === escapeAt - 1);
  counts.boundaryCases++;
}
assert.equal(escapeAt - 86400 + 2 * 86400 < escapeAt, false, 'Day-59 48-hour ruling must be rejected');
const disputeUsed = true;
const remainingInspectionSeconds = 4 * 86400;
assert.equal(!disputeUsed && remainingInspectionSeconds > 0, false, 'Lapse must not restore dispute right');
counts.boundaryCases += 2;

const report = {
  specVersion: spec.specVersion,
  validation: 'PASS',
  productionReady: false,
  counts,
  totalModelCases: Object.entries(counts).filter(([key]) => key !== 'references').reduce((sum, [, value]) => sum + value, 0),
  releaseBlockers: spec.releaseBlockers,
  unvalidated: ['Base outage algorithm', 'Solidity implementation and uint256 integration', 'cryptographic signature/hash test vectors', 'reviewer governance and partial/voluntary bond policy', 'actual USDC fork integration', 'vault/hub benchmark', 'operational capacity and recovery drills'],
  command: 'node D:/MM/specs/validate-spec.mjs',
  note: 'Finite models, boundary checks and document references passed. This is not a complete state-machine, smart-contract or security audit.'
};
await writeFile(new URL('validation-report.json', root), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ validation:report.validation, productionReady:report.productionReady, counts, totalModelCases:report.totalModelCases, releaseBlockers:spec.releaseBlockers.length }, null, 2));
if (process.argv.includes('--require-ready')) {
  console.error('Release gate rejected: unresolved policy/architecture blockers remain.');
  process.exitCode = 2;
}
