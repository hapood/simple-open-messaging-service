import { describe, expect, it } from 'vitest';
import { createGroupConversation } from '../app/services/model';
import { PlaygroundConversationList } from './playground-conversation-list.mock';

describe('PlaygroundConversationList', () => {
  function group(threadId: number) {
    return createGroupConversation({
      threadId,
      account: '!playground',
      publisherNamespaceId: 0,
      profileRev: 0,
    });
  }

  it('puts a new friend below pins even when the friend has no messages', () => {
    const conversations = new PlaygroundConversationList();
    conversations.setRelatedConversations([
      { ...group(1), pinned: true, pinnedAt: 100 },
      { ...group(2), lastMessageAt: 10_000 },
    ]);
    conversations.setRelatedConversations([group(3)]);
    expect(conversations.items().map((item) => item.threadId)).toEqual([
      1, 3, 2,
    ]);
    conversations.applyThreadMeta(2, { lastMessageAt: 20_000 });
    expect(conversations.items().map((item) => item.threadId)).toEqual([
      1, 2, 3,
    ]);
  });

  it('orders pins by pin time rather than last message time', () => {
    const conversations = new PlaygroundConversationList();
    conversations.setRelatedConversations([
      { ...group(1), pinned: true, pinnedAt: 100, lastMessageAt: 10_000 },
      { ...group(2), pinned: true, pinnedAt: 200, lastMessageAt: 1 },
    ]);
    expect(conversations.items().map((item) => item.threadId)).toEqual([2, 1]);
    conversations.applyThreadMeta(1, { lastMessageAt: 20_000 });
    expect(conversations.items().map((item) => item.threadId)).toEqual([2, 1]);
  });

  it('does not reorder rows when announcement or join-request reads advance', () => {
    const conversations = new PlaygroundConversationList();
    const seeded = group(1);
    conversations.setRelatedConversations([
      {
        ...seeded,
        meta: { ...seeded.meta, announcementFeedId: '1' },
        joinRequestEndFeedId: 2,
      },
      group(2),
    ]);
    // Ordinary rows follow feed order: thread 2 was set after thread 1.
    expect(conversations.items().map((item) => item.threadId)).toEqual([2, 1]);
    const feedIdBefore = conversations
      .items()
      .find((item) => item.threadId === 1)!.threadFeedId;

    conversations.markAnnouncementReadLocally(1, 1);
    conversations.markJoinRequestsReadLocally(1, 2);

    const thread = conversations.items().find((item) => item.threadId === 1)!;
    expect(thread.announcementReadFeedId).toBe(1);
    expect(thread.joinRequestReadFeedId).toBe(2);
    expect(thread.threadFeedId).toBe(feedIdBefore);
    expect(conversations.items().map((item) => item.threadId)).toEqual([2, 1]);
  });

  it('marks read attention in place without reordering the row', () => {
    const conversations = new PlaygroundConversationList();
    conversations.setRelatedConversations([
      { ...group(1), unreadCount: 3, mentionUnread: ['me'] },
      group(2),
    ]);
    expect(conversations.items().map((item) => item.threadId)).toEqual([2, 1]);
    const feedIdBefore = conversations
      .items()
      .find((item) => item.threadId === 1)!.threadFeedId;

    conversations.markReadStable(1, 7);

    const thread = conversations.items().find((item) => item.threadId === 1)!;
    expect(thread.unreadCount).toBe(0);
    expect(thread.mentionUnread).toEqual([]);
    expect(thread.lastReadSeq).toBe(7);
    expect(thread.threadFeedId).toBe(feedIdBefore);
    expect(conversations.items().map((item) => item.threadId)).toEqual([2, 1]);
  });

  it('keeps alias confirmation in place without reordering', () => {
    const conversations = new PlaygroundConversationList();
    conversations.setRelatedConversations([group(1), group(2)]);
    const feedIdBefore = conversations
      .items()
      .find((item) => item.threadId === 1)!.threadFeedId;

    conversations.confirmThreadAlias({
      threadId: 1,
      threadFeedId: 999,
      alias: 'Design partner',
    });

    const thread = conversations.items().find((item) => item.threadId === 1)!;
    expect(thread.alias).toBe('Design partner');
    expect(thread.threadFeedId).toBe(feedIdBefore);
  });

  it('applies group settings without replacing the rest of the group', () => {
    const conversations = new PlaygroundConversationList();
    conversations.setConversation(
      createGroupConversation({
        threadId: 2,
        account: '!playground',
        publisherNamespaceId: 0,
        profileRev: 0,
        profile: { name: 'Playground Team', bio: '', avatarDigest: null },
      }),
    );

    conversations.applyGroupUpdate(2, { profile: { bio: 'After' } });

    expect(conversations.current()?.profile).toEqual(
      expect.objectContaining({
        name: 'Playground Team',
        bio: 'After',
      }),
    );
  });
});
