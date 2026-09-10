import { createP2PConversation } from './model';
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
        { id: 2, account: 'peer', name: 'Peer' },
        { unreadCount: 101, lastReadSeq: 3 },
      ),
      state: {
        threadId: 7,
        threadFeedId: 9,
        messageEndSeq: 8,
        tombstoneEndSeq: 1,
        lastReadSeq: 1,
        unreadCount: 103,
        lastMentionSeq: null,
        previews: [
          {
            seq: 8,
            createdAt: '2026-09-09T00:00:00Z',
            sender: { account: 'peer', domain: 'test' },
            status: 'MODERATION_REMOVAL',
          },
          {
            seq: 6,
            createdAt: '2026-09-09T00:00:00Z',
            sender: { account: 'peer', domain: 'test' },
            status: 'USER_RETRACTION',
          },
        ],
      },
    };
  }
  it('uses projected count, latest sequence and the moderation reason', () => {
    expect(
      threadNotificationDescriptor(update(), 'message', copy),
    ).toMatchObject({ count: 101, body: '[Removed]', data: { seq: 8 } });
  });
  it('distinguishes retraction and hides message content in private mode', () => {
    const value = update();
    value.state.previews!.shift();
    expect(threadNotificationDescriptor(value, 'message', copy).body).toBe(
      '[Retracted]',
    );
    expect(threadNotificationDescriptor(value, 'private', copy).body).toBe(
      'New message',
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
