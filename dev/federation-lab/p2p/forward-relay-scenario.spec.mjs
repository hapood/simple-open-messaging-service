import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRelaySnapshot,
  readForwardRelayBundle,
} from './forward-relay-scenario.mjs';

const digest = 'a'.repeat(64);
const original = {
  messages: [
    {
      id: 1,
      profile: { displayName: 'Original Bob', avatarDigest: digest },
      contentType: 'PURE_TEXT',
      content: '{"text":"original"}',
      sentAt: 1,
    },
  ],
  assets: [{ digest, bytes: 123 }],
};

test('uses the client carrier projection rather than a mirror-local stored bundle id', async () => {
  const row = {
    threadId: 7,
    seq: 4,
    content: JSON.stringify({ bundleId: 'local-database-id' }),
  };
  const actor = {
    async post(endpoint, body) {
      assert.equal(endpoint, '/query-messages');
      assert.deepEqual(body, { threadId: 7, after: 3, through: 4, take: 1 });
      return {
        messages: [{ seq: 4, content: JSON.stringify({ bundleId: digest }) }],
      };
    },
    async forwardBundle(bundleId) {
      assert.equal(bundleId, digest);
      return original;
    },
  };
  assert.equal(await readForwardRelayBundle(actor, row), original);
});

test('does not fall back to a stored bundle id when the carrier is not visible', async () => {
  const actor = {
    async post() {
      return { messages: [] };
    },
    async forwardBundle() {
      assert.fail('invisible carrier must not authorize a bundle');
    },
  };
  await assert.rejects(
    readForwardRelayBundle(actor, { threadId: 7, seq: 4 }),
    /must be visible/,
  );
});

function nested() {
  return {
    messages: [{ id: 1, childBundleId: 'local-child' }],
    children: [
      { id: 'local-child', messages: structuredClone(original.messages) },
    ],
    assets: structuredClone(original.assets),
  };
}

test('accepts direct and nested relays with receiver-local bundle identifiers', () => {
  assertRelaySnapshot({ ...original, children: [] }, original, 0);
  assertRelaySnapshot(nested(), original, 1);
});

for (const [label, corrupt] of [
  [
    'rewritten profile',
    (bundle) => {
      bundle.children[0].messages[0].profile.displayName = 'Current Bob';
    },
  ],
  [
    'missing descendant',
    (bundle) => {
      bundle.children = [];
    },
  ],
  [
    'missing avatar asset',
    (bundle) => {
      bundle.assets = [];
    },
  ],
  [
    'unreachable descendant',
    (bundle) => {
      delete bundle.messages[0].childBundleId;
    },
  ],
  [
    'dangling child reference',
    (bundle) => {
      bundle.messages[0].childBundleId = 'missing';
    },
  ],
  [
    'cyclic child reference',
    (bundle) => {
      bundle.children[0].messages[0].childBundleId = 'local-child';
    },
  ],
  [
    'incorrect asset bytes',
    (bundle) => {
      bundle.assets[0].bytes++;
    },
  ],
  [
    'duplicate asset',
    (bundle) => {
      bundle.assets.push(bundle.assets[0]);
    },
  ],
]) {
  test(`rejects a relay with ${label}`, () => {
    const bundle = nested();
    corrupt(bundle);
    assert.throws(
      () => assertRelaySnapshot(bundle, original, 1),
      assert.AssertionError,
    );
  });
}
