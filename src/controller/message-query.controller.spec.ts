import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { MessageController } from './message.controller.js';
import type { QueryMessagesDto } from '../dto/message.dto.js';
import { ContentType } from '../database/enums.js';

function setup(rows: Array<{ seq: number }> = []) {
  const queryMessages = vi.fn().mockResolvedValue(rows);
  const controller = new MessageController(
    { queryMessages } as never,
    {} as never,
    {} as never,
    { blockedByMe: vi.fn().mockResolvedValue(new Set<number>()) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { queryThread: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    {} as never,
  );
  const req = {
    user: { userId: 1 },
    threadAccess: {
      threadType: 'P2P',
      participant: { clearedSeq: null },
    },
  } as unknown as FastifyRequest;
  return { controller, queryMessages, req };
}

function dto(overrides: Partial<QueryMessagesDto> = {}): QueryMessagesDto {
  return {
    threadId: 42,
    skip: 1,
    take: 3,
    lastSeq: 10,
    orderBy: 'asc',
    ...overrides,
  };
}

describe('MessageController.queryMessages truncation', () => {
  it.each([
    ['asc', 10, 10],
    ['asc', 10, 9],
    ['desc', 10, 10],
    ['desc', 10, 11],
  ] as const)(
    'returns an empty truncated page without DB query for invalid %s interval',
    async (orderBy, lastSeq, truncateSeq) => {
      const { controller, queryMessages, req } = setup();
      const result = await controller.queryMessages(
        req,
        dto({ orderBy, lastSeq, truncate: true, truncateSeq }),
      );

      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.truncated).toBe(true);
      expect(queryMessages).not.toHaveBeenCalled();
    },
  );

  it('passes an exclusive asc cutoff and reports reached only when the bounded page is exhausted', async () => {
    const { controller, queryMessages, req } = setup([
      { seq: 11 },
      { seq: 12 },
    ]);
    const result = await controller.queryMessages(
      req,
      dto({ truncate: true, truncateSeq: 15 }),
    );

    expect(queryMessages).toHaveBeenCalledWith(
      42,
      {
        skip: 1,
        take: 4,
        orderBy: { seq: 'asc' },
        cursor: { threadId_seq: { threadId: 42, seq: 10 } },
        truncateSeq: 15,
      },
      { clearedThroughSeq: null },
    );
    expect(result.data.map((row) => row.seq)).toEqual([11, 12]);
    expect(result.hasMore).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it('does not report reached when take+1 proves more rows remain before the cutoff', async () => {
    const { controller, req } = setup([
      { seq: 11 },
      { seq: 12 },
      { seq: 13 },
      { seq: 14 },
    ]);
    const result = await controller.queryMessages(
      req,
      dto({ truncate: true, truncateSeq: 20 }),
    );

    expect(result.data.map((row) => row.seq)).toEqual([11, 12, 13]);
    expect(result.hasMore).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('accepts lastSeq=0 as the pre-first bootstrap cursor', async () => {
    const { controller, queryMessages, req } = setup([{ seq: 1 }]);
    await controller.queryMessages(req, dto({ lastSeq: 0 }));
    expect(queryMessages.mock.calls[0][1].cursor).toEqual({
      threadId_seq: { threadId: 42, seq: 0 },
    });
  });
});

describe('MessageController.withdrawMessage quota', () => {
  it('charges one message quota inside the first-withdraw transaction', async () => {
    const tx = { transaction: true };
    const assertCanSend = vi.fn().mockResolvedValue(undefined);
    const tickLax = vi.fn().mockResolvedValue(undefined);
    const withdraw = vi.fn(
      async (
        _userId: number,
        _threadId: number,
        _seq: number,
        onFirstWithdraw: (transaction: never) => Promise<void>,
      ) => {
        await onFirstWithdraw(tx as never);
        return { id: '9', threadId: 42, seq: 3 };
      },
    );
    const controller = new MessageController(
      {} as never,
      { onDeletedMessageUpdated: vi.fn() } as never,
      { getActiveParticipantUserIds: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      {
        notifyOnSend: vi.fn(),
        signalDeletionOutbound: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      { assertCanSend, tickLax } as never,
      { withdraw } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const req = { user: { userId: 7 } } as unknown as FastifyRequest;

    await controller.withdrawMessage(req, { threadId: 42, seq: 3 });

    expect(withdraw).toHaveBeenCalledWith(7, 42, 3, expect.any(Function));
    expect(assertCanSend).toHaveBeenCalledWith(7);
    expect(tickLax).toHaveBeenCalledWith(7, 'messages', tx);
    expect(assertCanSend.mock.invocationCallOrder[0]).toBeLessThan(
      tickLax.mock.invocationCallOrder[0],
    );
  });
});

describe('MessageController.sendMedia staging (Phase 7)', () => {
  it.each([
    ContentType.IMAGE,
    ContentType.FILE,
    ContentType.VIDEO,
    ContentType.AUDIO,
    ContentType.GALLERY,
  ])(
    'stages %s with fileCnt, gates with assertCanSend, and does NOT tick quota at stage',
    async (contentType) => {
      const stageMedia = vi.fn().mockResolvedValue({ clientMessageId: 'cid' });
      const assertCanSend = vi.fn().mockResolvedValue(undefined);
      const tick = vi.fn().mockResolvedValue(undefined);
      const controller = new MessageController(
        { stageMedia } as never,
        {} as never,
        {} as never,
        {} as never,
        {
          assertP2PWritable: vi.fn().mockResolvedValue(undefined),
        } as never,
        {} as never,
        {} as never,
        { assertCanSend, tick } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const req = {
        user: { userId: 7 },
        threadAccess: {
          threadType: 'P2P',
          membershipActive: true,
          groupDissolved: false,
        },
      } as unknown as FastifyRequest;

      await controller.sendMedia(req, {
        threadId: 42,
        contentType,
        clientMessageId: '00000000-0000-4000-8000-000000000001',
      });

      // Stage carries only message-level intent + fileCnt (default 1). The user breaker is gated here
      // (assertCanSend); the per-file cnt + byte quota is charged at upload admission, NOT here.
      expect(assertCanSend).toHaveBeenCalledWith(7);
      expect(stageMedia).toHaveBeenCalledWith(
        7,
        42,
        contentType,
        '00000000-0000-4000-8000-000000000001',
        1,
        false,
      );
      expect(tick).not.toHaveBeenCalled();
    },
  );

  it('forwards fileCnt for a GALLERY batch', async () => {
    const stageMedia = vi.fn().mockResolvedValue({ clientMessageId: 'cid' });
    const controller = new MessageController(
      { stageMedia } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        assertP2PWritable: vi.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      {} as never,
      { assertCanSend: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const req = {
      user: { userId: 7 },
      threadAccess: {
        threadType: 'P2P',
        membershipActive: true,
        groupDissolved: false,
      },
    } as unknown as FastifyRequest;

    await controller.sendMedia(req, {
      threadId: 42,
      contentType: ContentType.GALLERY,
      clientMessageId: '00000000-0000-4000-8000-000000000002',
      fileCnt: 4,
    });

    expect(stageMedia).toHaveBeenCalledWith(
      7,
      42,
      ContentType.GALLERY,
      '00000000-0000-4000-8000-000000000002',
      4,
      false,
    );
  });
});
