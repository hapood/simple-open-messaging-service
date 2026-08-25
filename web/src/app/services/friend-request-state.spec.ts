import { describe, expect, it } from 'vitest';
import {
  applyFriendIntentToProjection,
  applyGroupIntentToProjection,
  friendProjectionIsActive,
  FRIEND_INTENT_RETENTION_MS,
  markProjectionAccepted,
  projectionRequestExpiresAt,
  projectionIsExpired,
  type FriendIntentProjectionInput,
} from './friend-request-state';

const peer = {
  id: 2,
  account: 'peer',
  name: 'Peer',
  avatar: '',
  bio: '',
  domain: 'example.test',
  isForeigner: true,
};

function intent(
  direction: 'INCOMING' | 'OUTGOING',
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED',
): FriendIntentProjectionInput {
  return {
    account: 'me',
    domain: 'local.test',
    subjectAccount: 'peer',
    subjectDomain: 'example.test',
    status,
    direction,
    localThreadId: 7,
    inviteId: '9',
    note: '',
    requestedAt: status === 'REQUESTED' ? 1_000 : null,
    expiresAt: status === 'REQUESTED' ? 10_000 : null,
    peer,
  };
}

describe('friend request rejection projection', () => {
  it('places only a fresh incoming request in RECEIVED and marks it actionable', () => {
    const transition = applyFriendIntentToProjection(
      undefined,
      intent('INCOMING', 'REQUESTED'),
      2_000,
    );
    expect(transition.record).toMatchObject({
      bucket: 'RECEIVED',
      direction: 'INCOMING',
      status: 'REQUESTED',
    });
    expect(transition.becameActionable).toBe(true);
  });

  it('places an outgoing request in SENT without marking it actionable', () => {
    const transition = applyFriendIntentToProjection(
      undefined,
      intent('OUTGOING', 'REQUESTED'),
      2_000,
    );
    expect(transition.record).toMatchObject({
      bucket: 'SENT',
      direction: 'OUTGOING',
      status: 'REQUESTED',
    });
    expect(transition.becameActionable).toBe(false);
  });

  it('does not project an already-expired request', () => {
    expect(
      applyFriendIntentToProjection(
        undefined,
        intent('INCOMING', 'REQUESTED'),
        10_000,
      ),
    ).toEqual({ record: null, becameActionable: false });
  });

  it('caps a friend request lifetime at seven days', () => {
    const longLived = intent('INCOMING', 'REQUESTED');
    longLived.expiresAt = 1_000 + FRIEND_INTENT_RETENTION_MS * 2;
    expect(
      applyFriendIntentToProjection(undefined, longLived, 2_000).record,
    ).toMatchObject({
      remote: { expiresAt: 1_000 + FRIEND_INTENT_RETENTION_MS },
    });
  });

  it('keeps a locally accepted incoming request non-actionable until both halves converge', () => {
    const incoming = applyFriendIntentToProjection(
      undefined,
      intent('INCOMING', 'REQUESTED'),
      2_000,
    ).record!;
    const accepted = applyFriendIntentToProjection(
      incoming,
      intent('OUTGOING', 'ACCEPTED'),
      2_001,
    );
    expect(accepted.record).toMatchObject({
      bucket: 'RECEIVED',
      status: 'ACCEPTED',
    });
    expect(accepted.becameActionable).toBe(false);

    const converged = applyFriendIntentToProjection(
      accepted.record!,
      intent('INCOMING', 'ACCEPTED'),
      2_002,
    );
    expect(converged.record).toMatchObject({
      bucket: 'RECEIVED',
      direction: 'INCOMING',
      status: 'ACCEPTED',
      requestedSort: 1_000,
    });
    expect(converged.becameActionable).toBe(false);
  });

  it('activates from one live request plus the opposite acknowledgement', () => {
    const outgoing = applyFriendIntentToProjection(
      undefined,
      intent('OUTGOING', 'REQUESTED'),
      2_000,
    ).record!;
    const acknowledged = applyFriendIntentToProjection(
      outgoing,
      intent('INCOMING', 'ACCEPTED'),
      2_001,
    ).record!;

    expect(friendProjectionIsActive(acknowledged, 9_999)).toBe(true);
    expect(friendProjectionIsActive(acknowledged, 10_000)).toBe(false);
  });

  it('retains terminal history independently from the original request expiry', () => {
    const incoming = applyFriendIntentToProjection(
      undefined,
      intent('INCOMING', 'REQUESTED'),
      2_000,
    ).record!;
    const accepted = markProjectionAccepted(incoming, 9_000);

    expect(projectionIsExpired(accepted, 10_000)).toBe(false);
    expect(
      projectionIsExpired(accepted, 9_000 + FRIEND_INTENT_RETENTION_MS),
    ).toBe(true);
  });

  it('does not let a replayed request re-arm a locally accepted projection', () => {
    const incoming = applyFriendIntentToProjection(
      undefined,
      intent('INCOMING', 'REQUESTED'),
      2_000,
    ).record!;
    const replay = applyFriendIntentToProjection(
      markProjectionAccepted(incoming, 2_001),
      intent('INCOMING', 'REQUESTED'),
      2_002,
    );
    expect(replay.record).toMatchObject({ status: 'ACCEPTED' });
    expect(replay.becameActionable).toBe(false);
  });

  it('retains the rejected row in the receiver bucket without changing its order', () => {
    const incoming = applyFriendIntentToProjection(
      undefined,
      intent('INCOMING', 'REQUESTED'),
      2_000,
    ).record!;
    const rejected = applyFriendIntentToProjection(
      incoming,
      intent('OUTGOING', 'REVOKED'),
      2_001,
    );
    expect(rejected.record).toMatchObject({
      bucket: 'RECEIVED',
      direction: 'INCOMING',
      status: 'REVOKED',
      requestedSort: 1_000,
    });
    expect(rejected.becameActionable).toBe(false);
  });

  it('retains a rejected status in the sender history', () => {
    const outgoing = applyFriendIntentToProjection(
      undefined,
      intent('OUTGOING', 'REQUESTED'),
      2_000,
    ).record!;
    const rejected = applyFriendIntentToProjection(
      outgoing,
      intent('INCOMING', 'REVOKED'),
      2_001,
    ).record;
    expect(rejected).toMatchObject({
      direction: 'OUTGOING',
      bucket: 'SENT',
      status: 'REVOKED',
      local: { status: 'REQUESTED' },
      remote: { status: 'REVOKED' },
    });
  });

  it('retains a rejected group invite in the receiver bucket', () => {
    const requested = applyGroupIntentToProjection(
      undefined,
      {
        account: '!group',
        domain: 'local.test',
        status: 'REQUESTED',
        direction: 'INCOMING',
        note: '',
        requestedAt: 1_000,
        expiresAt: 10_000,
        threadId: 8,
        group: {
          account: '!group',
          domain: 'local.test',
          isLocal: true,
          name: 'Group',
          avatar: '',
          description: '',
          profileRev: 1,
        },
      },
      2_000,
    ).record!;
    const rejected = applyGroupIntentToProjection(
      requested,
      {
        account: '!group',
        domain: 'local.test',
        status: 'REVOKED',
        direction: 'OUTGOING',
        note: '',
        requestedAt: null,
        expiresAt: null,
        threadId: 8,
        group: requested.group!,
      },
      2_001,
    ).record;

    expect(rejected).toMatchObject({
      bucket: 'RECEIVED',
      direction: 'INCOMING',
      status: 'REVOKED',
      requestedSort: 1_000,
    });
  });

  it('activates one group projection from the two authored intent directions', () => {
    const group = {
      account: '!group',
      domain: 'local.test',
      isLocal: true,
      name: 'Group',
      avatar: '',
      description: '',
      profileRev: 1,
    };
    const incoming = applyGroupIntentToProjection(
      undefined,
      {
        account: group.account,
        domain: group.domain,
        status: 'ACCEPTED',
        direction: 'INCOMING',
        note: '',
        requestedAt: null,
        expiresAt: null,
        threadId: 8,
        group,
      },
      2_000,
    ).record!;
    const active = applyGroupIntentToProjection(
      incoming,
      {
        account: group.account,
        domain: group.domain,
        status: 'ACCEPTED',
        direction: 'OUTGOING',
        note: '',
        requestedAt: null,
        expiresAt: null,
        threadId: 8,
        group,
      },
      2_001,
    ).record!;

    expect(active).toMatchObject({
      localThreadId: 8,
      local: { status: 'ACCEPTED' },
      remote: { status: 'ACCEPTED' },
      status: null,
    });
    expect(friendProjectionIsActive(active, 2_001)).toBe(true);
  });

  it('keeps an outgoing group join application in sent history', () => {
    const result = applyGroupIntentToProjection(
      undefined,
      {
        account: '!group',
        domain: 'local.test',
        status: 'REQUESTED',
        direction: 'OUTGOING',
        note: 'Please let me in',
        requestedAt: 1_000,
        expiresAt: 10_000,
        threadId: 8,
        group: {
          account: '!group',
          domain: 'local.test',
          isLocal: true,
          name: 'Group',
          avatar: '',
          description: '',
          profileRev: 1,
        },
      },
      2_000,
    ).record;

    expect(result).toMatchObject({
      kind: 'GROUP',
      direction: 'OUTGOING',
      bucket: 'SENT',
      status: 'REQUESTED',
      local: { status: 'REQUESTED' },
    });
  });

  it('marks only a fresh incoming group invite actionable and drops an expired one', () => {
    const input = {
      account: '!group',
      domain: 'local.test',
      status: 'REQUESTED' as const,
      direction: 'INCOMING' as const,
      note: '',
      requestedAt: 1_000,
      expiresAt: 10_000,
      threadId: 8,
      group: {
        account: '!group',
        domain: 'local.test',
        isLocal: true,
        name: 'Group',
        avatar: '',
        description: '',
        profileRev: 1,
      },
    };
    const fresh = applyGroupIntentToProjection(undefined, input, 2_000);
    expect(fresh.record).toMatchObject({
      bucket: 'RECEIVED',
      status: 'REQUESTED',
    });
    expect(fresh.becameActionable).toBe(true);
    expect(applyGroupIntentToProjection(undefined, input, 10_000)).toEqual({
      record: null,
      becameActionable: false,
    });
    const longLived = applyGroupIntentToProjection(
      undefined,
      {
        ...input,
        expiresAt: 1_000 + FRIEND_INTENT_RETENTION_MS * 2,
      },
      2_000,
    ).record!;
    expect(projectionRequestExpiresAt(longLived)).toBe(
      1_000 + FRIEND_INTENT_RETENTION_MS,
    );
    expect(projectionRequestExpiresAt(fresh.record!)).toBe(10_000);
  });
});
