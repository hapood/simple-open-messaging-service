import { createP2PConversation, createGroupConversation } from './model';
import {
  threadNotificationDescriptor,
  type ThreadNotificationUpdate,
} from './thread-notification';

describe('thread notification presentation', () => {
  const copy = {
    lang: 'en',
    privateBody: 'New message',
    retracted: '[Retracted]',
    removed: '[Removed]',
  };
  function update(): ThreadNotificationUpdate {
    return {
      item: createP2PConversation(
        7,
        {
          account: 'peer',
          namespaceId: 0,
          profileRev: 1,
        },
        {
          unreadCount: 101,
          lastReadSeq: 3,
          peerUser: {
            account: 'peer',
            namespaceId: 0,
            name: 'Peer',
            avatar: '',
            bio: '',
            isGroup: false,
            isDeleted: false,
          },
        },
      ),
      state: {
        threadId: 7,
        threadFeedId: 9,
        messageEndSeq: 8,
        tombstoneEndSeq: 1,
        alias: null,
        profileRev: 0,
        groupMetaFeedEndId: null,
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        lastReadSeq: 1,
        unreadCount: 103,
        lastMentionSeq: null,
        previews: [
          {
            seq: 6,
            createdAt: '2026-09-09T00:00:00Z',
            sender: { account: 'peer', profileNamespaceId: 0, profileRev: 1 },
            status: 'USER_RETRACTION',
          },
          {
            seq: 8,
            createdAt: '2026-09-09T00:00:00Z',
            sender: { account: 'peer', profileNamespaceId: 0, profileRev: 1 },
            status: 'MODERATION_REMOVAL',
          },
        ],
      },
    };
  }
  it('uses the feed alias regardless of stale conversation cache and falls back to profiles', () => {
    const value = update();
    value.item.alias = 'Stale cache';
    value.state.alias = 'Current label';
    expect(threadNotificationDescriptor(value, 'message', copy).title).toBe(
      'Current label',
    );
    value.state.alias = null;
    expect(threadNotificationDescriptor(value, 'message', copy).title).toBe(
      'Peer',
    );
    value.item = createGroupConversation(
      7,
      {
        id: 7,
        account: '!group',
        name: 'Group profile',
        domain: '',
        namespaceId: 0,
      },
      { alias: 'Stale group label' },
    );
    value.state.alias = 'My group';
    expect(threadNotificationDescriptor(value, 'message', copy).title).toBe(
      'My group',
    );
    value.state.alias = null;
    expect(threadNotificationDescriptor(value, 'message', copy).title).toBe(
      'Group profile',
    );
  });

  it('uses the resolved domain in the address fallback without storing it on the peer', () => {
    const value = update();
    if (value.item.type !== 'P2P') throw new Error('expected P2P fixture');
    value.item.peerUser.name = '';
    expect(threadNotificationDescriptor(value, 'message', copy, 'alpha.test').title)
      .toBe('peer@alpha.test');
    expect(threadNotificationDescriptor(value, 'message', copy).title).toBe('peer');
  });

  it('uses projected count, latest sequence and the moderation reason', () => {
    expect(
      threadNotificationDescriptor(update(), 'message', copy),
    ).toMatchObject({
      count: 101,
      body: '[Retracted]\n[Removed]',
      data: { seq: 8 },
    });
  });
  it('distinguishes retraction and hides message content in private mode', () => {
    const value = update();
    value.state.previews!.pop();
    expect(threadNotificationDescriptor(value, 'message', copy).body).toBe(
      '[Retracted]',
    );
    expect(threadNotificationDescriptor(value, 'private', copy).body).toBe(
      'New message',
    );
  });
  it('renders the server-provided previews in their original order', () => {
    const value = update();
    value.item.lastReadSeq = 0;
    value.state.previews = [6, 7, 8].map((seq) => ({
      seq,
      createdAt: '2026-09-09T00:00:00Z',
      sender: { account: 'peer', profileNamespaceId: 0, profileRev: 1 },
      status: 'LIVE' as const,
      text: String(seq),
    }));
    expect(threadNotificationDescriptor(value, 'message', copy).body).toBe(
      '6\n7\n8',
    );
  });
  it('truncates at the local read position and clears blocked threads', () => {
    const value = update();
    value.item.lastReadSeq = 8;
    value.item.blocked = true;
    expect(threadNotificationDescriptor(value, 'message', copy)).toMatchObject({
      count: 0,
      body: 'New message',
      data: { seq: undefined },
    });
  });
});
