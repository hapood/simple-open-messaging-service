import { describe, expect, it } from 'vitest';
import { createGroupConversation } from './model';
import {
  currentGroupAnnouncement,
  isGroupMetaCurrent,
} from './group-announcement';

describe('group announcement visibility', () => {
  const thread = () =>
    createGroupConversation(7, {
      id: 7,
      account: '!room',
      name: 'Room',
      namespaceId: 0,
    });

  it('waits for the advertised group-meta head and hides a bounded full drain', () => {
    const group = thread();
    group.group.groupMetaFeedId = '4';
    group.group.announcement = { feedId: '2', text: 'A notice' };
    expect(currentGroupAnnouncement(group)).toBeNull();
    group.groupMetaTargetFeedId = '5';
    expect(isGroupMetaCurrent(group)).toBe(false);
    group.group.groupMetaFeedId = '5';
    expect(currentGroupAnnouncement(group)).toEqual({
      feedId: '2',
      text: 'A notice',
    });
    group.groupMetaRecoveryThrough = '6';
    expect(currentGroupAnnouncement(group)).toBeNull();
  });

  it('distinguishes a known clear from a displayable announcement', () => {
    const group = thread();
    group.groupMetaTargetFeedId = '3';
    group.group.groupMetaFeedId = '3';
    group.group.announcement = { feedId: '3', text: null };
    expect(isGroupMetaCurrent(group)).toBe(true);
    expect(currentGroupAnnouncement(group)).toBeNull();
    group.group.announcement = null;
    expect(currentGroupAnnouncement(group)).toBeNull();
    group.group.announcement = { feedId: '3', text: '<script>text</script>' };
    expect(currentGroupAnnouncement(group)?.text).toBe('<script>text</script>');
  });
});
