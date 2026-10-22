import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGroupCreationPlan,
  buildUserPlan,
  pairKey,
  SeededRandom,
} from './scenario.mjs';

test('builds the configured user cohort on all three nodes', () => {
  const users = buildUserPlan('check', 2, new SeededRandom(41));
  assert.equal(users.length, 6);
  assert.equal(new Set(users.map(({ address }) => address)).size, 6);
  assert.deepEqual(
    users.map(({ nodeName }) => nodeName),
    ['alpha', 'bravo', 'charlie', 'alpha', 'bravo', 'charlie'],
  );
  assert.equal(
    users.every(({ avatar }) => typeof avatar === 'boolean'),
    true,
  );
});

test('builds reproducible groups with local randomly selected owners', () => {
  const users = buildUserPlan('check', 2, new SeededRandom(41));
  const first = buildGroupCreationPlan('check', users, 2, new SeededRandom(71));
  const second = buildGroupCreationPlan(
    'check',
    users,
    2,
    new SeededRandom(71),
  );
  assert.deepEqual(first, second);
  assert.equal(first.length, 6);
  for (const group of first) {
    const owner = users.find(({ address }) => address === group.owner);
    assert.equal(owner?.nodeName, group.nodeName);
  }
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
  assert.equal(new SeededRandom(1).chance(0), false);
});
