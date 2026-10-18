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
  snapshot: { displayName: 'Bob at send time', avatar: null },
  namespaceId: 12,
  account: 'alice',
  subjectAccount: 'bob',
  subjectNamespaceId: 12,
  feedId: 1,
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
    avatar: '',
    bio: '',
  },
};

const groupInput: GroupInviteProjectionInput = {
  snapshot: null,
  namespaceId: 0,
  feedId: 1,
  status: 'REQUESTED',
  note: '',
  requestedAt: 1_000,
  expiresAt: 10_000,
  direction: 'INCOMING',
  threadId: 9,
  group: {
    namespaceId: 0,
    account: '!group',
    profileRev: 1,
  },
};

describe('request projection effects', () => {
  it('keeps sent presentation independent of peer profile revisions and preserves it on rejection', () => {
    const first = applyFriendIntentToProjection(undefined, friendInput, 2_000).record!;
    const refreshed = applyFriendIntentToProjection(first, {
      ...friendInput, feedId: 2, peer: { ...friendInput.peer, profileRev: 7 },
    }, 2_500).record!;
    expect(refreshed.snapshot).toEqual(first.snapshot);
    const rejected = applyFriendIntentToProjection(refreshed, {
      ...friendInput, feedId: 3, status: 'REVOKED', direction: 'INCOMING',
      requestStatus: 'REJECTED', requestDirection: 'OUTGOING', snapshot: null,
    }, 3_000).record!;
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.snapshot).toEqual(friendInput.snapshot);
    expect(applyFriendIntentToProjection(rejected, friendInput, 4_000).record).toEqual(rejected);
  });
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
      { ...friendInput, feedId: 2, status: 'ACCEPTED', direction: 'INCOMING' },
      3_000,
    ).record;
    expect(accepted?.status).toBe('ACCEPTED');
    expect(
      applyFriendIntentToProjection(
        { ...request, expiresAt: 3_000 },
        {
          ...friendInput,
          feedId: 2,
          status: 'ACCEPTED',
          direction: 'INCOMING',
        },
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
        {
          ...groupInput,
          feedId: 2,
          status: 'REVOKED',
          requestStatus: 'WITHDRAWN',
        },
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
          feedId: 2,
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
            feedId: 1,
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
          feedId: 4,
          requestedAt: 5_000,
          expiresAt: 15_000,
        },
        6_000,
      ).record!;
      expect(next.status).toBe('REQUESTED');
      expect(next.requestedAt).toBe(5_000);
      expect(next.sourceFeedId).toBe(4);

      const friend = applyFriendIntentToProjection(
        undefined,
        friendInput,
        2_000,
      ).record!;
      const closedFriend = applyFriendIntentToProjection(
        friend,
        {
          ...friendInput,
          feedId: 2,
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
            feedId: 1,
            status: 'REVOKED',
          },
          4_000,
        ).record,
      ).toEqual(closedFriend);
    },
  );

  it('lets a newer REQUESTED fact replace an older terminal projection', () => {
    const request = applyFriendIntentToProjection(
      undefined,
      friendInput,
      2_000,
    ).record!;
    const accepted = applyFriendIntentToProjection(
      request,
      { ...friendInput, feedId: 2, status: 'ACCEPTED', direction: 'INCOMING' },
      3_000,
    ).record!;
    const renewed = applyFriendIntentToProjection(
      accepted,
      { ...friendInput, feedId: 3, requestedAt: 3_000, expiresAt: 13_000 },
      4_000,
    ).record!;
    expect(renewed.status).toBe('REQUESTED');
    expect(renewed.sourceFeedId).toBe(3);
    expect(
      applyFriendIntentToProjection(
        renewed,
        {
          ...friendInput,
          feedId: 2,
          status: 'ACCEPTED',
          direction: 'INCOMING',
        },
        5_000,
      ).record,
    ).toEqual(renewed);
  });
});

describe('friend key derivation over wire-contract coordinates', () => {
  // Server contract for one federated pair: every RELATIONSHIP_INTENT item
  // carries the pair namespace in namespaceId, subjectNamespaceId is the
  // subject endpoint's home namespace, and the local user is always
  // namespace 0 — so the author's home namespace only appears on the wire
  // (as namespaceId) when the author is the remote peer.
  const sendEcho = {
    namespaceId: 12,
    account: 'bravo',
    subjectAccount: 'admin',
    subjectNamespaceId: 12,
    direction: 'OUTGOING' as const,
  };
  const peerRequest = {
    namespaceId: 12,
    account: 'admin',
    subjectAccount: 'bravo',
    subjectNamespaceId: 0,
    direction: 'INCOMING' as const,
  };
  const peerAccept = { ...peerRequest, status: 'ACCEPTED' as const };
  const myRejection = {
    namespaceId: 12,
    account: 'bravo',
    subjectAccount: 'admin',
    subjectNamespaceId: 12,
    direction: 'OUTGOING' as const,
  };

  it('addresses the sent card identically from the send echo and the peer accept', () => {
    expect(friendRequestKey(sendEcho, 'OUTGOING')).toBe(
      friendRequestKey(peerAccept, projectionDirectionForFact(peerAccept)!),
    );
  });

  it('addresses the received card identically from the peer request and my rejection', () => {
    expect(friendRequestKey(peerRequest, 'INCOMING')).toBe(
      friendRequestKey(myRejection, 'INCOMING'),
    );
  });

  it('keeps local-pair keys on the all-zero namespace shape', () => {
    expect(
      friendRequestKey(
        {
          namespaceId: 0,
          account: 'alice',
          subjectAccount: 'bob',
          subjectNamespaceId: 0,
          direction: 'OUTGOING',
        },
        'OUTGOING',
      ),
    ).toBe('["friend",0,"alice",0,"bob"]');
  });
});
