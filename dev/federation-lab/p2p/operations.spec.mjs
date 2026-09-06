import assert from 'node:assert/strict';
import test from 'node:test';
import { admitOperation } from './operations.mjs';

test('group invitations submit public addresses even when a snapshot contains a different mirror user id', async () => {
  const requests = [];
  const actor = {
    node: { name: 'charlie', domain: 'charlie.test' },
    async post(endpoint, body) {
      requests.push({ endpoint, body });
      return { tasks: [{ taskId: '1', status: 'PENDING' }], skipped: [] };
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
