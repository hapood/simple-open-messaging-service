import assert from 'node:assert/strict';
import test from 'node:test';
import { admitOperation } from './operations.mjs';

const fakeAdmin = {
  peerNamespaceId: async () => 1,
};

function actors(actor, extras = {}) {
  return {
    user: (address) => {
      if (typeof actor === 'function') return actor(address);
      if (extras[address]) return extras[address];
      return actor;
    },
    node: () => ({ name: 'charlie', admin: fakeAdmin }),
  };
}

test('group invitations submit snapshot and address for each target', async () => {
  const requests = [];
  const actor = {
    address: 'owner@charlie.test',
    node: { name: 'charlie', domain: 'charlie.test' },
    async post(endpoint, body) {
      requests.push({ endpoint, body });
      return {
        invited: [{ account: 'friend', domain: 'bravo.test' }],
        skipped: [],
      };
    },
  };
  const friendUser = {
    address: 'friend@bravo.test',
    myProfile: async () => ({ name: 'Friend', avatar: '/uploads/friend.webp' }),
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
    actors(actor, { 'friend@bravo.test': friendUser }),
    1000,
  );
  assert.deepEqual(requests, [
    {
      endpoint: '/group/invite',
      body: {
        groupId: 2,
        users: [
          {
            account: 'friend',
            namespaceId: 1,
            snapshot: {
              displayName: 'Friend',
              avatar: '/uploads/friend.webp',
            },
          },
        ],
      },
    },
  ]);
});

test('group invitation acceptance sends exact observed groupRequestId', async () => {
  const requests = [];
  const actor = {
    address: 'friend@bravo.test',
    node: { name: 'bravo', domain: 'bravo.test' },
    async post(endpoint, body) {
      requests.push({ endpoint, body });
      return { status: 'OK', threadId: 9 };
    },
  };
  const result = await admitOperation(
    {
      id: 'op-505',
      type: 'ACCEPT_GROUP_INVITATION',
      actor: 'friend@bravo.test',
      group: '!group@charlie.test',
      groupThreadId: 9,
      observedFacts: {
        groupRequestId: '9223372036854775806',
      },
    },
    actors(actor),
    1000,
  );
  assert.deepEqual(requests, [
    {
      endpoint: '/group/join-request',
      body: { requestId: '9223372036854775806' },
    },
  ]);
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(result.result, { status: 'OK', threadId: 9 });
});

const managerOperation = {
  id: 'op-504',
  type: 'REJECT_GROUP_APPLICATION',
  actor: 'owner@charlie.test',
  group: '!group@charlie.test',
  groupThreadId: 2,
  target: { requestId: '9223372036854775807' },
};

for (const [type, endpoint] of [
  ['ACCEPT_GROUP_APPLICATION', '/group/join-request/accept'],
  ['REJECT_GROUP_APPLICATION', '/group/join-request/reject'],
  ['REVOKE_GROUP_INVITATION', '/group/invitation/revoke'],
]) {
  test(`${type} sends only the group and exact observed bigint request ID`, async () => {
    const requests = [];
    const actor = {
      address: managerOperation.actor,
      node: { name: 'charlie', domain: 'charlie.test' },
      async post(endpoint, body) {
        requests.push({ endpoint, body });
        return { status: 'OK', threadId: 2 };
      },
    };
    const result = await admitOperation(
      { ...managerOperation, type },
      actors(actor),
      1000,
    );
    assert.deepEqual(requests, [
      { endpoint, body: { groupId: 2, requestId: '9223372036854775807' } },
    ]);
    assert.equal(result.status, 'SUCCEEDED');
    assert.deepEqual(result.result, { status: 'OK', threadId: 2 });
    assert.deepEqual(result.target, managerOperation.target);
  });
}

test('manager decisions reject missing, numeric, malformed or out-of-range IDs without address/feed fallback', async () => {
  let sent = 0;
  const actor = {
    node: { name: 'charlie', domain: 'charlie.test' },
    async post() {
      sent++;
      throw new Error('must not submit an invalid ID');
    },
  };
  for (const requestId of [
    undefined,
    9007199254740992,
    '0',
    '01',
    '-1',
    '1e3',
    '9223372036854775808',
  ]) {
    await assert.rejects(
      admitOperation(
        {
          ...managerOperation,
          target: {
            requestId,
            feedId: 7,
            memberAccount: 'friend',
            memberNamespaceId: 1,
          },
        },
        actors(actor),
        1000,
      ),
      /invalid request ID/,
    );
  }
  assert.equal(sent, 0);
});

for (const status of ['STALE_REQUEST', 'EXPIRED']) {
  test(`a ${status} decision is recorded as unavailable, never a successful mutation`, async () => {
    const result = await admitOperation(
      managerOperation,
      actors({
        node: { name: 'charlie', domain: 'charlie.test' },
        async post() {
          return { status };
        },
      }),
      1000,
    );
    assert.equal(result.status, 'OBSERVED_UNAVAILABLE');
    assert.deepEqual(result.result, { status });
    assert.equal(Object.hasOwn(result, 'taskId'), false);
  });
}

test('an unknown request decision result is not journaled as success', async () => {
  for (const reply of [
    undefined,
    {},
    { status: 'APPLIED' },
    { taskId: 'old-task' },
  ]) {
    await assert.rejects(
      admitOperation(
        managerOperation,
        actors({
          node: { name: 'charlie', domain: 'charlie.test' },
          async post() {
            return reply;
          },
        }),
        1000,
      ),
      /invalid request decision result/,
    );
  }
});
