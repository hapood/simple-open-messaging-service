import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveNamespaceUntilReady,
  resolveWorkloadNamespaces,
} from './namespace-resolution.mjs';

const pair = { publisherNamespaceId: 7, profileNamespaceId: 2 };
const entry = {
  ...pair,
  expired: false,
  domain: 'subject.test',
  rootPublicKey: 'root',
  status: 'ACTIVE',
};

test('waits through pending and expired placeholders without inventing a binding', async () => {
  const responses = [
    { status: 'PENDING' },
    {
      status: 'READY',
      entry: { ...entry, expired: true, domain: null, rootPublicKey: null },
    },
    { status: 'READY', entry },
  ];
  const calls = [];
  const actor = {
    address: 'viewer@test',
    post: async (path, value) => {
      calls.push([path, value]);
      return responses.shift();
    },
  };
  assert.deepEqual(
    await resolveNamespaceUntilReady(actor, pair, 1000, 0),
    entry,
  );
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      ([path, value]) =>
        path === '/profile-namespaces/resolve' && value === pair,
    ),
  );
});

test('rejects mismatched pairs and fails explicitly for unresolved bindings', async () => {
  await assert.rejects(
    resolveNamespaceUntilReady(
      {
        post: async () => ({
          status: 'READY',
          entry: { ...entry, publisherNamespaceId: 8 },
        }),
      },
      pair,
      1000,
    ),
    /different pair/,
  );
  await assert.rejects(
    resolveNamespaceUntilReady(
      { address: 'viewer@test', post: async () => ({ status: 'PENDING' }) },
      pair,
      5,
      1,
    ),
    /timed out resolving namespace/,
  );
});

test('demands raw reference pairs, excluding receiver-local aliases rather than querying their publisher', async () => {
  const actor = {
    post: async (_path, value) => {
      assert.deepEqual(value, pair);
      return { status: 'READY', entry };
    },
  };
  const connections = new Map([
    [
      'alpha',
      {
        node: { name: 'alpha' },
        client: {
          query: async (sql) => {
            assert.match(sql, /fact.body ->> 'namespaceId'/);
            assert.match(
              sql,
              /message\."publisherNamespaceId", message\."profileNamespaceId"/,
            );
            assert.match(
              sql,
              /IS DISTINCT FROM publisher\."peerAssignedLocalNamespaceId"/,
            );
            assert.match(sql, /SELECT DISTINCT/);
            return { rows: [pair] };
          },
        },
      },
    ],
  ]);
  assert.deepEqual(
    await resolveWorkloadNamespaces({
      connections,
      actors: {
        nodes: new Map([['alpha', { users: new Map([['viewer', actor]]) }]]),
      },
      timeoutMs: 1000,
      onProgress: () => {},
    }),
    [{ nodeName: 'alpha', pair, entry }],
  );
});
