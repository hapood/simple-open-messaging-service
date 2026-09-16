import assert from 'node:assert/strict';
import test from 'node:test';
import { admitOperation } from './operations.mjs';

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
        domain: 'bravo.test',
        address: 'friend@bravo.test',
      },
    },
    { user: () => actor },
    1000,
  );
  assert.deepEqual(requests, [
    {
      endpoint: '/group/invite',
      body: {
        groupId: 2,
        users: [{ account: 'friend', domain: 'bravo.test' }],
      },
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
      },
    },
    { user: () => actor },
    1000,
  );
  assert.deepEqual(requests, [
    {
      endpoint: '/group/join-request/reject',
      body: { groupId: 2, account: 'friend', domain: 'bravo.test' },
    },
  ]);
});
