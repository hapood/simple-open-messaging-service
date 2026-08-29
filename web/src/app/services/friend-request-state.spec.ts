import { describe, expect, it } from 'vitest';
import {
  applyFriendIntentToProjection,
  applyGroupIntentToProjection,
  friendRequestKey,
  groupRequestKey,
  markProjectionAccepted,
  projectionDirectionForFact,
  relationshipFactsAreActive,
  type FriendIntentProjectionInput,
  type GroupInviteProjectionInput,
  type RelationshipIntentFact,
} from './friend-request-state';

const friendInput: FriendIntentProjectionInput = {
  namespaceId: 12,
  account: 'alice',
  domain: 'local',
  subjectAccount: 'bob',
  subjectDomain: 'remote.test',
  status: 'REQUESTED',
  direction: 'OUTGOING',
  localThreadId: 7,
  inviteId: '11',
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
  account: '!group',
  domain: 'local',
  status: 'REQUESTED',
  note: '',
  requestedAt: 1_000,
  expiresAt: 10_000,
  direction: 'INCOMING',
  threadId: 9,
  group: {
    namespaceId: 0,
    account: '!group',
    domain: 'local',
    isLocal: true,
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
      key: groupRequestKey(0, 'local', '!group', 'INCOMING'),
      kind: 'GROUP',
      direction: 'INCOMING',
      status: 'REQUESTED',
    });
    expect(
      applyGroupIntentToProjection(
        request,
        { ...groupInput, status: 'REVOKED' },
        3_000,
      ).record?.status,
    ).toBe('REVOKED');
  });
});

describe('authoritative fact folding', () => {
  it('requires two effective facts and one ACK', () => {
    const first: RelationshipIntentFact = {
      key: 'a->b',
      reverseKey: 'b->a',
      status: 'REQUESTED',
      expiresAt: 10_000,
      localThreadId: 1,
      updatedAt: 1,
    };
    const second: RelationshipIntentFact = {
      ...first,
      key: 'b->a',
      reverseKey: 'a->b',
      status: 'ACCEPTED',
      expiresAt: null,
    };
    expect(relationshipFactsAreActive(first, second, 2_000)).toBe(true);
    expect(
      relationshipFactsAreActive(
        first,
        { ...second, status: 'REQUESTED' },
        2_000,
      ),
    ).toBe(false);
  });
});
