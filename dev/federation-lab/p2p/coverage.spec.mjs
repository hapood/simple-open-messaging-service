import assert from 'node:assert/strict';
import test from 'node:test';
import { recordMembershipCoverage, summarizeCoverage } from './coverage.mjs';

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
