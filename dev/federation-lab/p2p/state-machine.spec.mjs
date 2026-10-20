import assert from 'node:assert/strict';
import test from 'node:test';
import { SeededRandom } from './scenario.mjs';
import {
  chooseGroupAction,
  groupIntentActionOptions,
  groupMutationCategories,
  p2pActionOptions,
} from './state-machine.mjs';

function groupFacts(overrides = {}) {
  return {
    user: { address: 'alice@alpha.test', domain: 'alpha.test' },
    group: { address: '!group@bravo.test', domain: 'bravo.test' },
    memberRole: null,
    membershipActive: false,
    groupIntent: null,
    userIntent: null,
    inviteCandidates: [],
    pendingApplications: [],
    pendingInvitations: [],
    kickCandidates: [],
    promoteCandidates: [],
    demoteCandidates: [],
    transferCandidates: [],
    retractableMessages: [],
    ...overrides,
  };
}

test('separates pending request withdrawal from established relationship revocation', () => {
  assert.deepEqual(p2pActionOptions({ state: 'OUTGOING_PENDING' }), [
    { type: 'WITHDRAW_REQUEST' },
  ]);
  assert.deepEqual(p2pActionOptions({ state: 'NONE' }), [
    { type: 'SEND_REQUEST' },
  ]);
  assert.equal(
    p2pActionOptions({ state: 'FRIEND' })[0].type,
    'REVOKE_RELATIONSHIP',
  );
  assert.deepEqual(
    p2pActionOptions({ state: 'INCOMING_PENDING' }).map(({ type }) => type),
    ['ACCEPT_REQUEST', 'REVERSE_REQUEST', 'REJECT_REQUEST'],
  );
});

test('derives group intent operations from directed facts', () => {
  assert.deepEqual(
    groupIntentActionOptions(groupFacts({ groupIntent: 'REQUESTED' })).map(
      ({ type }) => type,
    ),
    ['ACCEPT_GROUP_INVITATION'],
  );
  assert.deepEqual(
    groupIntentActionOptions(groupFacts({ userIntent: 'REQUESTED' })),
    [{ type: 'REVOKE_GROUP_APPLICATION' }],
  );
  assert.deepEqual(groupIntentActionOptions(groupFacts()), [
    { type: 'REQUEST_GROUP_JOIN' },
  ]);
  assert.deepEqual(
    groupIntentActionOptions(groupFacts({ membershipActive: true })),
    [],
  );
  assert.deepEqual(
    groupIntentActionOptions(
      groupFacts({ group: { address: '!g@alpha.test', domain: 'alpha.test' } }),
    ),
    [],
  );
});

test('never exposes management to a normal member or leave to an owner', () => {
  assert.deepEqual(
    groupMutationCategories(groupFacts({ memberRole: 'MEMBER' })),
    [{ type: 'LEAVE_GROUP' }],
  );
  const owner = groupMutationCategories(
    groupFacts({
      memberRole: 'OWNER',
      inviteCandidates: [{ address: 'bob@bravo.test' }],
      transferCandidates: [{ address: 'carol@alpha.test' }],
    }),
  );
  assert.equal(
    owner.some(({ type }) => type === 'LEAVE_GROUP'),
    false,
  );
  assert.equal(
    owner.some(({ type }) => type === 'INVITE_GROUP_MEMBER'),
    true,
  );
  assert.equal(
    owner.some(({ type }) => type === 'TRANSFER_GROUP_OWNERSHIP'),
    true,
  );
});

test('falls back to sending when the selected owner has no legal mutation', () => {
  const facts = groupFacts({ memberRole: 'OWNER' });
  for (let seed = 1; seed <= 100; seed += 1) {
    assert.match(
      chooseGroupAction(facts, new SeededRandom(seed)).type,
      /^SEND_(GROUP_MESSAGE|FILE|GALLERY)$/,
    );
  }
});

test('withdraw is selected only when the author has a retractable message', () => {
  const without = groupFacts({ memberRole: 'MEMBER' });
  for (let seed = 1; seed <= 500; seed += 1) {
    assert.notEqual(
      chooseGroupAction(without, new SeededRandom(seed)).type,
      'WITHDRAW_GROUP_MESSAGE',
    );
  }
  const withMessage = groupFacts({
    memberRole: 'MEMBER',
    retractableMessages: [{ seq: 7, clientMessageId: 'sent' }],
  });
  assert.equal(
    Array.from({ length: 500 }, (_, index) =>
      chooseGroupAction(withMessage, new SeededRandom(index + 1)),
    ).some(({ type }) => type === 'WITHDRAW_GROUP_MESSAGE'),
    true,
  );
});

test('implements the hierarchical 90/10, 5% retract, and 5% media weights', () => {
  const random = new SeededRandom(93841);
  const facts = groupFacts({
    memberRole: 'MEMBER',
    retractableMessages: [{ seq: 7, clientMessageId: 'sent' }],
  });
  const counts = {};
  const samples = 100_000;
  for (let index = 0; index < samples; index += 1) {
    const type = chooseGroupAction(facts, random).type;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const ratio = (type) => (counts[type] ?? 0) / samples;
  assert.ok(Math.abs(ratio('LEAVE_GROUP') - 0.1) < 0.01);
  assert.ok(Math.abs(ratio('WITHDRAW_GROUP_MESSAGE') - 0.045) < 0.01);
  assert.ok(
    Math.abs(ratio('SEND_FILE') + ratio('SEND_GALLERY') - 0.04275) < 0.01,
  );
});
