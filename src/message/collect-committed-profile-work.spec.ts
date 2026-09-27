import { describe, expect, it } from 'vitest';
import {
  collectCommittedProfileWork,
  type CommittedProfileMessage,
} from './collect-committed-profile-work.js';

const alice = { account: 'alice', domain: 'local', namespaceId: 0 };
const bob = { account: 'bob', domain: 'remote.test', namespaceId: 3 };

function committed(
  seq: number,
  profileRev: number,
  options: Partial<CommittedProfileMessage> = {},
): CommittedProfileMessage {
  return {
    threadId: 11,
    threadType: 'P2P',
    content: JSON.stringify({ text: 'hello' }),
    seq,
    profileRev,
    creator: alice,
    contentType: 'PURE_TEXT',
    isDeleted: false,
    localState: 'READY',
    ...options,
  };
}

describe('collectCommittedProfileWork', () => {
  it('returns one greatest message per thread and full author address, not greatest rev', () => {
    const selected = collectCommittedProfileWork([
      committed(2, 30),
      committed(4, 0),
      committed(3, 40),
      committed(8, 7, { creator: bob }),
      committed(9, 4, { creator: { ...bob, namespaceId: 4 } }),
      committed(5, 1, { threadId: 12 }),
    ]);
    expect(selected).toEqual({
      demands: [
        {
          namespaceId: 0,
          lookup: 'ACCOUNT_PROFILE',
          target: { account: 'alice', domain: 'local', rev: 0 },
        },
        {
          namespaceId: 3,
          lookup: 'ACCOUNT_PROFILE',
          target: { account: 'bob', domain: 'remote.test', rev: 7 },
        },
        {
          namespaceId: 4,
          lookup: 'ACCOUNT_PROFILE',
          target: { account: 'bob', domain: 'remote.test', rev: 4 },
        },
        {
          namespaceId: 0,
          lookup: 'ACCOUNT_PROFILE',
          target: { account: 'alice', domain: 'local', rev: 1 },
        },
      ],
      evidenceProjections: [
        {
          profile: { namespaceId: 0, account: 'alice', domain: 'local', rev: 0 },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 11, messageSeq: 4 },
        },
        {
          profile: { namespaceId: 3, account: 'bob', domain: 'remote.test', rev: 7 },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 11, messageSeq: 8 },
        },
        {
          profile: { namespaceId: 4, account: 'bob', domain: 'remote.test', rev: 4 },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 11, messageSeq: 9 },
        },
        {
          profile: { namespaceId: 0, account: 'alice', domain: 'local', rev: 1 },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 12, messageSeq: 5 },
        },
      ],
    });
  });

  it('ignores deleted rows, uncommitted placeholders and malformed events', () => {
    expect(
      collectCommittedProfileWork([
        committed(10, 5),
        committed(11, 6, { localState: 'STUB' }),
        committed(12, 7, { localState: 'FAILED' }),
        committed(13, 8, { isDeleted: true }),
        committed(14, 9, { contentType: 'SYSTEM', content: '{invalid' }),
        committed(15, 10, { contentType: 'SYSTEM', content: '{invalid' }),
      ]),
    ).toEqual({
      demands: [
        {
          namespaceId: 0,
          lookup: 'ACCOUNT_PROFILE',
          target: { account: 'alice', domain: 'local', rev: 5 },
        },
      ],
      evidenceProjections: [
        {
          profile: { namespaceId: 0, account: 'alice', domain: 'local', rev: 5 },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 11, messageSeq: 10 },
        },
      ],
    });
  });

  it('uses intent prefetch for a remote friend-add participant', () => {
    const participants = [
      { ...alice, profileRev: 3 },
      { ...bob, profileRev: 7 },
    ];
    const system = (seq: number, revision: number) =>
      committed(seq, 0, {
        creator: { account: '$system', domain: 'local', namespaceId: 0 },
        contentType: 'SYSTEM',
        content: JSON.stringify({
          type: 'FRIEND_ADDED',
          participants: [
            revision === 2
              ? { ...participants[0], profileRev: 0 }
              : participants[0],
            { ...participants[1], profileRev: revision },
          ],
        }),
      });
    expect(
      collectCommittedProfileWork([
        system(4, 7),
        system(6, 7),
        system(8, 2),
      ]),
    ).toEqual({
      demands: [
        {
          lookup: 'RELATIONSHIP_INTENT_PROFILE',
          namespaceId: 3,
          target: { account: 'bob', domain: 'remote.test', rev: 7 },
          peerAccount: 'alice',
        },
        {
          lookup: 'RELATIONSHIP_INTENT_PROFILE',
          namespaceId: 3,
          target: { account: 'bob', domain: 'remote.test', rev: 2 },
          peerAccount: 'alice',
        },
      ],
      evidenceProjections: [],
    });
  });

  it('returns group-member hints without turning a system seq into projection evidence', () => {
    const member = { ...bob, profileRev: 4 };
    const selected = collectCommittedProfileWork([
      committed(2, 10, {
        threadType: 'GROUP',
        groupAccount: '!group',
        groupOriginDomain: 'group-owner.test',
        creator: bob,
      }),
      committed(3, 0, {
        threadType: 'GROUP',
        groupAccount: '!group',
        groupOriginDomain: 'group-owner.test',
        contentType: 'SYSTEM',
        creator: { account: '$system', domain: 'local', namespaceId: 0 },
        content: JSON.stringify({ type: 'GROUP_JOINED', member }),
      }),
      committed(4, 0, {
        threadType: 'GROUP',
        groupAccount: '!group',
        groupOriginDomain: 'group-owner.test',
        contentType: 'SYSTEM',
        content: JSON.stringify({
          type: 'GROUP_OWNER_TRANSFERRED',
          previousOwner: { ...alice, profileRev: 0 },
          newOwner: member,
        }),
      }),
      committed(5, 0, {
        threadType: 'GROUP',
        groupAccount: '!group',
        groupOriginDomain: 'group-owner.test',
        contentType: 'SYSTEM',
        content: JSON.stringify({ type: 'GROUP_DISSOLVED' }),
      }),
    ]);
    expect(selected).toEqual({
      demands: [
        {
          namespaceId: 3,
          lookup: 'GROUP_MEMBER_PROFILE',
          groupAccount: '!group',
          target: { account: 'bob', domain: 'remote.test', rev: 10 },
        },
        {
          lookup: 'GROUP_MEMBER_PROFILE',
          namespaceId: 3,
          target: { account: 'bob', domain: 'remote.test', rev: 4 },
          groupAccount: '!group',
        },
      ],
      evidenceProjections: [
        {
          profile: { namespaceId: 3, account: 'bob', domain: 'remote.test', rev: 10 },
          lookup: 'GROUP_MEMBER_PROFILE',
          groupAccount: '!group',
          projection: { threadId: 11, messageSeq: 2 },
        },
      ],
    });
  });

  it('does not prefetch local members, own-group members, departures or unfriends', () => {
    const groupEvent = (
      seq: number,
      origin: string,
      type: string,
      member: object,
    ) =>
      committed(seq, 0, {
        threadType: 'GROUP',
        groupAccount: '!group',
        groupOriginDomain: origin,
        contentType: 'SYSTEM',
        content: JSON.stringify({ type, member }),
      });
    expect(
      collectCommittedProfileWork([
        groupEvent(1, 'local', 'GROUP_JOINED', { ...bob, profileRev: 3 }),
        groupEvent(2, 'group-owner.test', 'GROUP_JOINED', {
          ...alice,
          profileRev: 4,
        }),
        groupEvent(3, 'group-owner.test', 'GROUP_JOINED', {
          ...bob,
          profileRev: 0,
        }),
        groupEvent(4, 'group-owner.test', 'GROUP_LEFT', {
          ...bob,
          profileRev: 3,
        }),
        committed(5, 0, {
          contentType: 'SYSTEM',
          content: JSON.stringify({
            type: 'FRIEND_REMOVED',
            initiator: { ...alice, profileRev: 0 },
            participants: [
              { ...alice, profileRev: 4 },
              { ...bob, profileRev: 3 },
            ],
          }),
        }),
      ]),
    ).toEqual({ demands: [], evidenceProjections: [] });
  });

  it('does not invent a candidate from an empty batch', () => {
    expect(collectCommittedProfileWork([])).toEqual({
      demands: [],
      evidenceProjections: [],
    });
  });
});
