import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRelaySnapshot } from './forward-relay-scenario.mjs';

const digest = 'a'.repeat(64);
const original = {
  messages: [
    {
      id: 1,
      author: { account: 'bob', domain: 'bravo.test' },
      profile: { displayName: 'Original Bob', avatarDigest: digest },
      contentType: 'PURE_TEXT',
      content: '{"text":"original"}',
      sentAt: 1,
    },
  ],
  assets: [{ digest, bytes: 123 }],
};

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
    'lost author',
    (bundle) => {
      bundle.children[0].messages[0].author.domain = 'alpha.test';
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
