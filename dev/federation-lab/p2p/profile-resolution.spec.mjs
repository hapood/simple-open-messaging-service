import assert from 'node:assert/strict';
import test from 'node:test';
import { isProfileSelector } from '../../../shared/profile-selector.ts';
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
    profiles.alpha.intentRefs.push({
      address: member.address,
      subjectType: 'USER',
      subjectAddress: owner.address,
      profileRev: 2,
    });
    const pair = `${owner.address}|${member.address}`;
    const checks = await resolveWorkloadProfiles({
      actors: {
        user: (address) => ({
          address,
          token: 'test-token',
          node: federationLabNodes.find((node) =>
            address.endsWith(`@${node.domain}`),
          ),
          resolveProfile: async (selector) => {
            assert.ok(
              isProfileSelector(selector),
              `invalid API selector: ${JSON.stringify(selector)}`,
            );
            return {
              status: 'READY',
              profile: {
                rev:
                  selector.type === 'EXACT'
                    ? selector.rev
                    : selector.type === 'MESSAGE_AUTHOR'
                      ? selector.threadId === 20
                        ? 5
                        : messageRevs[selector.messageSeq - 1]
                      : selector.memberAccount === member.account
                        ? 2
                        : 1,
              },
            };
          },
        }),
      },
      groups,
      profiles,
      p2p: { alpha: { pairs: { active: [pair] } } },
      p2pMessages: {
        alpha: new Map([
          [
            pair,
            {
              threadId: 20,
              messages: [
                {
                  seq: 1,
                  profileRev: 5,
                  localState: 'READY',
                  isDeleted: false,
                },
              ],
            },
          ],
        ]),
      },
      log: { groups: [{ address: group.address }] },
      timeoutMs: 1000,
      onProgress: () => {},
    });
    assert.deepEqual(
      checks.find((check) => check.kind === 'P2P_MESSAGE_AUTHOR')?.selector,
      { type: 'MESSAGE_AUTHOR', threadId: 20, messageSeq: 1 },
    );
    assert.deepEqual(
      checks.find((check) => check.kind === 'RELATIONSHIP_CURRENT')?.selector,
      { type: 'EXACT', account: member.account, domain: 'bravo.test', rev: 2 },
    );
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
