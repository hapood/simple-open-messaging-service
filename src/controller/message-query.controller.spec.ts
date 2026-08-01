import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { MessageController } from './message.controller.js';
import type { QueryMessagesDto } from '../dto/message.dto.js';

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
    const { controller, queryMessages, req } = setup([{ seq: 11 }, { seq: 12 }]);
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

  it('preserves lastSeq=0 as a real keyset cursor', async () => {
    const { controller, queryMessages, req } = setup([{ seq: 1 }]);
    await controller.queryMessages(req, dto({ lastSeq: 0 }));
    expect(queryMessages.mock.calls[0][1].cursor).toEqual({
      threadId_seq: { threadId: 42, seq: 0 },
    });
  });
});
