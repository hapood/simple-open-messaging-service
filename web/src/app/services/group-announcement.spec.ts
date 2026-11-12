import { describe, expect, it } from 'vitest';
import { createGroupConversation } from './model';
import {
  currentGroupAnnouncement,
  isGroupMetaCurrent,
} from './group-announcement';

describe('group announcement visibility', () => {
  const thread = () =>
    createGroupConversation({
      threadId: 7,
      account: '!room',
      publisherNamespaceId: 0,
      profileRev: 1,
      profile: { name: 'Room', bio: '', avatarDigest: null },
    });

  it('waits for the advertised group-meta head and hides a bounded full drain', () => {
    const group = thread();
    group.meta.groupMetaFeedId = '4';
    group.groupMetaFeedEndId = '5';
    group.meta.announcementFeedId = '2';
    group.meta.announcementText = 'A notice';
    group.meta.announcementCreatedAt = 1_000;
    group.meta.announcementOriginCreatedAt = null;
    expect(currentGroupAnnouncement(group)).toBeNull();
    expect(isGroupMetaCurrent(group)).toBe(false);
    group.meta.groupMetaFeedId = '5';
    expect(currentGroupAnnouncement(group)).toEqual({
      feedId: '2',
      text: 'A notice',
      createdAt: 1_000,
      originCreatedAt: null,
    });
    group.meta.recoveryThrough = '6';
    expect(currentGroupAnnouncement(group)).toBeNull();
  });

  it('distinguishes a known clear from a displayable announcement', () => {
    const group = thread();
    group.groupMetaFeedEndId = '3';
    group.meta.groupMetaFeedId = '3';
    group.meta.announcementFeedId = '3';
    group.meta.announcementText = null;
    group.meta.announcementCreatedAt = 2_000;
    group.meta.announcementOriginCreatedAt = 1_000;
    expect(isGroupMetaCurrent(group)).toBe(true);
    expect(currentGroupAnnouncement(group)).toBeNull();
    group.meta.announcementFeedId = null;
    expect(currentGroupAnnouncement(group)).toBeNull();
    group.meta.announcementFeedId = '3';
    group.meta.announcementText = '<script>text</script>';
    expect(currentGroupAnnouncement(group)?.text).toBe('<script>text</script>');
  });
});
