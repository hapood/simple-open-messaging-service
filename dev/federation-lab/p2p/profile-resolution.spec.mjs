import assert from 'node:assert/strict';
import test from 'node:test';
import { federationLabNodes } from '../topology.mjs';
import { resolveWorkloadProfiles } from './profile-resolution.mjs';

for (const messageRevs of [[3, 4], [1], [2, 3], []]) {
  test(`resolves the roster revision independently of message revisions ${JSON.stringify(messageRevs)}`, async (t) => {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(new ReadableStream(), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const owner = {
      address: 'owner@alpha.test',
      account: 'owner',
      role: 'OWNER',
      profileRev: 1,
    };
    const member = {
      address: 'member@bravo.test',
      account: 'member',
      role: 'MEMBER',
      profileRev: 2,
    };
    const group = {
      address: '!group@alpha.test',
      account: '!group',
      domain: 'local',
      defaultProfileRev: 1,
      threadId: 10,
      dissolved: false,
      roster: [owner, member],
      messages: messageRevs.map((profileRev, index) => ({
        seq: index + 1,
        clientMessageId: `message-${index}`,
        creatorAddress: member.address,
        localState: 'READY',
        isDeleted: false,
        profileRev,
      })),
    };
    const groups = Object.fromEntries(
      federationLabNodes.map(({ name }) => [name, { groups: new Map() }]),
    );
    groups.alpha.groups.set(group.address, group);
    groups.bravo.groups.set(group.address, { ...group, domain: 'alpha.test' });
    const profiles = Object.fromEntries(
      federationLabNodes.map(({ name }) => [name, { intentRefs: [] }]),
    );
    const checks = await resolveWorkloadProfiles({
      actors: {
        user: (address) => ({
          address,
          token: 'test-token',
          node: federationLabNodes.find((node) =>
            address.endsWith(`@${node.domain}`),
          ),
          resolveProfile: async (selector) => ({
            status: 'READY',
            profile: {
              rev:
                'messageSeq' in selector
                  ? messageRevs[selector.messageSeq - 1]
                  : selector.memberAccount === member.account
                    ? 2
                    : 1,
            },
          }),
        }),
      },
      groups,
      profiles,
      log: { groups: [{ address: group.address }] },
      timeoutMs: 1000,
      onProgress: () => {},
    });
    for (const nodeName of ['alpha', 'bravo']) {
      const roster = checks.find(
        (check) =>
          check.nodeName === nodeName &&
          check.kind === 'GROUP_MEMBER_CURRENT' &&
          check.subject === member.address,
      );
      assert.ok(
        roster,
        `${nodeName} must resolve the roster even if the member has messages`,
      );
      assert.equal(roster.expectedRev, 2);
      assert.equal(
        roster.selector.memberDomain,
        nodeName === 'bravo' ? 'local' : 'bravo.test',
      );
      assert.deepEqual(
        checks
          .filter(
            (check) =>
              check.nodeName === nodeName &&
              check.kind === 'MESSAGE_AUTHOR_HISTORY',
          )
          .map((check) => check.expectedRev),
        messageRevs,
      );
    }
  });
}
