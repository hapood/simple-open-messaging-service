import { describe, expect, it } from 'vitest';
import {
  applyFriendIntentToProjection,
  applyGroupIntentToProjection,
  friendRequestKey,
  groupRequestKey,
  markProjectionAccepted,
  projectionDirectionForFact,
  type FriendIntentProjectionInput,
  type GroupInviteProjectionInput,
} from './friend-request-state';

const friendInput: FriendIntentProjectionInput = {
  namespaceId: 12,
  account: 'alice',
  subjectAccount: 'bob',
  subjectNamespaceId: 12,
  status: 'REQUESTED',
  direction: 'OUTGOING',
  localThreadId: 7,
  note: 'hello',
  requestedAt: 1_000,
  expiresAt: 10_000,
  peer: {
    namespaceId: 12,
    id: 2,
    account: 'bob',
    domain: 'remote.test',
    name: 'Bob',
    avatar: '',
    bio: '',
  },
};

const groupInput: GroupInviteProjectionInput = {
  namespaceId: 0,
  status: 'REQUESTED',
  note: '',
  requestedAt: 1_000,
  expiresAt: 10_000,
  direction: 'INCOMING',
  threadId: 9,
  group: {
    namespaceId: 0,
    account: '!group',
    name: 'Group',
    avatar: '',
    description: '',
    profileRev: 1,
  },
};

describe('request projection effects', () => {
  it('upserts a directional friend request without storing the reverse fact', () => {
    const result = applyFriendIntentToProjection(undefined, friendInput, 2_000);
    expect(result.record).toMatchObject({
      key: friendRequestKey(friendInput, 'OUTGOING'),
      direction: 'OUTGOING',
      status: 'REQUESTED',
      expiresAt: 10_000,
    });
    expect(result.record).not.toHaveProperty('local');
    expect(result.record).not.toHaveProperty('remote');
  });

  it('treats a locally authored ACK as a projection no-op', () => {
    expect(
      applyFriendIntentToProjection(
        undefined,
        { ...friendInput, status: 'ACCEPTED' },
        2_000,
      ),
    ).toEqual({ record: null, becameActionable: false });
    expect(
      projectionDirectionForFact({
        status: 'ACCEPTED',
        direction: 'OUTGOING',
      }),
    ).toBeNull();
  });

  it('lets a remote ACK update only a live outgoing request', () => {
    const request = applyFriendIntentToProjection(
      undefined,
      friendInput,
      2_000,
    ).record!;
    const accepted = applyFriendIntentToProjection(
      request,
      { ...friendInput, status: 'ACCEPTED', direction: 'INCOMING' },
      3_000,
    ).record;
    expect(accepted?.status).toBe('ACCEPTED');
    expect(
      applyFriendIntentToProjection(
        { ...request, expiresAt: 3_000 },
        { ...friendInput, status: 'ACCEPTED', direction: 'INCOMING' },
        3_000,
      ).record?.status,
    ).toBe('REQUESTED');
  });

  it('persists a local accept only as a side effect on a live incoming request', () => {
    const incoming = applyFriendIntentToProjection(
      undefined,
      { ...friendInput, direction: 'INCOMING' },
      2_000,
    ).record!;
    expect(markProjectionAccepted(incoming, 3_000)).toMatchObject({
      key: incoming.key,
      bucket: 'RECEIVED',
      direction: 'INCOMING',
      status: 'ACCEPTED',
      updatedAt: 3_000,
    });
    expect(
      markProjectionAccepted({ ...incoming, expiresAt: 2_000 }, 3_000),
    ).toEqual({ ...incoming, expiresAt: 2_000 });
  });

  it('does not manufacture history for a missing revocation', () => {
    expect(
      applyFriendIntentToProjection(
        undefined,
        { ...friendInput, status: 'REVOKED' },
        2_000,
      ),
    ).toEqual({ record: null, becameActionable: false });
  });

  it('uses the same side-effect rules and shape for group requests', () => {
    const request = applyGroupIntentToProjection(
      undefined,
      groupInput,
      2_000,
    ).record!;
    expect(request).toMatchObject({
      key: groupRequestKey(0, '!group', 'INCOMING'),
      kind: 'GROUP',
      direction: 'INCOMING',
      status: 'REQUESTED',
    });
    expect(
      applyGroupIntentToProjection(
        request,
        { ...groupInput, status: 'REVOKED', requestStatus: 'WITHDRAWN' },
        3_000,
      ).record?.status,
    ).toBe('WITHDRAWN');
  });
  it.each(['WITHDRAWN', 'REJECTED'] as const)(
    'persists %s across replay and resets it only for a new request',
    (requestStatus) => {
      const requested = applyGroupIntentToProjection(
        undefined,
        groupInput,
        2_000,
      ).record!;
      const terminal = applyGroupIntentToProjection(
        requested,
        {
          ...groupInput,
          status: 'REVOKED',
          requestStatus,
        },
        3_000,
      ).record!;
      expect(terminal.status).toBe(requestStatus);
      const reloaded = JSON.parse(JSON.stringify(terminal));
      expect(
        applyGroupIntentToProjection(
          reloaded,
          {
            ...groupInput,
            status: 'REVOKED',
            requestStatus:
              requestStatus === 'REJECTED' ? 'WITHDRAWN' : 'REJECTED',
          },
          4_000,
        ).record,
      ).toEqual(terminal);
      const next = applyGroupIntentToProjection(
        terminal,
        {
          ...groupInput,
          requestedAt: 5_000,
          expiresAt: 15_000,
        },
        6_000,
      ).record!;
      expect(next.status).toBe('REQUESTED');
      expect(next.requestedAt).toBe(5_000);

      const friend = applyFriendIntentToProjection(
        undefined,
        friendInput,
        2_000,
      ).record!;
      const closedFriend = applyFriendIntentToProjection(
        friend,
        {
          ...friendInput,
          status: 'REVOKED',
          requestStatus,
        },
        3_000,
      ).record!;
      expect(closedFriend.status).toBe(requestStatus);
      expect(
        applyFriendIntentToProjection(
          closedFriend,
          {
            ...friendInput,
            status: 'REVOKED',
          },
          4_000,
        ).record,
      ).toEqual(closedFriend);
    },
  );
});
