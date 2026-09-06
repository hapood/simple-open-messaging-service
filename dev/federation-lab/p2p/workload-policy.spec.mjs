import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGroupCreationPlan,
  buildUserPlan,
  SeededRandom,
} from './scenario.mjs';
import { weightedPick, groupCandidateWeight } from './workload-policy.mjs';
import { chooseGroupAction } from './state-machine.mjs';

test('reserves exactly two active groups with distinct seeded owners at every supported baseline size', () => {
  for (const groupsPerNode of [1, 5])
    for (let seed = 1; seed <= 50; seed += 1) {
      const users = buildUserPlan('check', 5, new SeededRandom(seed));
      const groups = buildGroupCreationPlan(
        'check',
        users,
        groupsPerNode,
        new SeededRandom(seed),
      );
      const active = groups.filter((group) => group.active);
      assert.equal(active.length, 2);
      assert.equal(new Set(active.map(({ owner }) => owner)).size, 2);
      assert.equal(groups.length, groupsPerNode * 3);
    }
});

test('weights active groups and former members without excluding ordinary groups', () => {
  const ordinary = { group: {}, memberRole: null, pendingApplications: [] };
  const active = { ...ordinary, group: { active: true } };
  assert.ok(groupCandidateWeight(active) > groupCandidateWeight(ordinary));
  assert.ok(
    groupCandidateWeight({ ...active, previouslyLeft: true }) >
      groupCandidateWeight(active),
  );
  const random = new SeededRandom(2192);
  const samples = Array.from({ length: 10000 }, () =>
    weightedPick(random, [ordinary, active], groupCandidateWeight),
  );
  const activeCount = samples.filter((value) => value === active).length;
  assert.ok(activeCount > 8000 && activeCount < 9500);
});

test('a dissolved group offers no action even with a retained owner roster', () => {
  assert.equal(
    chooseGroupAction(
      { group: { dissolved: true }, memberRole: 'OWNER' },
      new SeededRandom(11),
    ),
    undefined,
  );
});
