import { describe, expect, it, vi } from 'vitest';
import {
  PLAYGROUND_TEAM_THREAD_ID,
  PlaygroundLiveMessage,
  PlaygroundSocialState,
  sameIdentity,
} from './playground-social-state';
import { PlaygroundConversationList } from './playground-conversation-list.mock';
import {
  serializeAudienceMention,
  serializeUserMention,
} from '../app/lib/message-entity';
import { stringifyTextMessageContent } from '../../../shared/text-message-content';

describe('PlaygroundSocialState live group activity', () => {
  function makeState(): PlaygroundSocialState {
    return new PlaygroundSocialState(new PlaygroundConversationList());
  }

  function teamThread(state: PlaygroundSocialState) {
    return state.conversations
      .items()
      .find((item) => item.threadId === PLAYGROUND_TEAM_THREAD_ID)!;
  }

  it('commits an incoming direct mention with preview, unread and badge', () => {
    const state = makeState();
    state.initialize();
    const before = teamThread(state);
    state.commitMessage(PLAYGROUND_TEAM_THREAD_ID, {
      senderAccount: 'alice',
      senderNamespaceId: 0,
      contentType: 'PURE_TEXT',
      content: stringifyTextMessageContent({
        text: `${serializeUserMention('You', 0, 'me')} ping`,
      }),
      createdAtMs: 1234,
      isSelf: false,
    });
    const thread = teamThread(state);
    expect(thread.lastMessagePreview).toBe('@You ping');
    expect(thread.lastMessageAt).toBe(1234);
    expect(thread.lastMessageSenderAccount).toBe('alice');
    expect(thread.unreadCount).toBe(before.unreadCount + 1);
    expect(thread.mentionUnread).toContain('me');
    expect(thread.messageEndSeq).toBe(before.messageEndSeq + 1);
  });

  it('derives previews from the persisted content shape, not raw bodies', () => {
    const state = makeState();
    state.initialize();
    state.commitMessage(PLAYGROUND_TEAM_THREAD_ID, {
      senderAccount: 'me',
      senderNamespaceId: 0,
      contentType: 'PURE_TEXT',
      content: stringifyTextMessageContent({ text: 'hello there' }),
      isSelf: true,
    });
    expect(teamThread(state).lastMessagePreview).toBe('hello there');

    state.commitMessage(PLAYGROUND_TEAM_THREAD_ID, {
      senderAccount: 'me',
      senderNamespaceId: 0,
      contentType: 'CONTACT_CARD',
      content: JSON.stringify({ displayName: 'Maya', account: 'maya' }),
      isSelf: true,
    });
    expect(teamThread(state).lastMessagePreview).toBe('[Contact] Maya');
  });

  it('flags an audience mention and keeps self sends out of unread', () => {
    const state = makeState();
    state.initialize();
    state.commitMessage(PLAYGROUND_TEAM_THREAD_ID, {
      senderAccount: 'maya',
      senderNamespaceId: 0,
      contentType: 'PURE_TEXT',
      content: stringifyTextMessageContent({
        text: `${serializeAudienceMention('all', 'all')} stand up`,
      }),
      isSelf: false,
    });
    expect(teamThread(state).mentionUnread).toContain('all');

    const before = teamThread(state);
    state.commitMessage(PLAYGROUND_TEAM_THREAD_ID, {
      senderAccount: 'me',
      senderNamespaceId: 0,
      contentType: 'PURE_TEXT',
      content: stringifyTextMessageContent({ text: 'noted' }),
      isSelf: true,
    });
    const thread = teamThread(state);
    expect(thread.unreadCount).toBe(before.unreadCount);
    expect(thread.lastMessagePreview).toBe('noted');
  });

  it('marks read attention in place without advancing the feed order', () => {
    const state = makeState();
    state.initialize();
    state.commitMessage(PLAYGROUND_TEAM_THREAD_ID, {
      senderAccount: 'noah',
      senderNamespaceId: 0,
      contentType: 'PURE_TEXT',
      content: stringifyTextMessageContent({ text: 'hello' }),
      isSelf: false,
    });
    const before = teamThread(state);
    state.conversations.markReadStable(
      PLAYGROUND_TEAM_THREAD_ID,
      before.messageEndSeq,
    );
    const thread = teamThread(state);
    expect(thread.unreadCount).toBe(0);
    expect(thread.mentionUnread).toEqual([]);
    expect(thread.lastReadSeq).toBe(before.messageEndSeq);
    expect(thread.threadFeedId).toBe(before.threadFeedId);
  });

  it('emits one live message per ticker interval', () => {
    vi.useFakeTimers();
    try {
      const state = makeState();
      state.initialize();
      const before = teamThread(state);
      const events: PlaygroundLiveMessage[] = [];
      state.groupLive$.subscribe((event) => events.push(event));
      state.startGroupTicker(1000);
      vi.advanceTimersByTime(2400);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(
        events.every((event) => event.threadId === PLAYGROUND_TEAM_THREAD_ID),
      ).toBe(true);
      expect(teamThread(state).messageEndSeq).toBeGreaterThan(
        before.messageEndSeq,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('speaks only for current members while the viewer belongs to the group', () => {
    vi.useFakeTimers();
    try {
      const state = makeState();
      state.initialize();
      // Narrow the roster to Alice alone: every live message must come from
      // her, and only while she is a member and the viewer belongs to the
      // group. Kicks and leaves prune the roster (kickMember/leaveGroup), and
      // leave/dissolve flip the conversation to role null / READ_ONLY through
      // applyThreadMeta — the same seams driven here.
      const roster = state.rosters.get(PLAYGROUND_TEAM_THREAD_ID)!;
      const alice = roster.find((m) => m.account === 'alice')!;
      state.rosters.set(PLAYGROUND_TEAM_THREAD_ID, [alice]);
      const events: PlaygroundLiveMessage[] = [];
      state.groupLive$.subscribe((event) => events.push(event));
      state.startGroupTicker(1000);
      vi.advanceTimersByTime(2400);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.every((event) => sameIdentity(event.sender, alice))).toBe(
        true,
      );

      // Alice is removed from the group: she may no longer speak.
      const seqWhileMember = teamThread(state).messageEndSeq;
      events.length = 0;
      state.rosters.set(PLAYGROUND_TEAM_THREAD_ID, []);
      vi.advanceTimersByTime(2400);
      expect(events).toHaveLength(0);
      expect(teamThread(state).messageEndSeq).toBe(seqWhileMember);

      // Members remain, but the viewer has left (role null + READ_ONLY):
      // the feed stops — no member posts into a group the viewer left.
      state.rosters.set(PLAYGROUND_TEAM_THREAD_ID, [alice]);
      state.conversations.applyThreadMeta(PLAYGROUND_TEAM_THREAD_ID, {
        role: null,
        conversationState: 'READ_ONLY',
      });
      vi.advanceTimersByTime(2400);
      expect(events).toHaveLength(0);
      expect(teamThread(state).messageEndSeq).toBe(seqWhileMember);
    } finally {
      vi.useRealTimers();
    }
  });
});
