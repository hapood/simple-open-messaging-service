import { describe, expect, it } from 'vitest';
import {
  friendRequestNotification,
  groupRequestNotification,
} from './request-notification';
import {
  threadNotificationChanged,
  type ThreadFeedSnapshot,
} from '../../../../shared/thread-attention';
import type { AccountState } from '../../../../shared/account-state';
import { notificationTarget } from './notification-routing';

const settings = { enabled: true, sound: true, private: false, language: 'en' };

describe('request notification projection', () => {
  it('treats bigint arrival positions as boolean unread markers, including optimistic reads', () => {
    const account = {
      intentRequestEndId: '90071992547409999',
      intentRequestReadId: '3',
      intentRequestOptimisticReadId: null,
    } as AccountState;
    expect(friendRequestNotification(account, settings).count).toBe(1);
    expect(
      friendRequestNotification(
        {
          ...account,
          intentRequestOptimisticReadId: account.intentRequestEndId,
        },
        settings,
      ).count,
    ).toBe(0);
    expect(
      friendRequestNotification(account, { ...settings, enabled: false }).count,
    ).toBe(0);
    expect(
      friendRequestNotification(account, { ...settings, sound: false }).silent,
    ).toBe(true);
  });

  it('honors manager authorization, private copy, sound, and does not re-alert messages', () => {
    const state = {
      threadId: 7,
      type: 'GROUP',
      role: 'ADMIN',
      conversationState: 'ACTIVE',
      blocked: false,
      joinRequestEndFeedId: 100,
      joinRequestReadFeedId: 2,
    } as ThreadFeedSnapshot;
    expect(
      groupRequestNotification(state, 'Secret group', settings).count,
    ).toBe(1);
    expect(
      groupRequestNotification(state, 'Secret group', {
        ...settings,
        private: true,
      }).title,
    ).toBe('Join requests');
    expect(
      groupRequestNotification(state, 'Group', settings, true).silent,
    ).toBe(true);
    for (const patch of [
      { role: 'MEMBER' as const },
      { conversationState: 'READ_ONLY' as const },
      { joinRequestReadFeedId: -1 },
      { joinRequestReadFeedId: 100 },
    ])
      expect(
        groupRequestNotification({ ...state, ...patch }, 'Group', settings)
          .count,
      ).toBe(0);
    expect(
      threadNotificationChanged(state, { ...state, joinRequestEndFeedId: 101 }),
    ).toBe(false);
  });

  it('rejects explicit malformed targets and never accepts a flattened thread ID', () => {
    expect(
      notificationTarget({
        target: { kind: 'group-join-requests', threadId: 0 },
      }),
    ).toBeNull();
    expect(
      notificationTarget({ threadId: 7 } as unknown as {
        target?: unknown;
      }),
    ).toBeNull();
    expect(notificationTarget({ target: { kind: 'friend-requests' } })).toEqual(
      { kind: 'friend-requests' },
    );
  });
});
