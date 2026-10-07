import { describe, expect, it } from 'vitest';
import {
  deleteMessageSlot,
  mergeMessageSlot,
  messageTomb,
} from './message-tomb.js';

const message = {
  threadId: 42,
  seq: 4,
  creator: { account: 'alice', namespaceId: 1 },
  profileRev: 3,
  createdAt: 100,
  updatedAt: 101,
  contentType: 'IMAGE',
  isDeleted: false,
  content: 'private body',
  quote: { content: 'private quote' },
  mediaStatus: 'READY',
  clientMessageId: 'private-id',
};

describe('message slot deletion merge', () => {
  it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
    'converges for both arrival orders: %s',
    (reason) => {
      const expected = messageTomb(message, reason);
      const bodyFirst = deleteMessageSlot(message, 42, 4, reason);
      const deletionFirst = mergeMessageSlot(
        deleteMessageSlot(undefined, 42, 4, reason),
        message,
      );
      expect(bodyFirst).toEqual(expected);
      expect(deletionFirst).toEqual(expected);
      expect(Object.keys(expected).sort()).toEqual(
        [
          'threadId',
          'seq',
          'creator',
          'profileRev',
          'createdAt',
          'updatedAt',
          'contentType',
          'isDeleted',
          'deletionType',
        ].sort(),
      );
    },
  );

  it('does not invent identity before the message arrives', () => {
    expect(deleteMessageSlot(undefined, 42, 4, 'USER_RETRACTION')).toEqual({
      threadId: 42,
      seq: 4,
      contentType: 'TOMB',
      isDeleted: true,
      deletionType: 'USER_RETRACTION',
    });
  });

  it('accepts a query tomb and remains deleted after duplicate or stale live writes', () => {
    const tomb = messageTomb(message, 'MODERATION_REMOVAL');
    expect(mergeMessageSlot(undefined, tomb)).toEqual(tomb);
    expect(mergeMessageSlot(tomb, tomb)).toEqual(tomb);
    expect(mergeMessageSlot(tomb, message)).toEqual(tomb);
    expect(deleteMessageSlot(tomb, 42, 4, 'MODERATION_REMOVAL')).toEqual(tomb);
  });

  it('does not accept the old deleted-body contract', () => {
    expect(() =>
      mergeMessageSlot(undefined, { ...message, isDeleted: true }),
    ).toThrow('Deleted messages must use the TOMB contract');
  });
});
