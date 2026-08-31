import { describe, expect, it, vi } from 'vitest';
import { ContentType } from '../database/enums.js';
import { MessageFanoutService } from './message-fanout.service.js';

describe('MessageFanoutService federation boundary', () => {
  it('never wakes federation for a local SYSTEM message', async () => {
    const federation = { notifyOnSend: vi.fn() };
    const service = new MessageFanoutService(
      { onNewMessage: vi.fn() } as never,
      { dispatchForMessage: vi.fn() } as never,
      federation as never,
      { getActiveParticipantUserIds: vi.fn().mockResolvedValue([]) } as never,
      { readEndId: vi.fn().mockResolvedValue(0) } as never,
    );

    await service.dispatch({
      threadId: 7,
      creator: 2,
      seq: 4,
      contentType: ContentType.SYSTEM,
      content: JSON.stringify({ type: 'FRIEND_ADDED' }),
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    expect(federation.notifyOnSend).not.toHaveBeenCalled();
  });

  it('fans out the durable State Feed end that belongs to each recipient', async () => {
    const onNewMessage = vi.fn();
    const readEndId = vi
      .fn()
      .mockImplementation(async (userId: number) =>
        userId === 2 ? 17 : 23,
      );
    const service = new MessageFanoutService(
      { onNewMessage } as never,
      { dispatchForMessage: vi.fn() } as never,
      { notifyOnSend: vi.fn() } as never,
      {
        getActiveParticipantUserIds: vi.fn().mockResolvedValue([
          {
            userId: 1,
            account: 'alice',
            domain: 'local',
            blocked: false,
            muted: false,
          },
          {
            userId: 2,
            account: 'bob',
            domain: 'local',
            blocked: false,
            muted: false,
          },
          {
            userId: 3,
            account: 'carol',
            domain: 'local',
            blocked: false,
            muted: false,
          },
        ]),
      } as never,
      { readEndId } as never,
    );
    const createdAt = new Date('2026-08-31T01:02:03.000Z');

    await service.dispatch({
      threadId: 7,
      creator: { account: 'alice', domain: 'local' },
      seq: 4,
      contentType: ContentType.PURE_TEXT,
      content: JSON.stringify({ text: 'hello' }),
      isDeleted: false,
      createdAt,
      updatedAt: createdAt,
    } as never);

    expect(readEndId.mock.calls).toEqual([[1], [2], [3]]);
    expect(onNewMessage.mock.calls).toEqual([
      [1, 7, 4, createdAt.getTime(), 23],
      [2, 7, 4, createdAt.getTime(), 17],
      [3, 7, 4, createdAt.getTime(), 23],
    ]);
  });
});
