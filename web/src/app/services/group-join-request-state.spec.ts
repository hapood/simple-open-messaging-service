import { describe, expect, it } from 'vitest';
import type { GroupJoinRequest } from './group.service';
import {
  applyGroupJoinRequestAction,
  mergeGroupJoinRequestPage,
} from './group-join-request-state';

function request(
  feedId: number,
  status: GroupJoinRequest['status'] = 'REQUESTED',
): GroupJoinRequest {
  return {
    feedId,
    status,
    namespaceId: 0,
    profileRev: 1,
    account: `user-${feedId}`,
    domain: 'local',
    name: `User ${feedId}`,
    avatar: '',
    note: '',
    requestedAt: 0,
    expiresAt: 1,
  };
}

describe('group join request projection state', () => {
  it('retains accepted and rejected history instead of removing the row', () => {
    expect(applyGroupJoinRequestAction(request(1), 'ACCEPT').status).toBe(
      'ACCEPTED',
    );
    expect(applyGroupJoinRequestAction(request(1), 'REJECT').status).toBe(
      'REVOKED',
    );
  });

  it('does not reopen a terminal local transition', () => {
    const terminal = request(1, 'REVOKED');
    expect(applyGroupJoinRequestAction(terminal, 'ACCEPT')).toBe(terminal);
  });

  it('deduplicates pages by applicant and accepts only newer feed coordinates', () => {
    const older = request(1);
    const newer = { ...older, feedId: 3, status: 'REVOKED' as const };
    expect(mergeGroupJoinRequestPage([newer], [older])).toEqual([newer]);
    expect(mergeGroupJoinRequestPage([older], [newer])).toEqual([newer]);
  });
});
