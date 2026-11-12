import { describe, expect, it } from 'vitest';
import {
  createMessageDeletionMarker,
  messageTomb,
  type MessageDeletionType,
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

const deletionTypes = ['USER_RETRACTION', 'MODERATION_REMOVAL'] as const;

describe('createMessageDeletionMarker', () => {
  it.each(deletionTypes)(
    'constructs only coordinates and deletion metadata: %s',
    (deletionType) => {
      expect(createMessageDeletionMarker(42, 4, deletionType)).toEqual({
        threadId: 42,
        seq: 4,
        contentType: 'TOMB',
        isDeleted: true,
        deletionType,
      });
    },
  );

  it('rejects an invalid deletion type', () => {
    expect(() =>
      createMessageDeletionMarker(42, 4, 'INVALID' as MessageDeletionType),
    ).toThrow('Invalid message deletion type');
  });
});

describe('wire message tomb', () => {
  it.each(deletionTypes)(
    'retains the history identity without body fields: %s',
    (deletionType) => {
      expect(messageTomb(message, deletionType)).toEqual({
        threadId: 42,
        seq: 4,
        creator: message.creator,
        profileRev: 3,
        createdAt: 100,
        updatedAt: 101,
        contentType: 'TOMB',
        isDeleted: true,
        deletionType,
      });
    },
  );

  it('preserves a null wire creator without inventing an identity', () => {
    expect(
      messageTomb({ ...message, creator: null }, 'USER_RETRACTION').creator,
    ).toBeNull();
  });

  it('rejects an invalid deletion type', () => {
    expect(() => messageTomb(message, 'INVALID' as MessageDeletionType)).toThrow(
      'Invalid message deletion type',
    );
  });
});
