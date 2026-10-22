import assert from 'node:assert/strict';
import test from 'node:test';
import { observeDirectedPair } from './operation-log.mjs';

const alice = 'alice@alpha.test';
const bob = 'bob@bravo.test';
const pair = `${alice}|${bob}`;

function nodeSnapshot({ all = [], active = [], intents = [] } = {}) {
  return {
    pairs: { all, active, duplicates: [], invalid: [] },
    intents: { directions: intents, duplicates: [], invalid: [] },
  };
}

function consistencySnapshot({ alpha, bravo } = {}) {
  return {
    alpha: nodeSnapshot(alpha),
    bravo: nodeSnapshot(bravo),
    charlie: nodeSnapshot(),
  };
}

test('classifies a selected direction from database facts', () => {
  const pending = consistencySnapshot({
    alpha: {
      all: [pair],
      intents: [
        {
          author: alice,
          subject: bob,
          status: 'REQUESTED',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    },
  });
  assert.equal(
    observeDirectedPair(pending, alice, bob).state,
    'OUTGOING_PENDING',
  );
  assert.equal(observeDirectedPair(pending, bob, alice).state, 'NONE');

  const active = consistencySnapshot({
    alpha: { all: [pair], active: [pair] },
  });
  assert.equal(observeDirectedPair(active, alice, bob).state, 'FRIEND');
});

test('uses locally received intents even when the author has changed its own copy', () => {
  const state = consistencySnapshot({
    alpha: { intents: [{ author: alice, subject: bob, status: 'REVOKED' }] },
    bravo: {
      all: [pair],
      intents: [
        {
          author: alice,
          subject: bob,
          status: 'REQUESTED',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    },
  });
  const facts = observeDirectedPair(state, bob, alice);
  assert.equal(facts.state, 'INCOMING_PENDING');
  assert.equal(facts.incomingIntent, 'REQUESTED');
  assert.equal(facts.observedOn, 'bravo');
});
