import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeReferenceWithdrawalScenario,
  planMidpointDissolution,
  selectScenarioMembers,
  waitForScenarioSnapshot,
} from './fixed-scenarios.mjs';
import { SeededRandom } from './scenario.mjs';

const alice = 'alice@alpha.test';
const bob = 'bob@bravo.test';
const carol = 'carol@alpha.test';
const address = '!active@alpha.test';

test('final-mode scenario waits for its own prerequisite without a global oracle', async () => {
  let refreshed = 0;
  const result = await waitForScenarioSnapshot({
    snapshot: { visible: false },
    intervalMs: 0,
    timeoutMs: 1000,
    refreshSnapshot: async () => {
      refreshed++;
      return { visible: true };
    },
    check: (snapshot) => {
      if (!snapshot.visible) throw new Error('not visible yet');
      return 'target';
    },
  });
  assert.equal(refreshed, 1);
  assert.equal(result.value, 'target');
  assert.equal(result.snapshot.visible, true);
});

test('scenario prerequisite waits are bounded and preserve the failure cause', async () => {
  const cause = new Error('target is missing');
  await assert.rejects(
    waitForScenarioSnapshot({
      snapshot: {},
      timeoutMs: 0,
      refreshSnapshot: () => assert.fail('deadline already reached'),
      check: () => {
        throw cause;
      },
    }),
    (error) => error.cause === cause && error.message.includes('timed out'),
  );
});

function fixture() {
  const planned = {
    address,
    nodeName: 'alpha',
    domain: 'alpha.test',
    active: true,
    owner: alice,
  };
  const groups = {};
  for (const [name, threadId] of [
    ['alpha', 11],
    ['bravo', 92],
  ]) {
    groups[name] = {
      node: { name },
      users: new Map(),
      activeP2p: new Set(),
      groups: new Map([
        [
          address,
          {
            address,
            threadId,
            dissolved: false,
            roster: [
              { address: alice, role: 'OWNER' },
              { address: bob, role: 'MEMBER' },
              { address: carol, role: 'MEMBER' },
            ],
            relationships: new Map(
              [alice, bob, carol].map((member) => [member, { active: true }]),
            ),
            requests: [],
            messages: [],
          },
        ],
      ]),
    };
  }
  return {
    log: { users: [alice, bob, carol], groups: [planned], operations: [] },
    snapshot: { groups },
  };
}

test('midpoint dissolution follows current ownership and captures the audience before revocation', () => {
  const { log, snapshot } = fixture();
  const group = snapshot.groups.alpha.groups.get(address);
  group.roster[0].role = 'MEMBER';
  group.roster[2].role = 'OWNER';
  const operation = planMidpointDissolution(
    log,
    snapshot.groups,
    new SeededRandom(1),
  );
  assert.equal(operation.actor, carol);
  assert.deepEqual(operation.audienceNodes, ['alpha', 'bravo']);
  log.operations.push({ ...operation, status: 'SUCCEEDED' });
  assert.equal(
    planMidpointDissolution(log, snapshot.groups, new SeededRandom(1)),
    undefined,
  );
});

test('fixed scenarios exclude a revoked member even if its mirrored roster retains MEMBER_UPSERT', () => {
  const { log, snapshot } = fixture();
  snapshot.groups.bravo.groups.get(address).relationships.get(bob).active =
    false;
  assert.equal(selectScenarioMembers(log, snapshot.groups), undefined);
});

test('reference scenario uses remote local coordinates, retries one send, and verifies public reads after withdrawal', async () => {
  const { log, snapshot } = fixture();
  const decisions = [];
  const actors = {
    user(viewer) {
      return {
        async post(_path, body) {
          const node = viewer.endsWith('alpha.test') ? 'alpha' : 'bravo';
          const row = snapshot.groups[node].groups
            .get(address)
            .messages.find(({ seq }) => seq === body.before - 1);
          // The client API projects stored quotes to origin coordinates only.
          const projected = row?.content?.quote
            ? {
                ...row,
                content: {
                  ...row.content,
                  quote: {
                    namespaceId: 0,
                    originSeq: row.content.quote.seq,
                  },
                },
              }
            : row;
          return { messages: [projected] };
        },
        async forwardBundle() {
          return { messages: [{ content: { text: 'source' } }] };
        },
      };
    },
  };
  await executeReferenceWithdrawalScenario({
    log,
    snapshot,
    actors,
    async execute(operation) {
      const index = decisions.length + 1;
      decisions.push(operation);
      if (operation.type === 'WITHDRAW_GROUP_MESSAGE') {
        for (const node of ['alpha', 'bravo'])
          snapshot.groups[node].groups.get(address).messages[0].isDeleted =
            true;
      } else {
        for (const node of ['alpha', 'bravo']) {
          const content =
            operation.type === 'SEND_QUOTE'
              ? { text: 'reply', quote: { seq: node === 'alpha' ? 1 : 101 } }
              : operation.type === 'FORWARD_HISTORY'
                ? { bundleId: 'bundle' }
                : { text: 'source' };
          snapshot.groups[node].groups.get(address).messages.push({
            id: String(index),
            seq: index + (node === 'bravo' ? 100 : 0),
            originSeq:
              node === 'alpha' && operation.actor.endsWith('bravo.test')
                ? index + 100
                : index,
            creatorAddress: operation.actor,
            content,
            localState: 'READY',
            isDeleted: false,
          });
        }
      }
      log.operations.push({
        ...operation,
        id: `op-${index}`,
        status: 'SUCCEEDED',
        request: { body: { clientMessageId: `key-${index}` } },
        result: {
          seq: index + (operation.actor.endsWith('bravo.test') ? 100 : 0),
          originSeq: index,
        },
        expected: { text: 'source' },
      });
      return snapshot;
    },
  });
  assert.deepEqual(
    decisions.map(({ type }) => type),
    [
      'SEND_GROUP_MESSAGE',
      'SEND_QUOTE',
      'FORWARD_DIRECT',
      'FORWARD_HISTORY',
      'WITHDRAW_GROUP_MESSAGE',
    ],
  );
  assert.equal(decisions[1].target.seq, 101);
  assert.equal(decisions[0].retryMode, 'CONCURRENT');
  assert.equal(decisions[1].retryMode, 'AFTER_SUCCESS');
  assert.equal(log.referenceScenario.status, 'SUCCEEDED');
  assert.equal(log.referenceScenario.checks.length, 6);
});

test('reference scenario creates a cross-node member when random coverage has none', async () => {
  const { log, snapshot } = fixture();
  for (const node of ['alpha', 'bravo']) {
    const group = snapshot.groups[node].groups.get(address);
    group.roster = group.roster.filter((member) => member.address !== bob);
    group.relationships.delete(bob);
  }
  const decisions = [];
  const actors = {
    user(viewer) {
      return {
        async post(_path, body) {
          const node = viewer.endsWith('alpha.test') ? 'alpha' : 'bravo';
          const row = snapshot.groups[node].groups
            .get(address)
            .messages.find(({ seq }) => seq === body.before - 1);
          // The client API projects stored quotes to origin coordinates only.
          const projected = row?.content?.quote
            ? {
                ...row,
                content: {
                  ...row.content,
                  quote: {
                    namespaceId: 0,
                    originSeq: row.content.quote.seq,
                  },
                },
              }
            : row;
          return { messages: [projected] };
        },
        async forwardBundle() {
          return { messages: [{ content: { text: 'source' } }] };
        },
      };
    },
  };
  await executeReferenceWithdrawalScenario({
    log,
    snapshot,
    actors,
    async execute(operation) {
      decisions.push(operation);
      if (operation.type === 'INVITE_GROUP_MEMBER') {
        snapshot.groups.bravo.groups.get(address).relationships.set(bob, {
          active: false,
          groupIntent: 'REQUESTED',
          userIntent: null,
        });
      } else if (operation.type === 'ACCEPT_GROUP_INVITATION') {
        for (const node of ['alpha', 'bravo']) {
          const group = snapshot.groups[node].groups.get(address);
          group.roster.push({ address: bob, role: 'MEMBER' });
          group.relationships.set(bob, {
            active: true,
            groupIntent: 'ACCEPTED',
            userIntent: 'ACCEPTED',
          });
        }
      } else if (operation.type === 'WITHDRAW_GROUP_MESSAGE') {
        for (const node of ['alpha', 'bravo'])
          snapshot.groups[node].groups.get(address).messages[0].isDeleted =
            true;
      } else {
        const index = decisions.length;
        for (const node of ['alpha', 'bravo']) {
          const content =
            operation.type === 'SEND_QUOTE'
              ? { text: 'reply', quote: { seq: node === 'alpha' ? 1 : 101 } }
              : operation.type === 'FORWARD_HISTORY'
                ? { bundleId: 'bundle' }
                : { text: 'source' };
          snapshot.groups[node].groups.get(address).messages.push({
            id: String(index),
            seq: index + (node === 'bravo' ? 100 : 0),
            originSeq:
              node === 'alpha' && operation.actor.endsWith('bravo.test')
                ? index + 100
                : index,
            creatorAddress: operation.actor,
            content,
            localState: 'READY',
            isDeleted: false,
          });
        }
      }
      log.operations.push({
        ...operation,
        id: `op-${decisions.length}`,
        status: 'SUCCEEDED',
        request: { body: { clientMessageId: `key-${decisions.length}` } },
        result: {
          seq:
            decisions.length +
            (operation.actor.endsWith('bravo.test') ? 100 : 0),
          originSeq: decisions.length,
        },
        expected: { text: 'source' },
      });
      return snapshot;
    },
  });
  assert.deepEqual(
    decisions.slice(0, 2).map(({ type }) => type),
    ['INVITE_GROUP_MEMBER', 'ACCEPT_GROUP_INVITATION'],
  );
  assert.equal(log.referenceScenario.status, 'SUCCEEDED');
});
