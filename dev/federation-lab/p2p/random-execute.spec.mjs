import assert from 'node:assert/strict';
import test from 'node:test';
import { SeededRandom } from './scenario.mjs';
import { chooseRandomRound } from './random-execute.mjs';

const alice = 'alice@alpha.test';
const bob = 'bob@bravo.test';
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
    schemaVersion: 3,
    seed: 19,
    users: [alice, bob],
    operations: [],
  };
}

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
