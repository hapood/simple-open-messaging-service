import assert from 'node:assert/strict';
import test from 'node:test';
import { compareFinalP2pFriends, normalizeNodePairRows } from './audit.mjs';

const users = ['alice@alpha.test', 'amy@alpha.test', 'bob@bravo.test'];
const crossPair = 'alice@alpha.test|bob@bravo.test';

function row(id, left, right, active) {
  return {
    id,
    endpointatype: 'USER',
    endpointaaccount: left.account,
    endpointadomain: left.domain,
    endpointbtype: 'USER',
    endpointbaccount: right.account,
    endpointbdomain: right.domain,
    active,
  };
}

function nodeSnapshot({
  all = [],
  active = [],
  duplicates = [],
  invalid = [],
} = {}) {
  return { all, active, duplicates, invalid };
}

function snapshot({ alpha: alphaValue, bravo, charlie } = {}) {
  return {
    alpha: nodeSnapshot(alphaValue),
    bravo: nodeSnapshot(bravo),
    charlie: nodeSnapshot(charlie),
  };
}

test('normalizes namespace domains and scopes rows to the run cohort', () => {
  const normalized = normalizeNodePairRows(
    [
      row(
        '1',
        { account: 'alice', domain: 'alpha.test' },
        { account: 'bob', domain: 'bravo.test' },
        true,
      ),
      row(
        '2',
        { account: 'alice', domain: 'alpha.test' },
        { account: 'amy', domain: 'alpha.test' },
        false,
      ),
      row(
        '3',
        { account: 'alice', domain: 'alpha.test' },
        { account: 'outside', domain: 'bravo.test' },
        true,
      ),
    ],
    users,
  );

  assert.deepEqual(normalized.all, [
    'alice@alpha.test|amy@alpha.test',
    crossPair,
  ]);
  assert.deepEqual(normalized.active, [crossPair]);
});

test('accepts a final cross-node friendship active on both endpoint nodes', () => {
  const result = compareFinalP2pFriends(
    snapshot({
      alpha: { all: [crossPair], active: [crossPair] },
      bravo: { all: [crossPair], active: [crossPair] },
    }),
    users,
  );

  assert.equal(result.passed, true);
  assert.equal(result.finalFriends, 1);
  assert.deepEqual(result.mismatches, []);
});

test('rejects a final friendship active on only one endpoint node', () => {
  const result = compareFinalP2pFriends(
    snapshot({
      alpha: { all: [crossPair], active: [crossPair] },
      bravo: { all: [crossPair], active: [] },
    }),
    users,
  );

  assert.equal(result.passed, false);
  assert.deepEqual(result.mismatches, [
    {
      pair: crossPair,
      leftNode: 'alpha',
      leftActive: true,
      rightNode: 'bravo',
      rightActive: false,
    },
  ]);
});

test('ignores inactive row existence because history is outside this audit', () => {
  const result = compareFinalP2pFriends(
    snapshot({
      alpha: { all: [crossPair], active: [] },
      bravo: { all: [], active: [] },
    }),
    users,
  );

  assert.equal(result.passed, true);
  assert.equal(result.finalFriends, 0);
});

test('rejects duplicate, invalid, and misplaced active relationship rows', () => {
  const result = compareFinalP2pFriends(
    snapshot({
      alpha: { duplicates: [{ pair: crossPair, id: '2' }] },
      bravo: { invalid: [{ id: '3', reason: 'invalid' }] },
      charlie: { all: [crossPair], active: [crossPair] },
    }),
    users,
  );

  assert.equal(result.passed, false);
  assert.equal(result.nodes.alpha.duplicates.length, 1);
  assert.equal(result.nodes.bravo.invalid.length, 1);
  assert.deepEqual(result.nodes.charlie.misplacedActive, [crossPair]);
});
