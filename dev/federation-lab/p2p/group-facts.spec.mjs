import assert from 'node:assert/strict';
import { groupDecisionOptions, chooseGroupAction } from './state-machine.mjs';
import { SeededRandom } from './scenario.mjs';
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
        namespaceId: 0,
      },
      {
        address: 'member@alpha.test',
        role: 'MEMBER',
        account: 'member',
        domain: 'local',
        namespaceId: 0,
      },
      {
        address: 'remote@charlie.test',
        role: 'MEMBER',
        account: 'remote',
        domain: 'charlie.test',
        namespaceId: 2,
      },
    ],
    // A locally-created owner is authoritative in the roster even when no
    // separate relationship pair was materialized for the owner edge.
    relationships: new Map(),
    requests: [
      {
        memberAddress: friend,
        direction: 'APPLICATION',
        feedId: 44,
        memberAccount: 'friend',
        memberDomain: 'bravo.test',
        memberNamespaceId: 1,
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
          {
            id: 71,
            address: friend,
            account: 'friend',
            domain: 'bravo.test',
            namespaceId: 1,
          },
        ],
      ]),
      activeP2p: new Set([`${friend}|${owner.address}`]),
    },
  };
  const facts = observeUserGroup(snapshot, owner, group);
  assert.equal(facts.memberRole, 'OWNER');
  assert.equal(facts.membershipActive, true);
  assert.deepEqual(
    facts.pendingApplications.map(({ feedId }) => feedId),
    [44],
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
  assert.deepEqual(
    facts.transferCandidates.map(({ address }) => address),
    ['member@alpha.test'],
  );
  assert.deepEqual(
    facts.kickCandidates.map(({ address }) => address),
    ['member@alpha.test', 'remote@charlie.test'],
  );
  const promotion = groupDecisionOptions(facts).find(
    ({ type }) => type === 'SET_GROUP_ADMIN',
  );
  assert.deepEqual(promotion.targets, ['member@alpha.test']);

  projection.roster = projection.roster.filter(
    ({ address }) => address !== 'member@alpha.test',
  );
  const remoteOnly = observeUserGroup(snapshot, owner, group);
  assert.deepEqual(remoteOnly.promoteCandidates, []);
  assert.equal(
    groupDecisionOptions(remoteOnly).some(
      ({ type }) => type === 'SET_GROUP_ADMIN',
    ),
    false,
  );
});

test('does not treat a stale mirrored roster row as active membership', () => {
  const member = {
    address: 'member@bravo.test',
    account: 'member',
    domain: 'bravo.test',
    nodeName: 'bravo',
  };
  const projection = {
    groupId: 9,
    threadId: 19,
    roster: [
      {
        address: member.address,
        role: 'MEMBER',
        account: 'member',
        domain: 'local',
      },
    ],
    relationships: new Map([
      [
        member.address,
        {
          active: false,
          groupIntent: 'REVOKED',
          userIntent: 'ACCEPTED',
        },
      ],
    ]),
    requests: [],
    messages: [
      {
        seq: 3,
        clientMessageId: 'sent-before-kick',
        creatorAddress: member.address,
        localState: 'READY',
        isDeleted: false,
      },
    ],
  };
  const snapshot = {
    bravo: {
      node: { name: 'bravo' },
      groups: new Map([[group.address, projection]]),
      users: new Map(),
      activeP2p: new Set(),
    },
  };

  const facts = observeUserGroup(snapshot, member, group);

  assert.equal(facts.memberRole, null);
  assert.equal(facts.membershipActive, false);
  assert.deepEqual(
    groupDecisionOptions(facts).map(({ type }) => type),
    ['REQUEST_GROUP_JOIN'],
  );
  assert.equal(
    chooseGroupAction(facts, new SeededRandom(31)).type,
    'REQUEST_GROUP_JOIN',
  );
});
