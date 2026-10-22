import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProfileDemand } from '../../../shared/profile-demand.ts';
import { federationLabNodes } from '../topology.mjs';
import {
  planWorkloadProfileRequests,
  resolveWorkloadProfiles,
} from './profile-resolution.mjs';

function fixture(messageRevs = [3, 4]) {
  const owner = {
    address: 'owner@alpha.test',
    account: 'owner',
    namespaceId: 0,
    profileNamespaceId: 0,
    role: 'OWNER',
    profileRev: 1,
  };
  const member = {
    address: 'member@bravo.test',
    account: 'member',
    namespaceId: 8,
    profileNamespaceId: 8,
    role: 'MEMBER',
    profileRev: 2,
  };
  const group = {
    address: '!group@alpha.test',
    account: '!group',
    domain: 'alpha.test',
    namespaceId: 0,
    defaultProfileRev: 1,
    threadId: 10,
    dissolved: false,
    roster: [owner, member],
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
      { ...owner, namespaceId: 17 },
      { ...member, namespaceId: 0 },
    ],
    messages: messageRevs.map((profileRev, index) => ({
      seq: index + 1,
      creatorAccount: 'owner',
      creatorAddress: owner.address,
      publisherNamespaceId: 17,
      profileNamespaceId: 0,
      profileRev,
      localState: 'READY',
      isDeleted: false,
      clientMessageId: `message-${index}`,
    })),
  });
  const profiles = Object.fromEntries(
    federationLabNodes.map(({ name }) => [name, { intentRefs: [] }]),
  );
  profiles.alpha.intentRefs.push({
    address: member.address,
    subjectType: 'USER',
    subjectAddress: owner.address,
    publisherNamespaceId: 8,
    profileNamespaceId: 0,
    profileRev: 2,
  });
  const pair = `${owner.address}|${member.address}`;
  return {
    groups,
    profiles,
    log: { groups: [group] },
    p2p: { alpha: { pairs: { active: [pair] } } },
    p2pMessages: {
      alpha: new Map([
        [
          pair,
          {
            messages: [
              {
                creatorAccount: 'member',
                publisherNamespaceId: 8,
                profileNamespaceId: 0,
                profileRev: 5,
                localState: 'READY',
                isDeleted: false,
              },
            ],
          },
        ],
      ]),
    },
  };
}

for (const revs of [[3, 4], [1], [2, 3], []]) {
  test(`uses current demands and resolves roster independently of message revisions ${JSON.stringify(revs)}`, () => {
    const requests = planWorkloadProfileRequests(fixture(revs));
    for (const { demand } of requests)
      assert.deepEqual(parseProfileDemand(demand), demand);
    assert.deepEqual(
      requests.find(({ kind }) => kind === 'P2P_MESSAGE_AUTHOR').demand,
      {
        publisherNamespaceId: 8,
        lookup: 'ACCOUNT_PROFILE',
        target: { profileNamespaceId: 0, account: 'member', rev: 5 },
      },
    );
    for (const nodeName of ['alpha', 'bravo']) {
      const roster = requests.find(
        (r) =>
          r.nodeName === nodeName &&
          r.kind === 'GROUP_MEMBER_CURRENT' &&
          r.subject === 'member@bravo.test',
      );
      assert.equal(roster.expectedRev, 2);
      assert.equal(
        roster.demand.publisherNamespaceId,
        nodeName === 'alpha' ? 8 : 0,
      );
      assert.equal(roster.demand.target.profileNamespaceId, 0);
    }
    assert.deepEqual(
      requests
        .filter(({ kind }) => kind === 'MESSAGE_AUTHOR_HISTORY')
        .map(({ expectedRev }) => expectedRev),
      revs,
    );
    for (const r of requests.filter(
      ({ kind }) => kind === 'MESSAGE_AUTHOR_HISTORY',
    )) {
      assert.equal(r.demand.publisherNamespaceId, 17);
      assert.equal(r.demand.target.profileNamespaceId, 0);
      assert.equal(r.demand.lookup, 'GROUP_MEMBER_PROFILE');
      assert.equal(r.demand.groupAccount, '!group');
    }
  });
}

test('keeps authority-scoped external member coordinates, not receiver identity namespace ids', () => {
  const value = fixture();
  const projection = value.groups.bravo.groups.get('!group@alpha.test');
  projection.roster.push({
    address: 'third@charlie.test',
    account: 'third',
    namespaceId: 2,
    profileNamespaceId: 71,
    role: 'MEMBER',
    profileRev: 6,
  });
  const request = planWorkloadProfileRequests(value).find(
    ({ subject }) => subject === 'third@charlie.test',
  );
  assert.deepEqual(request.demand, {
    publisherNamespaceId: 17,
    lookup: 'GROUP_MEMBER_PROFILE',
    groupAccount: '!group',
    target: { profileNamespaceId: 71, account: 'third', rev: 6 },
  });
});

test('rejects missing snapshot coordinates instead of inventing a namespace from display domains', () => {
  const value = fixture();
  delete value.groups.bravo.groups.get('!group@alpha.test').messages[0]
    .profileNamespaceId;
  assert.throws(() => planWorkloadProfileRequests(value), /profileNamespaceId/);
});

test('submits current demands and closes profile subscriptions', async (t) => {
  let closed = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            closed++;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const checks = await resolveWorkloadProfiles({
    ...fixture(),
    actors: {
      user: (address) => ({
        address,
        token: 'test',
        node: { backendBaseUrl: 'http://test' },
        resolveProfile: async (demand) => {
          parseProfileDemand(demand);
          return { status: 'READY', profile: { rev: demand.target.rev } };
        },
      }),
    },
    timeoutMs: 1000,
    onProgress: () => {},
  });
  assert.ok(checks.length > 0);
  assert.equal(
    closed,
    new Set(checks.map(({ actorAddress }) => actorAddress)).size,
  );
});
