import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeIdentityTransitionCheckpoint,
  prepareIdentityTransitionPeers,
} from './identity-transition.mjs';

function fixture(inspect = (peer) => peer) {
  const domains = new Map([
    ['alpha', 'alpha.test'],
    ['bravo', 'bravo.test'],
    ['charlie', 'charlie.test'],
  ]);
  const calls = [];
  const peers = new Map();
  const actors = {
    nodes: new Map(
      [...domains].map(([name, domain]) => [
        name,
        {
          topology: { name },
          admin: {
            async post(endpoint) {
              calls.push({ observer: domain, endpoint });
              const match = endpoint.match(
                /^\/admin\/federation\/peers\/([^/]+)(\/recognize)?$/,
              );
              assert.ok(match, `unexpected endpoint ${endpoint}`);
              const peerDomain = decodeURIComponent(match[1]);
              const key = `${domain}->${peerDomain}`;
              if (match[2]) {
                peers.set(key, {
                  active: true,
                  rootPublicKey: `root-${peerDomain}`,
                  identityPinnedAt: '2026-10-11T00:00:00Z',
                  trustLevel: 'available',
                });
                return { status: 'recognized' };
              }
              return inspect(peers.get(key), calls);
            },
          },
        },
      ]),
    ),
  };
  return { actors, domains, calls };
}

const silent = () => {};

test('establishes every directed pair, including the missing alpha-charlie edge, before checking pins', async () => {
  const { actors, domains, calls } = fixture();
  const pins = await prepareIdentityTransitionPeers({
    actors,
    domains,
    timeoutMs: 1000,
    onProgress: silent,
  });
  assert.equal(pins.length, 6);
  assert.equal(calls.length, 12);
  assert.ok(
    calls.slice(0, 6).every((call) => call.endpoint.endsWith('/recognize')),
  );
  assert.ok(
    calls.slice(6).every((call) => !call.endpoint.endsWith('/recognize')),
  );
  assert.ok(
    pins.some(
      (pin) => pin.observer === 'charlie.test' && pin.peer === 'alpha.test',
    ),
  );
  assert.equal(
    new Set(pins.map((pin) => `${pin.observer}->${pin.peer}`)).size,
    6,
  );
});

for (const [label, patch] of [
  ['missing root pin', { rootPublicKey: null }],
  ['missing pin timestamp', { identityPinnedAt: null }],
  ['inactive identity', { active: false }],
  ['unavailable peer', { trustLevel: 'establishing' }],
]) {
  test(`rejects ${label} even after recognition returns successfully`, async () => {
    const { actors, domains } = fixture((peer) => ({ ...peer, ...patch }));
    await assert.rejects(
      prepareIdentityTransitionPeers({
        actors,
        domains,
        timeoutMs: 1,
        onProgress: silent,
      }),
      /to be pinned and available .* before identity transitions/,
    );
  });
}

test('a failed prerequisite aborts the checkpoint before any root rotation or domain restart', async () => {
  const previous = process.env.FED_LAB_CONTROL_DIR;
  process.env.FED_LAB_CONTROL_DIR = '/unused-control-dir';
  try {
    const { actors, calls } = fixture((peer) => ({
      ...peer,
      rootPublicKey: null,
    }));
    const log = {};
    await assert.rejects(
      executeIdentityTransitionCheckpoint({
        actors,
        log,
        timeoutMs: 1,
        onProgress: silent,
      }),
      /before identity transitions/,
    );
    assert.equal(log.identityTransitions.status, 'FAILED');
    assert.equal(log.identityTransitions.certificateOnly, null);
    assert.equal(calls.length, 7);
  } finally {
    if (previous === undefined) delete process.env.FED_LAB_CONTROL_DIR;
    else process.env.FED_LAB_CONTROL_DIR = previous;
  }
});
