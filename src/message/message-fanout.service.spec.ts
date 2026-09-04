import { describe, expect, it, vi } from 'vitest';
import { ContentType } from '../database/enums.js';
import { MessageFanoutService } from './message-fanout.service.js';

describe('MessageFanoutService federation boundary', () => {
  it('never wakes federation for a local SYSTEM message', async () => {
    const federation = { notifyOnSend: vi.fn() };
    const service = new MessageFanoutService(
      { dispatchForMessage: vi.fn() } as never,
      federation as never,
      { getActiveParticipantUserIds: vi.fn().mockResolvedValue([]) } as never,
      {
        readEndId: vi.fn().mockResolvedValue(0),
        notifyFeedUpdates: vi.fn(),
      } as never,
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
    const notifyFeedUpdates = vi.fn();
    const readEndId = vi
      .fn()
      .mockImplementation(async (userId: number) => (userId === 2 ? 17 : 23));
    const service = new MessageFanoutService(
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
      { readEndId, notifyFeedUpdates } as never,
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
    expect(notifyFeedUpdates).toHaveBeenCalledWith([
      { userId: 1, feedId: 23 },
      { userId: 2, feedId: 17 },
      { userId: 3, feedId: 23 },
    ]);
  });

  it('lets an older thread run yield after its current recipient batch', async () => {
    const participants = Array.from({ length: 60 }, (_, index) => ({
      userId: index + 1,
      account: index === 0 ? 'alice' : `user-${index + 1}`,
      domain: 'local',
      blocked: false,
      muted: false,
    }));
    const notifyFeedUpdates = vi.fn();
    const notifyOnSend = vi.fn();
    let newerRun: Promise<void> | undefined;
    const serviceRef: { current?: MessageFanoutService } = {};
    const readEndId = vi.fn().mockImplementation(async (userId: number) => {
      if (userId === 1 && newerRun === undefined) {
        newerRun = serviceRef.current!.dispatch({
          threadId: 7,
          creator: { account: 'alice', domain: 'local' },
          seq: 5,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({ text: 'newer' }),
          isDeleted: false,
          createdAt: new Date('2026-08-31T01:02:04.000Z'),
          updatedAt: new Date('2026-08-31T01:02:04.000Z'),
        } as never);
      }
      return userId;
    });
    const service = new MessageFanoutService(
      { dispatchForMessage: vi.fn().mockResolvedValue(undefined) } as never,
      { notifyOnSend } as never,
      {
        getActiveParticipantUserIds: vi.fn().mockResolvedValue(participants),
      } as never,
      { readEndId, notifyFeedUpdates } as never,
    );
    serviceRef.current = service;

    await service.dispatch({
      threadId: 7,
      creator: { account: 'alice', domain: 'local' },
      seq: 4,
      contentType: ContentType.PURE_TEXT,
      content: JSON.stringify({ text: 'older' }),
      isDeleted: false,
      createdAt: new Date('2026-08-31T01:02:03.000Z'),
      updatedAt: new Date('2026-08-31T01:02:03.000Z'),
    } as never);
    await newerRun;

    expect(readEndId.mock.calls.map(([userId]) => userId)).toEqual([
      ...Array.from({ length: 50 }, (_, i) => i + 1),
      ...Array.from({ length: 60 }, (_, i) => i + 1),
    ]);
    expect(notifyFeedUpdates).toHaveBeenCalledTimes(3);
    expect(notifyOnSend.mock.calls.map((call) => call[2])).toEqual([4, 5]);
  });
});
