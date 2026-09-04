import { describe, it, expect } from 'vitest';
import {
  buildSummaryBody,
  buildSummaryTitle,
  type SummaryItem,
} from './notif-i18n.js';

function item(displayName: string, unreadCount: number): SummaryItem {
  return { displayName, unreadCount };
}

describe('buildSummaryBody — en', () => {
  const locale = 'en';
  it('one sender, one message → singular', () => {
    expect(buildSummaryBody([item('Alice', 1)], locale)).toBe(
      'Alice sent you a message',
    );
  });
  it('one sender, many messages → plural with count', () => {
    expect(buildSummaryBody([item('Alice', 7)], locale)).toBe(
      'Alice sent you 7 messages',
    );
  });
  it('two senders → both named + total count', () => {
    expect(buildSummaryBody([item('Alice', 2), item('Bob', 3)], locale)).toBe(
      'Alice, Bob sent you 5 messages',
    );
  });
  it('three+ senders → first two + extra count', () => {
    expect(
      buildSummaryBody(
        [item('Alice', 1), item('Bob', 1), item('Carol', 1), item('Dave', 1)],
        locale,
      ),
    ).toBe('Alice, Bob +2 sent you 4 messages');
  });
  it('de-dupes identical display names (counts merge)', () => {
    expect(buildSummaryBody([item('Alice', 2), item('Alice', 3)], locale)).toBe(
      'Alice sent you 5 messages',
    );
  });
  it('zero unread total → empty string (the caller emits no notification)', () => {
    expect(buildSummaryBody([item('Alice', 0)], locale)).toBe('');
    expect(buildSummaryBody([], locale)).toBe('');
  });
});

describe('buildSummaryBody — zh-CN', () => {
  const locale = 'zh-CN';
  it('one sender, many → Chinese form', () => {
    expect(buildSummaryBody([item('Alice', 7)], locale)).toBe(
      'Alice 给你发了 7 条消息',
    );
  });
  it('two senders → 、 separator', () => {
    expect(buildSummaryBody([item('Alice', 2), item('Bob', 3)], locale)).toBe(
      'Alice、Bob 给你发了 5 条消息',
    );
  });
  it('three+ senders → 等 N 人', () => {
    expect(
      buildSummaryBody(
        [item('Alice', 1), item('Bob', 1), item('Carol', 1), item('Dave', 1)],
        locale,
      ),
    ).toBe('Alice、Bob 等 2 人给你发了 4 条消息');
  });
});

describe('buildSummaryTitle', () => {
  it('returns the product name for both locales', () => {
    expect(buildSummaryTitle('en')).toBe('SOMS');
    expect(buildSummaryTitle('zh-CN')).toBe('SOMS');
  });
});
