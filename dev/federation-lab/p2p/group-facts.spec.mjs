import assert from 'node:assert/strict';
import test from 'node:test';
import { observeUserGroup } from './group-facts.mjs';

const owner = {
  address: 'owner@alpha.test',
  account: 'owner',
  domain: 'alpha.test',
  nodeName: 'alpha',
};
const friend = 'friend@bravo.test';
const group = {
  address: '!group@alpha.test',
  account: '!group',
  domain: 'alpha.test',
  name: 'Group',
};

test('derives manager targets and retractable messages from one database observation', () => {
  const projection = {
    groupId: 9,
    threadId: 19,
    roster: [
      {
        address: owner.address,
        role: 'OWNER',
        account: 'owner',
        domain: 'local',
      },
      {
        address: 'member@alpha.test',
        role: 'MEMBER',
        account: 'member',
        domain: 'local',
      },
    ],
    // A locally-created owner is authoritative in the roster even when no
    // separate relationship pair was materialized for the owner edge.
    relationships: new Map(),
    requests: [
      {
        managerAddress: owner.address,
        memberAddress: friend,
        direction: 'APPLICATION',
        requestId: '44',
        status: 'REQUESTED',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ],
    messages: [
      {
        seq: 3,
        clientMessageId: 'sent',
        creatorAddress: owner.address,
        localState: 'READY',
        isDeleted: false,
      },
    ],
  };
  const snapshot = {
    alpha: {
      node: { name: 'alpha' },
      groups: new Map([[group.address, projection]]),
      users: new Map([
        [
          friend,
          { id: 71, address: friend, account: 'friend', domain: 'bravo.test' },
        ],
      ]),
      activeP2p: new Set([`${friend}|${owner.address}`]),
    },
  };
  const facts = observeUserGroup(snapshot, owner, group);
  assert.equal(facts.memberRole, 'OWNER');
  assert.equal(facts.membershipActive, true);
  assert.deepEqual(
    facts.pendingApplications.map(({ requestId }) => requestId),
    ['44'],
  );
  assert.deepEqual(
    facts.inviteCandidates.map(({ id }) => id),
    [71],
  );
  assert.deepEqual(facts.retractableMessages, [
    { seq: 3, clientMessageId: 'sent' },
  ]);
  assert.deepEqual(
    facts.promoteCandidates.map(({ address }) => address),
    ['member@alpha.test'],
  );
});
