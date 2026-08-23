import { describe, expect, it } from 'vitest';
import {
  applyFriendIntentToProjection,
  type FriendIntentProjectionInput,
} from './friend-request-state';

const peer = {
  id: 2,
  account: 'peer',
  name: 'Peer',
  avatar: '',
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
  it('removes the receiver row after the receiver rejects it', () => {
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
    expect(rejected.record).toBeNull();
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
      status: 'REVOKED',
      localStatus: 'REQUESTED',
      remoteStatus: 'REVOKED',
    });
  });
});
