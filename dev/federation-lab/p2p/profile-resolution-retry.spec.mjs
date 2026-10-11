import assert from 'node:assert/strict';
import test from 'node:test';
import { federationLabNodes } from '../topology.mjs';
import { resolveWorkloadProfiles } from './profile-resolution.mjs';

function snapshot() {
  const owner = {
    address: 'owner@alpha.test',
    account: 'owner',
    namespaceId: 0,
    profileNamespaceId: 0,
    role: 'OWNER',
    profileRev: 1,
  };
  const viewer = {
    address: 'viewer@bravo.test',
    account: 'viewer',
    namespaceId: 8,
    profileNamespaceId: 8,
    role: 'MEMBER',
    profileRev: 1,
  };
  const author = {
    address: 'author@charlie.test',
    account: 'author',
    namespaceId: 9,
    profileNamespaceId: 9,
    role: 'MEMBER',
    profileRev: 3,
  };
  const group = {
    address: '!group@alpha.test',
    account: '!group',
    namespaceId: 0,
    defaultProfileRev: 1,
    dissolved: false,
    roster: [viewer, owner, author],
    messages: [],
  };
  const groups = Object.fromEntries(
    federationLabNodes.map(({ name }) => [name, { groups: new Map() }]),
  );
  groups.alpha.groups.set(group.address, group);
  groups.bravo.groups.set(group.address, {
    ...group,
    namespaceId: 17,
    roster: [
      { ...viewer, namespaceId: 0, profileNamespaceId: 0 },
      { ...owner, namespaceId: 17 },
      { ...author, namespaceId: 2 },
    ],
  });
  const profiles = Object.fromEntries(
    federationLabNodes.map(({ name }) => [name, { intentRefs: [] }]),
  );
  return { groups, profiles, log: { groups: [group] } };
}

function clientHarness(
  t,
  {
    retryAvailable = true,
    reason = 'NOT_FOUND',
    authorityUnavailable = false,
    wrongRevision = false,
  } = {},
) {
  const streams = new Map();
  const calls = [];
  let warmed = wrongRevision;
  let authorityAvailable = false;
  let available = false;
  let closed = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const actor = options.headers.Authorization.slice('Bearer '.length);
    return new Response(
      new ReadableStream({
        start(controller) {
          streams.set(actor, controller);
        },
        cancel() {
          closed++;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const notify = (address, event, key, reason) => {
    assert.ok(streams.has(address), 'SSE must open before the client demand');
    streams
      .get(address)
      .enqueue(
        new TextEncoder().encode(
          `event: ${event}\ndata: ${JSON.stringify({ ...key, ...(reason ? { reason } : {}) })}\n\n`,
        ),
      );
  };
  const actors = {
    user: (address) => ({
      address,
      token: address,
      node: { backendBaseUrl: 'http://test' },
      async resolveProfile(demand) {
        calls.push({ address, demand: structuredClone(demand) });
        const key = {
          publisherNamespaceId: demand.publisherNamespaceId,
          ...demand.target,
        };
        if (demand.target.account !== 'author')
          return { status: 'READY', profile: { rev: demand.target.rev } };
        if (demand.lookup === 'ACCOUNT_PROFILE') {
          if (authorityUnavailable) {
            notify(address, 'PROFILE_UNAVAILABLE', key, 'NOT_FOUND');
            return { status: 'PENDING', key };
          }
          if (!authorityAvailable) {
            authorityAvailable = true;
            notify(address, 'PROFILE_AVAILABLE', key);
            return { status: 'PENDING', key };
          }
          warmed = true;
          return { status: 'READY', profile: { rev: demand.target.rev } };
        }
        if (available)
          return {
            status: 'READY',
            profile: { rev: wrongRevision ? 99 : demand.target.rev },
          };
        // Unrelated notifications must not reissue this demand or change its key.
        notify(address, 'PROFILE_AVAILABLE', {
          ...key,
          publisherNamespaceId: 18,
        });
        if (!warmed || !retryAvailable)
          notify(address, 'PROFILE_UNAVAILABLE', key, reason);
        else {
          available = true;
          notify(address, 'PROFILE_AVAILABLE', key);
        }
        return { status: 'PENDING', key };
      },
    }),
  };
  return {
    actors,
    calls,
    closed: () => closed,
    foreignCalls: () =>
      calls.filter(
        ({ demand }) =>
          demand.lookup === 'GROUP_MEMBER_PROFILE' &&
          demand.target.account === 'author',
      ),
  };
}

async function resolve(harness) {
  return resolveWorkloadProfiles({
    ...snapshot(),
    actors: harness.actors,
    timeoutMs: 1000,
    onProgress: () => {},
  });
}

test('retries a missing mirror profile once after the authority client pass, using matching SSE notifications', async (t) => {
  const harness = clientHarness(t);
  const checks = await resolve(harness);
  const foreign = harness.foreignCalls();
  assert.equal(
    foreign.length,
    3,
    'first demand, extra demand, then cached read after PROFILE_AVAILABLE',
  );
  for (const call of foreign)
    assert.deepEqual(call.demand, {
      publisherNamespaceId: 17,
      lookup: 'GROUP_MEMBER_PROFILE',
      groupAccount: '!group',
      target: { profileNamespaceId: 9, account: 'author', rev: 3 },
    });
  const authorityIndex = harness.calls.findIndex(
    ({ demand }) =>
      demand.lookup === 'ACCOUNT_PROFILE' && demand.target.account === 'author',
  );
  assert.ok(harness.calls.indexOf(foreign[0]) < authorityIndex);
  assert.ok(authorityIndex < harness.calls.indexOf(foreign[1]));
  assert.equal(
    harness.calls.filter(
      ({ demand }) =>
        demand.lookup === 'ACCOUNT_PROFILE' &&
        demand.target.account === 'author',
    ).length,
    2,
    'authority demand also waits for PROFILE_AVAILABLE before reading READY',
  );
  assert.ok(
    checks.some(
      ({ demand, profile }) =>
        demand.lookup === 'GROUP_MEMBER_PROFILE' &&
        demand.target.account === 'author' &&
        profile.rev === 3,
    ),
  );
  assert.equal(harness.closed(), 2);
});

test('fails when the extra mirror demand also reports NOT_FOUND through SSE', async (t) => {
  const harness = clientHarness(t, { retryAvailable: false });
  await assert.rejects(resolve(harness), /reason=NOT_FOUND/);
  assert.equal(harness.foreignCalls().length, 2);
  assert.equal(harness.closed(), 2);
});

test('does not retry disclosure denial on a mirror', async (t) => {
  const harness = clientHarness(t, { reason: 'NOT_DISCLOSED' });
  await assert.rejects(resolve(harness), /reason=NOT_DISCLOSED/);
  assert.equal(harness.foreignCalls().length, 1);
  assert.equal(harness.closed(), 1);
});

test('does not defer a missing authority profile or retry the queued mirror after it fails', async (t) => {
  const harness = clientHarness(t, { authorityUnavailable: true });
  await assert.rejects(resolve(harness), /reason=NOT_FOUND/);
  assert.equal(harness.foreignCalls().length, 1);
  assert.equal(harness.closed(), 2);
});

test('does not retry or accept a wrong revision following PROFILE_AVAILABLE', async (t) => {
  const harness = clientHarness(t, { wrongRevision: true });
  await assert.rejects(resolve(harness), /returned rev 99, expected 3/);
  assert.equal(
    harness.foreignCalls().length,
    2,
    'one demand and one cached read, not an extra attempt',
  );
  assert.equal(harness.closed(), 1);
});
