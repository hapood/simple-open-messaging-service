import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUserPlan, pairKey, SeededRandom } from './scenario.mjs';

test('builds the configured user cohort on all three nodes', () => {
  const users = buildUserPlan('check', 2);
  assert.equal(users.length, 6);
  assert.equal(new Set(users.map(({ address }) => address)).size, 6);
  assert.deepEqual(
    users.map(({ nodeName }) => nodeName),
    ['alpha', 'bravo', 'charlie', 'alpha', 'bravo', 'charlie'],
  );
});

test('seeded choices are reproducible without defining business transitions', () => {
  const first = new SeededRandom(123456);
  const second = new SeededRandom(123456);
  assert.deepEqual(
    Array.from({ length: 20 }, () => first.integer(1000)),
    Array.from({ length: 20 }, () => second.integer(1000)),
  );
  assert.equal(
    pairKey('bob@bravo.test', 'alice@alpha.test'),
    'alice@alpha.test|bob@bravo.test',
  );
});
