import { describe, expect, it } from 'vitest';
import type { RequestRecord } from '../../../../shared/relationship-request';
import {
  applyGroupJoinRequestAction,
  hasUnreadGroupJoinRequests,
  mergeGroupJoinRequestPage,
} from './group-join-request-state';

function round(id: string, status: RequestRecord['status'] = 'REQUESTED'): RequestRecord {
  return {
    id,
    kind: 'GROUP_APPLICATION',
    author: { account: 'alice', namespaceId: 0 },
    receiver: { account: 'managers', namespaceId: 0 },
    status,
    direction: 'INCOMING',
    authorProfile: {
      account: 'alice',
      namespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 1,
    },
    note: '',
    requestedAt: '2026-01-02T00:00:00Z',
    expiresAt: '2026-01-09T00:00:00Z',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  };
}

describe('mergeGroupJoinRequestPage', () => {
  it('keeps several historical rounds of one identity as separate rows', () => {
    const first = round('41');
    const second = { ...round('42'), note: 'again' };
    const merged = mergeGroupJoinRequestPage([first], [second]);
    expect(merged.map((row) => row.id)).toEqual(['42', '41']);
  });

  it('replaces an equal id refresh without duplicating it', () => {
    const decided = round('41', 'REJECTED');
    const merged = mergeGroupJoinRequestPage([round('41'), round('40')], [decided]);
    expect(merged.map((row) => row.id)).toEqual(['41', '40']);
    expect(merged[0].status).toBe('REJECTED');
  });

  it('orders beyond the JS safe integer range using bigint comparison', () => {
    const merged = mergeGroupJoinRequestPage(
      [round('9007199254740993')],
      [round('9007199254740992'), round('9007199254740994')],
    );
    expect(merged.map((row) => row.id)).toEqual([
      '9007199254740994',
      '9007199254740993',
      '9007199254740992',
    ]);
  });
});

describe('applyGroupJoinRequestAction', () => {
  it('only transitions a REQUESTED round and keeps the request id', () => {
    expect(applyGroupJoinRequestAction(round('41'), 'ACCEPT').status).toBe('ACCEPTED');
    expect(applyGroupJoinRequestAction(round('41'), 'REJECT').status).toBe('REJECTED');
    expect(applyGroupJoinRequestAction(round('41', 'WITHDRAWN'), 'ACCEPT').status).toBe(
      'WITHDRAWN',
    );
  });
});

describe('hasUnreadGroupJoinRequests', () => {
  it('treats -1 as disabled attention and otherwise compares read against end', () => {
    expect(hasUnreadGroupJoinRequests({ joinRequestEndFeedId: 3, joinRequestReadFeedId: -1 })).toBe(false);
    expect(hasUnreadGroupJoinRequests({ joinRequestEndFeedId: 3, joinRequestReadFeedId: 2 })).toBe(true);
    expect(hasUnreadGroupJoinRequests({ joinRequestEndFeedId: 3, joinRequestReadFeedId: 3 })).toBe(false);
    expect(hasUnreadGroupJoinRequests(undefined)).toBe(false);
  });
});
