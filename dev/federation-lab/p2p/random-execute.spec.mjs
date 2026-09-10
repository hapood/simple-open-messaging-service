import assert from 'node:assert/strict';
import test from 'node:test';
import { SeededRandom } from './scenario.mjs';
import { LabApiError } from './api-actors.mjs';
import {
  admitOperation,
  chooseRandomRound,
  chooseStateWindow,
  scheduledAdmissionAt,
  createAdmissionPacer,
  executeBatch,
  finalizeTasks,
  observeGroupMessageAvailability,
  settleWorkloadOperations,
  unsubmittedGroupRequests,
} from './random-execute.mjs';

const alice = 'alice@alpha.test';
const bob = 'bob@bravo.test';
const groupAddress = '!group@bravo.test';
const pair = `${alice}|${bob}`;

test('classifies random acceptance or rejection of an expired or revoked incoming request as unavailable', async () => {
  const base = {
    id: 'op-000244',
    type: 'ACCEPT_REQUEST',
    pair,
    taskNode: 'alpha',
    taskId: '75',
    observedFacts: { state: 'INCOMING_PENDING' },
  };
  for (const [changes, status, resultCode, expected] of [
    [{}, 'REJECTED', 20011, 'OBSERVED_UNAVAILABLE'],
    [{ type: 'REJECT_REQUEST' }, 'REJECTED', 20013, 'OBSERVED_UNAVAILABLE'],
    [{ type: 'REJECT_REQUEST' }, 'REJECTED', 20011, 'OBSERVED_UNAVAILABLE'],
    [
      { type: 'REJECT_REQUEST', scenario: 'FIXED' },
      'REJECTED',
      20011,
      'REJECTED',
    ],
    [
      { type: 'REJECT_REQUEST', group: groupAddress },
      'REJECTED',
      20011,
      'REJECTED',
    ],
    [
      { type: 'REJECT_REQUEST', pair: undefined },
      'REJECTED',
      20011,
      'REJECTED',
    ],
    [
      { type: 'REJECT_REQUEST', observedFacts: { state: 'FRIEND' } },
      'REJECTED',
      20011,
      'REJECTED',
    ],
    [{ type: 'REJECT_REQUEST' }, 'FAILED', 20011, 'FAILED'],
    [{ type: 'REJECT_REQUEST' }, 'REJECTED', 20002, 'REJECTED'],
    [
      { type: 'REJECT_REQUEST', scenario: 'FIXED' },
      'REJECTED',
      20013,
      'REJECTED',
    ],
    [
      { type: 'REJECT_REQUEST', observedFacts: { state: 'FRIEND' } },
      'REJECTED',
      20013,
      'REJECTED',
    ],
    [{ type: 'REJECT_REQUEST' }, 'FAILED', 20013, 'FAILED'],
    [
      { type: 'ACCEPT_GROUP_APPLICATION', group: groupAddress },
      'REJECTED',
      10001,
      'REJECTED',
    ],
    [{ scenario: 'FIXED' }, 'REJECTED', 20011, 'REJECTED'],
    [{ group: groupAddress }, 'REJECTED', 20011, 'REJECTED'],
    [{ pair: undefined }, 'REJECTED', 20011, 'REJECTED'],
    [{ observedFacts: undefined }, 'REJECTED', 20011, 'REJECTED'],
    [{ observedFacts: { state: 'FRIEND' } }, 'REJECTED', 20011, 'REJECTED'],
    [{ type: 'SEND_REQUEST' }, 'REJECTED', 20011, 'REJECTED'],
    [{}, 'FAILED', 20011, 'FAILED'],
    [{}, 'REJECTED', 20002, 'REJECTED'],
  ]) {
    const [result] = await finalizeTasks([{ ...base, ...changes }], {
      node: () => ({
        admin: {
          durableTaskStatuses: async () =>
            new Map([
              [
                '75',
                {
                  status,
                  resultCode,
                  lastError: 'retained',
                  completedAt: 1788688509067,
                },
              ],
            ]),
        },
      }),
    });
    assert.equal(result.status, expected);
    assert.equal(result.resultCode, resultCode);
    assert.equal(result.lastError, 'retained');
    assert.equal(result.finishedAt, 1788688509067);
  }
});

test('classifies only an already-handled random pending cancellation as unavailable', async () => {
  const base = {
    id: 'op',
    type: 'REVOKE_RELATIONSHIP',
    pair,
    taskNode: 'alpha',
    taskId: '1',
    observedFacts: { state: 'OUTGOING_PENDING' },
  };
  for (const [changes, status, resultCode, expected] of [
    [{}, 'REJECTED', 20013, 'OBSERVED_UNAVAILABLE'],
    [{ observedFacts: { state: 'FRIEND' } }, 'REJECTED', 20013, 'REJECTED'],
    [{ scenario: 'FIXED' }, 'REJECTED', 20013, 'REJECTED'],
    [{ type: 'SEND_P2P_MESSAGE' }, 'REJECTED', 20013, 'REJECTED'],
    [{}, 'FAILED', 20013, 'FAILED'],
    [{}, 'REJECTED', 20002, 'REJECTED'],
  ]) {
    const [result] = await finalizeTasks([{ ...base, ...changes }], {
      node: () => ({
        admin: {
          durableTaskStatuses: async () =>
            new Map([['1', { status, resultCode, lastError: 'retained' }]]),
        },
      }),
    });
    assert.equal(result.status, expected);
    assert.equal(result.resultCode, resultCode);
    assert.equal(result.lastError, 'retained');
  }
});

test('shares a ten-per-second pacer across batches without catch-up bursts', async () => {
  let now = 0;
  const starts = [];
  const pace = createAdmissionPacer(
    10,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  for (let round = 0; round < 50; round++) {
    for (let index = 0; index < 10; index++) {
      await pace();
      starts.push(now);
    }
  }
  assert.equal(starts.length, 500);
  assert.equal(starts.at(-1), 49900);
  now += 5000;
  await pace();
  const resumed = now;
  await pace();
  assert.equal(now - resumed, 100);
});

test('final-mode submission journals failures without draining between batches', async () => {
  const journal = { operations: [] };
  const decisions = [
    { id: 'op-1', type: 'SEND_REQUEST' },
    { id: 'op-2', type: 'SEND_REQUEST' },
  ];
  await executeBatch({
    label: 'round 1',
    decisions,
    log: journal,
    actors: {},
    concurrency: 1,
    timeoutMs: 100,
    progressEvery: 1,
    onProgress() {},
    onLog: async () => {},
    totalLabel: '',
    operationsPerSecond: 10,
    pace: async () => {},
    settle: false,
    admit: async (operation) => {
      if (operation.id === 'op-2') throw new Error('admission failed');
      return {
        ...operation,
        status: 'ADMITTED',
        taskId: '1',
        taskNode: 'alpha',
      };
    },
  });
  assert.deepEqual(
    journal.operations.map(({ status }) => status),
    ['ADMITTED', 'ADMISSION_FAILED'],
  );
  let drained = false;
  await assert.rejects(
    settleWorkloadOperations(
      {
        operations: journal.operations,
        log: journal,
        actors: { nodes: new Map([['alpha', {}]]) },
        label: 'final',
        timeoutMs: 100,
        onProgress() {},
        onLog: async () => {},
      },
      {
        waitForIdle: async () => {
          drained = true;
        },
        finalize: async (operations) =>
          operations.map((operation) => ({
            ...operation,
            status: 'SUCCEEDED',
          })),
      },
    ),
    /1 operations failed admission: op-2/,
  );
  assert.equal(drained, true);
  assert.equal(journal.operations[0].status, 'SUCCEEDED');
});

test('final consistency permits business rejections while preserving results and draining tasks', async () => {
  const rejected = {
    id: 'op-000336',
    status: 'REJECTED',
    resultCode: 20010,
    lastError: null,
  };
  for (const initial of [rejected, { ...rejected, status: 'ADMITTED' }]) {
    const journal = { operations: [initial] };
    let drained = false;
    await settleWorkloadOperations(
      {
        operations: journal.operations,
        log: journal,
        actors: { nodes: new Map([['alpha', {}]]) },
        label: 'final workload',
        verifyMode: 'final',
        drain: true,
        onProgress() {},
        onLog: async () => {},
      },
      {
        waitForIdle: async () => {
          drained = true;
        },
        finalize: async () => [rejected],
      },
    );
    assert.equal(drained, true);
    assert.deepEqual(journal.operations, [rejected]);
  }
});

test('settlement retains strict round outcomes and final execution failure checks', async () => {
  for (const [verifyMode, status] of [
    ['round', 'REJECTED'],
    ['final', 'FAILED'],
    ['final', 'PROCESSING'],
    ['final', 'ADMISSION_FAILED'],
  ]) {
    const journal = { operations: [{ id: 'op-1', status }] };
    await assert.rejects(
      settleWorkloadOperations({
        operations: journal.operations,
        log: journal,
        actors: {},
        label: 'validation',
        verifyMode,
        onProgress() {},
        onLog: async () => {},
      }),
      /op-1/,
    );
  }
});

test('final validation rejects earlier observed task failures, not just pending tasks', async () => {
  const journal = { operations: [{ id: 'op-1', status: 'FAILED' }] };
  await assert.rejects(
    settleWorkloadOperations({
      operations: journal.operations,
      log: journal,
      actors: {},
      label: 'final',
      timeoutMs: 100,
      onProgress() {},
      onLog: async () => {},
    }),
    /op-1=FAILED/,
  );
});

function nodeSnapshot({ all = [], active = [], intents = [] } = {}) {
  return {
    pairs: { all, active, duplicates: [], invalid: [] },
    intents: { directions: intents, duplicates: [], invalid: [] },
  };
}

function snapshot({ active = false, intents = [] } = {}) {
  const all = active || intents.length > 0 ? [pair] : [];
  return {
    alpha: nodeSnapshot({
      all,
      active: active ? [pair] : [],
      intents: intents.filter(({ author }) => author === alice),
    }),
    bravo: nodeSnapshot({
      all,
      active: active ? [pair] : [],
      intents: intents.filter(({ author }) => author === bob),
    }),
    charlie: nodeSnapshot(),
  };
}

function log() {
  return {
    seed: 19,
    users: [alice, bob],
    operations: [],
  };
}

test('selects ten random operations per round for the default twelve-user topology', () => {
  const journal = {
    seed: 19,
    operations: [],
    groups: [],
    users: ['alpha', 'bravo', 'charlie'].flatMap((node) =>
      Array.from({ length: 4 }, (_, index) => `u${index}@${node}.test`),
    ),
  };
  const random = new SeededRandom(19);
  for (let round = 1; round <= 50; round++) {
    const decisions = chooseRandomRound({
      log: journal,
      snapshot: snapshot(),
      random,
      count: 10,
      round,
    });
    assert.equal(decisions.length, 10);
    journal.operations.push(...decisions);
  }
  assert.equal(journal.operations.length, 500);
  assert.equal(journal.operations.at(-1).round, 50);
});

test('limits one state window to three users and three groups', () => {
  const users = [
    'a@alpha.test',
    'b@alpha.test',
    'c@bravo.test',
    'd@bravo.test',
    'e@charlie.test',
  ];
  const groups = Array.from({ length: 5 }, (_, index) => ({
    address: `!group-${index}@alpha.test`,
  }));
  const window = chooseStateWindow({ users, groups }, new SeededRandom(123));

  assert.equal(window.users.length, 3);
  assert.equal(window.groups.length, 3);
  assert.equal(new Set(window.users).size, 3);
  assert.equal(new Set(window.groups).size, 3);
  assert.ok(window.users.every((address) => users.includes(address)));
  assert.ok(
    window.groups.every((address) =>
      groups.some((group) => group.address === address),
    ),
  );
});

test('retains one stateful group in the three-group window', () => {
  const users = [alice, bob, 'carol@charlie.test'];
  const groups = Array.from({ length: 5 }, (_, index) => ({
    address: `!group-${index}@alpha.test`,
  }));
  const stateful = groups[4].address;
  const emptyNode = (name) => ({
    node: { name },
    groups: new Map(),
    users: new Map(),
    activeP2p: new Set(),
  });
  const groupSnapshot = {
    alpha: emptyNode('alpha'),
    bravo: emptyNode('bravo'),
    charlie: emptyNode('charlie'),
  };
  groupSnapshot.alpha.groups.set(stateful, {
    roster: [{ address: alice, role: 'OWNER' }],
    relationships: new Map(),
    requests: [],
  });

  const window = chooseStateWindow(
    { users, groups },
    new SeededRandom(7),
    groupSnapshot,
  );

  assert.equal(window.statefulGroup, stateful);
  assert.ok(window.groups.includes(stateful));
  assert.equal(window.groups.length, 3);
});

test('chooses direction before inspecting a real empty snapshot', () => {
  const [decision] = chooseRandomRound({
    log: log(),
    snapshot: snapshot(),
    random: new SeededRandom(4),
    count: 1,
  });
  assert.match(decision.selectedDirection, /^.+->.+$/);
  assert.equal(decision.type, 'SEND_REQUEST');
  assert.equal(
    decision.selectedDirection,
    `${decision.actor}->${decision.peer}`,
  );
  assert.equal(decision.observedFacts.state, 'NONE');
});

test('never acts as the remote recipient of an outgoing request', () => {
  const [decision] = chooseRandomRound({
    log: log(),
    snapshot: snapshot({
      intents: [
        {
          author: alice,
          subject: bob,
          status: 'REQUESTED',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    }),
    random: new SeededRandom(9),
    count: 1,
  });
  assert.equal(decision.requestAuthor, alice);
  assert.equal(decision.requestSubject, bob);
  assert.equal(decision.actor, decision.selectedAuthor);
  assert.deepEqual(decision.decisionOptions, ['REVOKE_RELATIONSHIP']);
});

test('random request rejection does not wait for an incoming projection', async () => {
  const receiver = {
    address: bob,
    node: { name: 'bravo' },
    resolveFederatedUser: async () => assert.fail('must not wait for incoming'),
    post: async () => ({ taskId: '1' }),
  };
  const sender = {
    address: alice,
    account: 'alice',
    domain: 'alpha.test',
    node: { name: 'alpha' },
  };
  const result = await admitOperation(
    { type: 'REJECT_REQUEST', requestSubject: bob, requestAuthor: alice },
    { user: (address) => (address === bob ? receiver : sender) },
    1,
  );
  assert.equal(result.status, 'ADMITTED');
});

test('only confirmed unavailable relationships suppress FRIEND_NOT_FOUND', async () => {
  for (const [code, unavailable, expected] of [
    [20002, true, 'OBSERVED_UNAVAILABLE'],
    [20002, false, 'ADMISSION_FAILED'],
    [50000, true, 'ADMISSION_FAILED'],
  ]) {
    const journal = { operations: [] };
    await executeBatch({
      label: 'round',
      decisions: [{ id: 'op', type: 'SEND_GALLERY' }],
      log: journal,
      actors: {},
      concurrency: 1,
      timeoutMs: 10,
      progressEvery: 1,
      onProgress() {},
      onLog: async () => {},
      totalLabel: '',
      pace: async () => {},
      settle: false,
      admit: async () => {
        throw new LabApiError('rejected', { code });
      },
      confirmUnavailable: async () => unavailable,
    });
    assert.equal(journal.operations[0].status, expected);
  }
});

test('confirms group message availability from the sender node and explicit relationship facts', () => {
  const decision = { actor: alice, group: groupAddress };
  for (const [localGroup, dissolved, active] of [
    [undefined, null, null],
    [{ dissolved: false, relationships: new Map() }, false, null],
    [{ dissolved: true, relationships: new Map() }, true, null],
    [
      {
        dissolved: false,
        relationships: new Map([[alice, { active: false }]]),
      },
      false,
      false,
    ],
    [
      { dissolved: false, relationships: new Map([[alice, { active: true }]]) },
      false,
      true,
    ],
  ]) {
    const facts = observeGroupMessageAvailability(
      {
        alpha: {
          groups: new Map(
            localGroup ? [[groupAddress, { threadId: 7, ...localGroup }]] : [],
          ),
        },
        bravo: { groups: new Map([[groupAddress, { dissolved: true }]]) },
      },
      decision,
    );
    assert.equal(facts.observedOn, 'alpha');
    assert.equal(facts.groupDissolved, dissolved);
    assert.equal(facts.membershipActive, active);
    assert.equal(facts.threadId, localGroup ? 7 : null);
    assert.ok(Number.isFinite(Date.parse(facts.observedAt)));
  }
});

test('only confirmed random group message races suppress GROUP_FORBIDDEN and preserve evidence', async () => {
  const base = {
    id: 'op-000329',
    actor: alice,
    group: groupAddress,
    type: 'SEND_GROUP_MESSAGE',
    observedFacts: { membershipActive: true },
  };
  const dissolved = { groupDissolved: true, membershipActive: true };
  const departed = { groupDissolved: false, membershipActive: false };
  for (const [changes, code, confirmation, expected, calls] of [
    [{}, 40005, dissolved, 'OBSERVED_UNAVAILABLE', 1],
    [{}, 40005, departed, 'OBSERVED_UNAVAILABLE', 1],
    ...[
      'SEND_FILE',
      'SEND_GALLERY',
      'SEND_QUOTE',
      'FORWARD_DIRECT',
      'FORWARD_HISTORY',
    ].map((type) => [{ type }, 40005, departed, 'OBSERVED_UNAVAILABLE', 1]),
    [
      {},
      40005,
      { groupDissolved: false, membershipActive: true },
      'ADMISSION_FAILED',
      1,
    ],
    [
      {},
      40005,
      { groupDissolved: null, membershipActive: null },
      'ADMISSION_FAILED',
      1,
    ],
    [{}, 40005, null, 'ADMISSION_FAILED', 1],
    [{}, 40005, new Error('snapshot unavailable'), 'ADMISSION_FAILED', 1],
    [{ scenario: 'FIXED' }, 40005, dissolved, 'ADMISSION_FAILED', 0],
    [{ type: 'KICK_GROUP_MEMBER' }, 40005, departed, 'ADMISSION_FAILED', 0],
    [
      { type: 'WITHDRAW_GROUP_MESSAGE' },
      40005,
      departed,
      'ADMISSION_FAILED',
      0,
    ],
    [{ observedFacts: undefined }, 40005, departed, 'ADMISSION_FAILED', 0],
    [{ group: undefined }, 40005, departed, 'ADMISSION_FAILED', 0],
    [{}, 50000, departed, 'ADMISSION_FAILED', 0],
  ]) {
    const journal = { operations: [] };
    const details = {
      code,
      message: 'conversation is read-only',
      requestId: 'request-id',
    };
    const attempts = [{ index: 0, status: 'FAILED' }];
    let confirmationCalls = 0;
    await executeBatch({
      label: 'round',
      decisions: [{ ...base, ...changes }],
      log: journal,
      actors: {},
      concurrency: 1,
      timeoutMs: 10,
      progressEvery: 1,
      onProgress() {},
      onLog: async () => {},
      totalLabel: '',
      pace: async () => {},
      settle: false,
      admit: async () => {
        const error = new LabApiError('rejected', details);
        error.attempts = attempts;
        throw error;
      },
      confirmGroupUnavailable: async () => {
        confirmationCalls += 1;
        if (confirmation instanceof Error) throw confirmation;
        return confirmation;
      },
    });
    const operation = journal.operations[0];
    assert.equal(operation.status, expected);
    assert.equal(confirmationCalls, calls);
    assert.deepEqual(operation.error.details, details);
    assert.deepEqual(operation.attempts, attempts);
    if (calls && confirmation instanceof Error) {
      assert.equal(
        operation.unavailableConfirmation.error.message,
        confirmation.message,
      );
    } else {
      assert.deepEqual(
        operation.unavailableConfirmation,
        calls && confirmation ? confirmation : undefined,
      );
    }
  }
});

test('handles a revoked incoming request before admission with the same policy as task rejection', async () => {
  const base = {
    id: 'op-000152',
    type: 'ACCEPT_REQUEST',
    pair: 'c1@charlie.test|c5@charlie.test',
    actor: 'c5@charlie.test',
    peer: 'c1@charlie.test',
    observedFacts: { state: 'INCOMING_PENDING' },
  };
  for (const [changes, code, expected] of [
    [{}, 20011, 'OBSERVED_UNAVAILABLE'],
    [{ type: 'REJECT_REQUEST' }, 20013, 'OBSERVED_UNAVAILABLE'],
    [{ type: 'REJECT_REQUEST' }, 20011, 'OBSERVED_UNAVAILABLE'],
    [{ type: 'REJECT_REQUEST', scenario: 'FIXED' }, 20011, 'ADMISSION_FAILED'],
    [
      { type: 'REJECT_REQUEST', group: groupAddress },
      20011,
      'ADMISSION_FAILED',
    ],
    [{ type: 'REJECT_REQUEST', pair: undefined }, 20011, 'ADMISSION_FAILED'],
    [
      { type: 'REJECT_REQUEST', observedFacts: { state: 'FRIEND' } },
      20011,
      'ADMISSION_FAILED',
    ],
    [{ type: 'REJECT_REQUEST' }, 20002, 'ADMISSION_FAILED'],
    [{ type: 'REJECT_REQUEST', scenario: 'FIXED' }, 20013, 'ADMISSION_FAILED'],
    [{ type: 'REJECT_REQUEST' }, 10001, 'ADMISSION_FAILED'],
    [{ scenario: 'FIXED' }, 20011, 'ADMISSION_FAILED'],
    [{ group: groupAddress }, 20011, 'ADMISSION_FAILED'],
    [{ pair: undefined }, 20011, 'ADMISSION_FAILED'],
    [{ observedFacts: undefined }, 20011, 'ADMISSION_FAILED'],
    [{ observedFacts: { state: 'FRIEND' } }, 20011, 'ADMISSION_FAILED'],
    [{ type: 'SEND_REQUEST' }, 20011, 'ADMISSION_FAILED'],
    [{}, 50000, 'ADMISSION_FAILED'],
  ]) {
    const journal = { operations: [] };
    const details = {
      status: 200,
      code,
      message: 'request expired',
      data: null,
    };
    await executeBatch({
      label: 'round',
      decisions: [{ ...base, ...changes }],
      log: journal,
      actors: {},
      concurrency: 1,
      timeoutMs: 10,
      progressEvery: 1,
      onProgress() {},
      onLog: async () => {},
      totalLabel: '',
      pace: async () => {},
      settle: false,
      admit: async () => {
        throw new LabApiError('accept failed', details);
      },
    });
    assert.equal(journal.operations[0].status, expected);
    assert.deepEqual(journal.operations[0].error.details, details);
    assert.equal(journal.operations[0].taskId, undefined);
  }
});

test('usually retains friendships but still samples relationship revoke', () => {
  const random = new SeededRandom(2);
  const decisions = Array.from({ length: 100 }, () =>
    chooseRandomRound({
      log: log(),
      snapshot: snapshot({ active: true }),
      random,
      count: 1,
    }),
  ).flat();
  assert.ok(decisions.length > 0 && decisions.length < 30);
  const decision = decisions[0];
  assert.equal(decision.type, 'REVOKE_RELATIONSHIP');
  assert.equal(decision.observedFacts.state, 'FRIEND');
  assert.equal(decision.actor, decision.selectedAuthor);
});

test('sends P2P messages using the current pair thread after friendship re-establishment', () => {
  const facts = snapshot({ active: true });
  facts.alpha.pairs.threadIds = { [pair]: 31 };
  facts.bravo.pairs.threadIds = { [pair]: 84 };
  const random = new SeededRandom(81392);
  const decisions = Array.from({ length: 50 }, () =>
    chooseRandomRound({
      log: {
        ...log(),
        operations: [
          {
            type: 'REVOKE_RELATIONSHIP',
            actor: alice,
            peer: bob,
            status: 'SUCCEEDED',
          },
        ],
      },
      snapshot: facts,
      random,
      count: 1,
    }),
  ).flat();
  const sends = decisions.filter(({ type }) => type === 'SEND_P2P_MESSAGE');
  assert.ok(sends.length > 20);
  for (const operation of sends) {
    assert.equal(operation.p2pPair, pair);
    assert.equal(operation.threadId, operation.actor === alice ? 31 : 84);
  }
});

test('selects a user first and keeps every group direction user-to-group', () => {
  const group = {
    address: '!group@alpha.test',
    account: '!group',
    domain: 'alpha.test',
    name: 'group',
  };
  const projection = {
    ...group,
    groupId: 1,
    threadId: 11,
    roster: [
      { address: alice, role: 'OWNER', account: 'alice', domain: 'local' },
    ],
    relationships: new Map([
      [
        alice,
        { active: true, groupIntent: 'ACCEPTED', userIntent: 'ACCEPTED' },
      ],
    ]),
    requests: [],
    messages: [],
  };
  const groupSnapshot = {
    alpha: {
      node: { name: 'alpha' },
      groups: new Map([[group.address, projection]]),
      users: new Map(),
      activeP2p: new Set(),
    },
    bravo: {
      node: { name: 'bravo' },
      groups: new Map(),
      users: new Map(),
      activeP2p: new Set(),
    },
    charlie: {
      node: { name: 'charlie' },
      groups: new Map(),
      users: new Map(),
      activeP2p: new Set(),
    },
  };
  const decisions = chooseRandomRound({
    log: { ...log(), groups: [group] },
    snapshot: snapshot(),
    groupSnapshot,
    random: new SeededRandom(3),
    count: 2,
  });
  const selected = decisions.find((decision) => decision.group);
  assert.ok(selected);
  assert.equal(selected.selectedSubject, group.address);
  assert.equal(selected.selectedAuthor.startsWith('!'), false);
  assert.equal(
    selected.selectedDirection,
    `${selected.actor}->${group.address}`,
  );
});

test('paces admissions globally at ten operation starts per second', () => {
  const starts = Array.from({ length: 21 }, (_, index) =>
    scheduledAdmissionAt(5_000, index, 10),
  );
  assert.deepEqual(starts.slice(0, 4), [5_000, 5_100, 5_200, 5_300]);
  assert.equal(starts[10], 6_000);
  assert.equal(starts[20], 7_000);
});

test('admits a remote group application with the observed group profile', async () => {
  const calls = [];
  const actor = {
    address: alice,
    domain: 'alpha.test',
    node: { name: 'alpha' },
    resolveFederatedUser: async ({ account, domain }) => {
      calls.push({
        endpoint: '/user/resolve-federated-stream',
        account,
        domain,
      });
      return {
        user: { account, name: 'Resolved remote group' },
        relationship: 'NONE',
      };
    },
    post: async (endpoint, body) => {
      calls.push({ endpoint, body });
      return { taskId: '91' };
    },
  };
  const admitted = await admitOperation(
    {
      id: 'op-1',
      type: 'REQUEST_GROUP_JOIN',
      actor: alice,
      group: '!group@bravo.test',
      groupThreadId: null,
      observedFacts: {
        group: {
          address: '!group@bravo.test',
          account: '!group',
          domain: 'bravo.test',
          name: 'Remote group',
        },
      },
    },
    { user: () => actor },
    1_000,
  );
  assert.equal(admitted.status, 'ADMITTED');
  assert.deepEqual(calls, [
    {
      endpoint: '/user/resolve-federated-stream',
      account: '!group',
      domain: 'bravo.test',
    },
    {
      endpoint: '/relationship/request',
      body: {
        account: '!group',
        domain: 'bravo.test',
        note: 'op-1',
        displayName: 'Resolved remote group',
      },
    },
  ]);
  assert.deepEqual(admitted.preflight, {
    endpoint: '/user/resolve-federated-stream',
    target: '!group@bravo.test',
    observedRelationship: 'NONE',
  });
});

test('executes a unary user profile update without a second selector', async () => {
  const updates = [];
  const actor = {
    address: alice,
    updateProfile: async (value) => updates.push(value),
  };
  const admitted = await admitOperation(
    {
      id: 'op-9',
      type: 'UPDATE_USER_PROFILE',
      actor: alice,
      profileTarget: alice,
      avatarAction: 'SET',
    },
    { user: () => actor },
    1_000,
  );
  assert.equal(admitted.status, 'SUCCEEDED');
  assert.deepEqual(updates, [
    {
      name: 'user-op-9',
      bio: 'Federation profile update op-9',
      avatar: 'SET',
    },
  ]);
  assert.equal(admitted.request.endpoint, '/user/update-profile');
});

test('uploads an avatar before a unary group profile update', async () => {
  const calls = [];
  const actor = {
    address: alice,
    uploadAvatar: async () => {
      calls.push('upload');
      return '/uploads/avatars/group-512.webp';
    },
    updateGroup: async (value) => calls.push(value),
  };
  const admitted = await admitOperation(
    {
      id: 'op-10',
      type: 'UPDATE_GROUP_PROFILE',
      actor: alice,
      group: groupAddress,
      groupThreadId: 17,
      profileTarget: groupAddress,
      avatarAction: 'SET',
    },
    { user: () => actor },
    1_000,
  );
  assert.equal(admitted.status, 'SUCCEEDED');
  assert.deepEqual(calls, [
    'upload',
    {
      groupId: 17,
      name: 'group-op-10',
      description: 'Federation group update op-10',
      avatar: '/uploads/avatars/group-512.webp',
    },
  ]);
});

test('does not resubmit group requests while their earlier decision is pending or completed', () => {
  const request = {
    direction: 'APPLICATION',
    requestId: '48',
    expiresAt: '2026-09-14T13:15:16.696Z',
  };
  const operation = {
    group: groupAddress,
    type: 'ACCEPT_GROUP_APPLICATION',
    target: request,
  };
  for (const status of ['ADMITTED', 'SUCCEEDED', 'OBSERVED_UNAVAILABLE']) {
    assert.deepEqual(
      unsubmittedGroupRequests([request], groupAddress, [
        { ...operation, status },
      ]),
      [],
    );
  }
  for (const status of ['ADMISSION_FAILED', 'REJECTED', 'FAILED']) {
    assert.deepEqual(
      unsubmittedGroupRequests([request], groupAddress, [
        { ...operation, status },
      ]),
      [request],
    );
  }
  const completed = { ...operation, status: 'SUCCEEDED' };
  for (const candidate of [
    { ...request, requestId: '49' },
    { ...request, expiresAt: '2026-09-15T13:15:16.696Z' },
    { ...request, direction: 'INVITATION' },
  ])
    assert.deepEqual(
      unsubmittedGroupRequests([candidate], groupAddress, [completed]),
      [candidate],
    );
  assert.deepEqual(
    unsubmittedGroupRequests([request], '!other@bravo.test', [completed]),
    [request],
  );
});

test('final barrier drains fanout children even when the dissolution parent is already complete', async () => {
  const journal = {
    operations: [
      { id: 'dissolve', type: 'DISSOLVE_GROUP', status: 'SUCCEEDED' },
    ],
  };
  let drained = false;
  const options = {
    operations: journal.operations,
    log: journal,
    actors: {
      nodes: new Map([
        ['alpha', {}],
        ['bravo', {}],
        ['charlie', {}],
      ]),
    },
    label: 'final workload',
    drain: true,
    timeoutMs: 100,
    onProgress() {},
    onLog: async () => {},
  };
  await settleWorkloadOperations(options, {
    waitForIdle: async ({ nodeNames }) => {
      assert.deepEqual(nodeNames, ['alpha', 'bravo', 'charlie']);
      drained = true;
    },
    finalize: async () => assert.fail('no unfinished parent commands'),
  });
  assert.equal(drained, true);
  await assert.rejects(
    settleWorkloadOperations(options, {
      waitForIdle: async () => {
        throw new Error('fanout child failed');
      },
    }),
    /fanout child failed/,
  );
});
