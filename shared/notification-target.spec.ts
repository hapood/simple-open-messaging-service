import { describe, expect, it } from 'vitest';
import {
  notificationTargetKey,
  parseNotificationTarget,
} from './notification-target.js';

describe('notification destination contract', () => {
  it('keeps message and application cards distinct for the same thread', () => {
    expect(notificationTargetKey({ kind: 'thread', threadId: 7 })).toBe(
      'thread:7',
    );
    expect(
      notificationTargetKey({ kind: 'group-join-requests', threadId: 7 }),
    ).toBe('group-join-requests:7');
    expect(notificationTargetKey({ kind: 'friend-requests' })).toBe(
      'friend-requests',
    );
  });

  it.each(['thread', 'group-join-requests'] as const)(
    'validates %s coordinates without coercion',
    (kind) => {
      for (const threadId of [1, 2147483647]) {
        expect(parseNotificationTarget({ kind, threadId })).toEqual({
          kind,
          threadId,
        });
      }
      for (const threadId of [
        undefined,
        null,
        '7',
        0,
        -1,
        1.5,
        2147483648,
        NaN,
        Infinity,
      ]) {
        expect(parseNotificationTarget({ kind, threadId })).toBeNull();
      }
    },
  );

  it('does not require or invent a thread for personal requests', () => {
    expect(parseNotificationTarget({ kind: 'friend-requests' })).toEqual({
      kind: 'friend-requests',
    });
  });

  it('rejects unknown and malformed destinations', () => {
    for (const value of [
      null,
      undefined,
      [],
      'friend-requests',
      7,
      {},
      { kind: 'home' },
    ]) {
      expect(parseNotificationTarget(value)).toBeNull();
    }
  });
});
