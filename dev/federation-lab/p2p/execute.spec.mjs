import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapConcurrent,
  resolveWithRetry,
  waitForIncoming,
  waitForTaskQueueIdle,
} from './execute.mjs';

test('mapConcurrent preserves result order and bounds active workers', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapConcurrent([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8]);
  assert.equal(maximum, 2);
});

test('waitForTaskQueueIdle prints active ids and requires two empty samples', async () => {
  const samples = [
    {
      queryMs: { PENDING: 17, PROCESSING: 35 },
      pendingCount: 1,
      processing: [{ id: '12' }],
    },
    { pendingCount: 0, processing: [] },
    { pendingCount: 0, processing: [] },
  ];
  const output = [];
  let cursor = 0;
  const actors = {
    node: () => ({
      admin: {
        durableTaskActivity: async () =>
          samples[Math.min(cursor++, samples.length - 1)],
      },
    }),
  };
  await waitForTaskQueueIdle({
    actors,
    nodeNames: ['alpha'],
    description: 'test queue',
    timeoutMs: 3_000,
    onProgress: (line) => output.push(line),
  });
  assert.match(output[0], /processing=\[12\]/);
  assert.match(output.at(-1), /pending=0/);
  assert.match(output[0], /statusMs=\[PENDING:17,PROCESSING:35\]/);
  assert.match(
    output[0],
    /sample=1 idleSamples=0\/2 sampleMs=\d+ queryTotalMs=\d+ sleepTotalMs=0/,
  );
  assert.match(output.at(-1), /sample=3 idleSamples=2\/2/);
  assert.ok(Number(output.at(-1).match(/sleepTotalMs=(\d+)/)[1]) >= 900);
  assert.equal(cursor, 3);
});

test('queue drain reports failed tasks immediately, including when no pending tasks remain', async () => {
  for (const pendingCount of [0, 5]) {
    let queries = 0;
    const actors = {
      node: () => ({
        admin: {
          durableTaskActivity: async () => {
            queries++;
            return {
              pendingCount,
              processing: [],
              failedCount: 1,
              failed: [
                {
                  id: '39',
                  taskType: 'LEAVE_GROUP',
                  scopeKey: 'group-scope',
                  lastError: 'deadlock detected',
                },
              ],
            };
          },
        },
      }),
    };
    await assert.rejects(
      waitForTaskQueueIdle({
        actors,
        nodeNames: ['charlie'],
        description: 'midpoint-dissolution queue',
        timeoutMs: 3000,
        onProgress: () => {},
      }),
      /charlie has 1 FAILED durable tasks; 39 LEAVE_GROUP scope=group-scope: deadlock detected/,
    );
    assert.equal(queries, 1);
  }
});

test('wait helpers use received request history and resolved profile observations', async () => {
  const initiator = {
    node: { name: 'alpha' },
    account: 'alice',
    domain: 'alpha.test',
    address: 'alice@alpha.test',
  };
  const receiver = {
    node: { name: 'bravo' },
    address: 'bob@bravo.test',
    account: 'bob',
    post: async (path, body) => {
      assert.equal(path, '/relationship/requests');
      assert.equal(body.bucket, 'RECEIVED');
      return {
        items: [
          {
            id: '9',
            kind: 'FRIEND',
            status: 'REQUESTED',
            author: { account: 'alice', namespaceId: 3 },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      };
    },
  };
  assert.deepEqual(await waitForIncoming(receiver, initiator, 1_000), {
    relationship: 'INCOMING_PENDING',
    requestId: '9',
    user: { account: 'alice' },
  });

  const resolver = {
    resolveFederatedUser: async () => ({
      user: { account: 'alice', name: 'Alice' },
    }),
  };
  assert.equal(
    (await resolveWithRetry(resolver, initiator, 1_000)).user.account,
    'alice',
  );
});

test('waitForIncoming ignores closed, foreign, and expired received rounds', async () => {
  const initiator = {
    node: { name: 'alpha' },
    account: 'alice',
    domain: 'alpha.test',
    address: 'alice@alpha.test',
  };
  const receiver = {
    node: { name: 'alpha' },
    account: 'bob',
    address: 'bob@alpha.test',
    post: async () => ({
      items: [
        {
          id: '10',
          kind: 'FRIEND',
          status: 'REJECTED',
          author: { account: 'alice' },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        {
          id: '11',
          kind: 'FRIEND',
          status: 'REQUESTED',
          author: { account: 'carol' },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        {
          id: '12',
          kind: 'FRIEND',
          status: 'REQUESTED',
          author: { account: 'alice' },
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    }),
  };

  await assert.rejects(
    () => waitForIncoming(receiver, initiator, 50),
    /timed out waiting for bob@alpha.test incoming invite from alice@alpha.test/,
  );
});
