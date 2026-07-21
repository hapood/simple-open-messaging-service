import { describe, it, expect } from 'vitest';
import {
  composeMessageSummaryDescriptors,
  AWAY_SUMMARY_TAG,
  type DescriptorItem,
} from './notification-descriptor.js';

function item(
  threadId: number,
  displayName: string,
  unreadCount: number,
  opts: { muted?: boolean } = {},
): DescriptorItem {
  return {
    threadId,
    displayName,
    unreadCount,
    muted: opts.muted ?? false,
  };
}

describe('composeMessageSummaryDescriptors', () => {
  it('emits ONE message-summary descriptor (tag soms-away) with the folded body + icon', () => {
    const [d] = composeMessageSummaryDescriptors(
      [item(1, 'Alice', 2), item(2, 'Bob', 3)],
      { locale: 'en', iconUrl: '/uploads/notif-icons/abc.png', renotify: false },
    );
    expect(d.tag).toBe(AWAY_SUMMARY_TAG);
    expect(d.kind).toBe('message-summary');
    expect(d.body).toBe('Alice, Bob sent you 5 messages');
    expect(d.icon).toBe('/uploads/notif-icons/abc.png');
    expect(d.actions).toEqual([{ id: 'mark-all-read', title: 'Mark all read' }]);
    expect(d.data.threadIds).toEqual([1, 2]);
  });

  it('filters to unread+unmuted — a fully-muted/unread-zero set emits a clear descriptor', () => {
    const [d] = composeMessageSummaryDescriptors(
      [item(1, 'Alice', 0), item(2, 'Bob', 3, { muted: true })],
      { locale: 'en', iconUrl: null, renotify: false },
    );
    expect(d.kind).toBe('clear');
    expect(d.body).toBe('');
    expect(d.icon).toBeNull();
    expect(d.data.threadIds).toBeUndefined();
  });

  it('a mixed set folds only the unread+unmuted subset', () => {
    const [d] = composeMessageSummaryDescriptors(
      [item(1, 'Alice', 2), item(2, 'Bob', 0), item(3, 'Carol', 1, { muted: true })],
      { locale: 'en', iconUrl: null, renotify: true },
    );
    expect(d.kind).toBe('message-summary');
    expect(d.body).toBe('Alice sent you 2 messages'); // only Alice qualifies
    expect(d.data.threadIds).toEqual([1]);
    expect(d.renotify).toBe(true);
  });

  it('echoes the negotiated locale on the descriptor', () => {
    const [d] = composeMessageSummaryDescriptors([item(1, 'Alice', 7)], {
      locale: 'zh-CN',
      iconUrl: null,
      renotify: false,
    });
    expect(d.lang).toBe('zh-CN');
    expect(d.body).toBe('Alice 给你发了 7 条消息');
  });
});
