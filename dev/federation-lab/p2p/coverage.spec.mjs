import assert from 'node:assert/strict';
import test from 'node:test';
import { recordMembershipCoverage, summarizeCoverage } from './coverage.mjs';

test('reports mandatory relay coverage separately from the random operation budget', () => {
  const forwardRelayScenario = {
    status: 'SUCCEEDED',
    cases: [{ variant: 'DIRECT' }],
  };
  const coverage = summarizeCoverage({
    users: [],
    groups: [],
    operations: [],
    randomOperations: 600,
    forwardRelayScenario,
  });
  assert.equal(coverage.randomOperations, 600);
  assert.equal(coverage.logicalOperations, 0);
  assert.deepEqual(coverage.forwardRelay, forwardRelayScenario);
  assert.equal(
    summarizeCoverage({ users: [], groups: [], operations: [] }).forwardRelay
      .status,
    'NOT_COVERED',
  );
});

test('counts friendship re-establishment across converged checkpoints without counting repeated samples', () => {
  const log = { users: [], groups: [], operations: [] };
  for (const active of [true, true, false, false, true, true]) {
    recordMembershipCoverage(
      log,
      {},
      {
        alpha: {
          pairs: { active: active ? ['alice@alpha.test|bob@bravo.test'] : [] },
        },
      },
    );
  }
  assert.equal(summarizeCoverage(log).reestablishedFriendships, 1);
});
