import assert from 'node:assert/strict';
import test from 'node:test';
import { admitOperation } from './operations.mjs';

const fakeAdmin = {
  peerNamespaceId: async () => 1,
};

function actors(actor) {
  return {
    user: () => actor,
    node: () => ({ name: 'charlie', admin: fakeAdmin }),
  };
}

test('group invitations submit public addresses even when a snapshot contains a different mirror user id', async () => {
  const requests = [];
  const actor = {
    node: { name: 'charlie', domain: 'charlie.test' },
    async post(endpoint, body) {
      requests.push({ endpoint, body });
      return {
        invited: [{ account: 'friend', domain: 'bravo.test' }],
        skipped: [],
      };
    },
  };
  await admitOperation(
    {
      id: 'op-503',
      type: 'INVITE_GROUP_MEMBER',
      actor: 'owner@charlie.test',
      group: '!group@charlie.test',
      groupThreadId: 2,
      observedFacts: { group: { account: '!group', domain: 'charlie.test' } },
      target: {
        id: 76,
        account: 'friend',
        namespaceId: 1,
        address: 'friend@bravo.test',
      },
    },
    actors(actor),
    1000,
  );
  assert.deepEqual(requests, [
    {
      endpoint: '/group/invite',
      body: {
        groupId: 2,
        users: [{ account: 'friend', namespaceId: 1 }],
      },
    },
  ]);
});

test('group invitation acceptance uses the member-authored group endpoint', async () => {
  const requests = [];
  const actor = {
    node: { name: 'bravo', domain: 'bravo.test' },
    async post(endpoint, body) {
      requests.push({ endpoint, body });
      return { taskId: 'task-1' };
    },
  };
  await admitOperation(
    {
      id: 'op-505',
      type: 'ACCEPT_GROUP_INVITATION',
      actor: 'friend@bravo.test',
      group: '!group@charlie.test',
      groupThreadId: 9,
    },
    actors(actor),
    1000,
  );
  assert.deepEqual(requests, [
    {
      endpoint: '/group/join-request',
      body: { groupId: 9 },
    },
  ]);
});

test('group request decisions submit the projection member address', async () => {
  const requests = [];
  const actor = {
    node: { name: 'charlie', domain: 'charlie.test' },
    async post(endpoint, body) {
      requests.push({ endpoint, body });
      return { status: 'APPLIED' };
    },
  };
  await admitOperation(
    {
      id: 'op-504',
      type: 'REJECT_GROUP_APPLICATION',
      actor: 'owner@charlie.test',
      group: '!group@charlie.test',
      groupThreadId: 2,
      observedFacts: { group: { account: '!group', domain: 'charlie.test' } },
      target: {
        direction: 'APPLICATION',
        feedId: 7,
        memberAddress: 'friend@bravo.test',
        memberAccount: 'friend',
        memberDomain: 'bravo.test',
        memberNamespaceId: 1,
      },
    },
    actors(actor),
    1000,
  );
  assert.deepEqual(requests, [
    {
      endpoint: '/group/join-request/reject',
      body: { groupId: 2, account: 'friend', namespaceId: 1 },
    },
  ]);
});
