import assert from 'node:assert/strict';
import test from 'node:test';
import { SeededRandom } from './scenario.mjs';
import {
  admitOperation,
  chooseRandomRound,
  chooseStateWindow,
  scheduledAdmissionAt,
} from './random-execute.mjs';

const alice = 'alice@alpha.test';
const bob = 'bob@bravo.test';
const groupAddress = '!group@bravo.test';
const pair = `${alice}|${bob}`;

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

test('uses authoritative request direction regardless of selected orientation', () => {
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
  assert.equal(decision.actor, bob);
  assert.deepEqual(decision.decisionOptions, [
    'ACCEPT_REQUEST',
    'REVERSE_REQUEST',
    'REJECT_REQUEST',
  ]);
});

test('selects relationship revoke from a real active pair fact', () => {
  const [decision] = chooseRandomRound({
    log: log(),
    snapshot: snapshot({ active: true }),
    random: new SeededRandom(2),
    count: 1,
  });
  assert.equal(decision.type, 'REVOKE_RELATIONSHIP');
  assert.equal(decision.observedFacts.state, 'FRIEND');
  assert.equal(decision.actor, decision.selectedAuthor);
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
