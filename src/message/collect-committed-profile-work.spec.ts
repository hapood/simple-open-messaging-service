import { describe, expect, it } from 'vitest';
import {
  collectCommittedProfileWork,
  type CommittedProfileMessage,
} from './collect-committed-profile-work.js';

const aliceCreator = {
  account: 'alice',
  profileNamespaceId: 0,
  profileRev: 0,
};
const bobCreator = {
  account: 'bob',
  profileNamespaceId: 3,
  profileRev: 7,
};
const aliceParticipant = {
  account: 'alice',
  publisherNamespaceId: 0,
  profileNamespaceId: 0,
};
const bobParticipant = {
  account: 'bob',
  publisherNamespaceId: 3,
  profileNamespaceId: 0,
};
const bobGroupParticipant = {
  account: 'bob',
  publisherNamespaceId: 3,
  profileNamespaceId: 3,
};

function committed(
  seq: number,
  creatorProfileRev: number,
  options: Partial<CommittedProfileMessage> = {},
): CommittedProfileMessage {
  const creator = {
    ...aliceCreator,
    ...(options.creator ?? {}),
    profileRev: options.creator?.profileRev ?? creatorProfileRev,
  };
  return {
    threadId: 11,
    seq,
    threadType: 'P2P',
    publisherNamespaceId: 0,
    contentType: 'PURE_TEXT',
    content: JSON.stringify({ text: 'hello' }),
    isDeleted: false,
    localState: 'READY',
    ...options,
    creator,
  };
}

describe('collectCommittedProfileWork', () => {
  it('returns one greatest message per thread and full author address, not greatest rev', () => {
    const selected = collectCommittedProfileWork([
      committed(2, 30),
      committed(4, 0),
      committed(3, 40),
      committed(8, 7, {
        publisherNamespaceId: 3,
        creator: bobCreator,
      }),
      committed(9, 4, {
        publisherNamespaceId: 4,
        creator: { ...bobCreator, profileNamespaceId: 4, profileRev: 4 },
      }),
      committed(5, 1, { threadId: 12 }),
    ]);
    expect(selected).toEqual({
      demands: [
        {
          publisherNamespaceId: 0,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 0, account: 'alice', rev: 0 },
        },
        {
          publisherNamespaceId: 3,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 3, account: 'bob', rev: 7 },
        },
        {
          publisherNamespaceId: 4,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 4, account: 'bob', rev: 4 },
        },
        {
          publisherNamespaceId: 0,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 0, account: 'alice', rev: 1 },
        },
      ],
      evidenceProjections: [
        {
          profile: {
            publisherNamespaceId: 0,
            profileNamespaceId: 0,
            account: 'alice',
            rev: 0,
          },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 11, messageSeq: 4 },
        },
        {
          profile: {
            publisherNamespaceId: 3,
            profileNamespaceId: 3,
            account: 'bob',
            rev: 7,
          },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 11, messageSeq: 8 },
        },
        {
          profile: {
            publisherNamespaceId: 4,
            profileNamespaceId: 4,
            account: 'bob',
            rev: 4,
          },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 11, messageSeq: 9 },
        },
        {
          profile: {
            publisherNamespaceId: 0,
            profileNamespaceId: 0,
            account: 'alice',
            rev: 1,
          },
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
          publisherNamespaceId: 0,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 0, account: 'alice', rev: 5 },
        },
      ],
      evidenceProjections: [
        {
          profile: {
            publisherNamespaceId: 0,
            profileNamespaceId: 0,
            account: 'alice',
            rev: 5,
          },
          lookup: 'ACCOUNT_PROFILE',
          projection: { threadId: 11, messageSeq: 10 },
        },
      ],
    });
  });

  it('uses account prefetch for a remote friend-add participant', () => {
    const participants = [
      { ...aliceParticipant, profileRev: 3 },
      { ...bobParticipant, profileRev: 7 },
    ];
    const system = (seq: number, revision: number) =>
      committed(seq, 0, {
        publisherNamespaceId: 3,
        creator: {
          account: '$system',
          profileNamespaceId: 0,
          profileRev: 0,
        },
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
      collectCommittedProfileWork([system(4, 7), system(6, 7), system(8, 2)]),
    ).toEqual({
      demands: [
        {
          publisherNamespaceId: 3,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 0, account: 'bob', rev: 7 },
        },
        {
          publisherNamespaceId: 3,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 0, account: 'bob', rev: 2 },
        },
      ],
      evidenceProjections: [],
    });
  });

  it('returns group-member hints without turning a system seq into projection evidence', () => {
    const member = { ...bobGroupParticipant, profileRev: 4 };
    const selected = collectCommittedProfileWork([
      committed(2, 10, {
        threadType: 'GROUP',
        publisherNamespaceId: 3,
        groupAccount: '!group',
        creator: { ...bobCreator, profileRev: 10 },
      }),
      committed(3, 0, {
        threadType: 'GROUP',
        publisherNamespaceId: 3,
        groupAccount: '!group',
        contentType: 'SYSTEM',
        creator: {
          account: '$system',
          profileNamespaceId: 0,
          profileRev: 0,
        },
        content: JSON.stringify({ type: 'GROUP_JOINED', member }),
      }),
      committed(4, 0, {
        threadType: 'GROUP',
        publisherNamespaceId: 3,
        groupAccount: '!group',
        contentType: 'SYSTEM',
        creator: {
          account: '$system',
          profileNamespaceId: 0,
          profileRev: 0,
        },
        content: JSON.stringify({
          type: 'GROUP_OWNER_TRANSFERRED',
          previousOwner: { ...aliceParticipant, profileRev: 0 },
          newOwner: member,
        }),
      }),
      committed(5, 0, {
        threadType: 'GROUP',
        publisherNamespaceId: 3,
        groupAccount: '!group',
        contentType: 'SYSTEM',
        content: JSON.stringify({ type: 'GROUP_DISSOLVED' }),
      }),
    ]);
    expect(selected).toEqual({
      demands: [
        {
          publisherNamespaceId: 3,
          lookup: 'GROUP_MEMBER_PROFILE',
          groupAccount: '!group',
          target: { profileNamespaceId: 3, account: 'bob', rev: 10 },
        },
        {
          publisherNamespaceId: 3,
          lookup: 'GROUP_MEMBER_PROFILE',
          target: { profileNamespaceId: 3, account: 'bob', rev: 4 },
          groupAccount: '!group',
        },
      ],
      evidenceProjections: [
        {
          profile: {
            publisherNamespaceId: 3,
            profileNamespaceId: 3,
            account: 'bob',
            rev: 10,
          },
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
      publisherNamespaceId: number,
      type: string,
      member: object,
    ) =>
      committed(seq, 0, {
        threadType: 'GROUP',
        publisherNamespaceId,
        groupAccount: '!group',
        creator: {
          account: '$system',
          profileNamespaceId: 0,
          profileRev: 0,
        },
        contentType: 'SYSTEM',
        content: JSON.stringify({ type, member }),
      });
    expect(
      collectCommittedProfileWork([
        groupEvent(1, 0, 'GROUP_JOINED', {
          ...bobGroupParticipant,
          publisherNamespaceId: 0,
          profileRev: 3,
        }),
        groupEvent(2, 3, 'GROUP_JOINED', {
          ...aliceParticipant,
          profileRev: 4,
        }),
        groupEvent(3, 3, 'GROUP_JOINED', {
          ...bobGroupParticipant,
          profileRev: 0,
        }),
        groupEvent(4, 3, 'GROUP_LEFT', {
          ...bobGroupParticipant,
          profileRev: 3,
        }),
        committed(5, 0, {
          contentType: 'SYSTEM',
          content: JSON.stringify({
            type: 'FRIEND_REMOVED',
            initiator: { ...aliceParticipant, profileRev: 0 },
            participants: [
              { ...aliceParticipant, profileRev: 4 },
              { ...bobParticipant, profileRev: 3 },
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
