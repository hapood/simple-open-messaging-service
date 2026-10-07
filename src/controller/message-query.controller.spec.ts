import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { MessageController } from './message.controller.js';
import type { QueryMessagesDto } from '../dto/message.dto.js';
import { ContentType } from '../database/enums.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

function setup(rows: Array<{ seq: number }> = []) {
  const queryClientMessagePage = vi
    .fn()
    .mockImplementation((_userId, query) => {
      if (query.after === undefined && query.before === undefined)
        throw new BusinessException(
          BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
          'after or before is required; initialize the message query cursor',
          200,
          { resumeAfter: 0, resumeBefore: 21 },
        );
      const selected = rows.slice(0, query.take);
      const hasMore = rows.length > query.take;
      return {
        messages: selected,
        gaps: [],
        scannedThrough: hasMore
          ? selected.at(-1)!.seq
          : query.after !== undefined
            ? (query.through ?? 20)
            : (query.through ?? 1),
        hasMore,
      };
    });
  const queryTombstones = vi.fn().mockResolvedValue({
    tombstones: [],
    scannedThrough: 1,
    hasMore: false,
  });
  const controller = new MessageController(
    { queryClientMessagePage } as never,
    { blockedByMe: vi.fn().mockResolvedValue(new Set<number>()) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { queryThread: queryTombstones } as never,
    { queryThread: vi.fn().mockResolvedValue([]) } as never,
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
      clearedSeq: null,
      participant: {},
    },
  } as unknown as FastifyRequest;
  return {
    controller,
    queryClientMessagePage,
    queryTombstones,
    req,
  };
}

function dto(overrides: Partial<QueryMessagesDto> = {}): QueryMessagesDto {
  return {
    threadId: 42,
    take: 3,
    after: 10,
    ...overrides,
  };
}

describe('MessageController.queryMessages cursor contract', () => {
  it('maps a bounded forward interval and returns a direction-relative cursor', async () => {
    const { controller, queryClientMessagePage, req } = setup([
      { seq: 11 },
      { seq: 12 },
    ]);
    const result = await controller.queryMessages(req, dto({ through: 15 }));

    expect(queryClientMessagePage).toHaveBeenCalledWith(1, {
      threadId: 42,
      after: 10,
      before: undefined,
      through: 15,
      take: 3,
    });
    expect(result.gaps).toEqual([]);
    expect(result.messages.map((row) => row.seq)).toEqual([11, 12]);
    expect(result.scannedThrough).toBe(15);
    expect(result.hasMore).toBe(false);
  });

  it('maps a bounded reverse interval and continues from the smallest returned seq', async () => {
    const { controller, req } = setup([
      { seq: 9 },
      { seq: 8 },
      { seq: 7 },
      { seq: 6 },
    ]);
    const result = await controller.queryMessages(
      req,
      dto({ after: undefined, before: 10, through: 2 }),
    );

    expect(result.messages.map((row) => row.seq)).toEqual([9, 8, 7]);
    expect(result.scannedThrough).toBe(7);
    expect(result.hasMore).toBe(true);
  });

  it('returns both exclusive start cursors when the direction is omitted', async () => {
    const { controller, queryClientMessagePage, req } = setup();
    await expect(
      controller.queryMessages(req, dto({ after: undefined, take: undefined })),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
      status: 200,
      data: { resumeAfter: 0, resumeBefore: 21 },
    });
    expect(queryClientMessagePage).toHaveBeenCalledOnce();
  });
});

describe('MessageController.queryDeletedMessages cursor contract', () => {
  it('passes an exclusive reverse cursor and inclusive through boundary', async () => {
    const { controller, queryTombstones } = setup();
    await controller.queryDeletedMessages({
      threadId: 42,
      before: 10,
      through: 2,
      take: 20,
    });
    expect(queryTombstones).toHaveBeenCalledWith(
      42,
      undefined,
      20,
      2,
      10,
      undefined,
    );
  });

  it('rejects supplying both tombstone cursors', async () => {
    const { controller, queryTombstones } = setup();
    await expect(
      controller.queryDeletedMessages({
        threadId: 42,
        after: 1,
        before: 10,
        take: 20,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
      status: 400,
    });
    expect(queryTombstones).not.toHaveBeenCalled();
  });
});

describe('MessageController group mention resolution', () => {
  function setupMentionResolver() {
    const resolveActiveMember = vi.fn().mockResolvedValue({
      userId: 8,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      name: 'Alice',
    });
    const controller = new MessageController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { resolveActiveMember } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const req = {
      threadAccess: {
        threadId: 42,
        threadType: 'GROUP',
        participant: { role: 'MEMBER' },
      },
    } as unknown as FastifyRequest;
    const canonicalize = (
      controller as unknown as {
        canonicalizeMentions(
          request: FastifyRequest,
          content: string,
        ): Promise<string>;
      }
    ).canonicalizeMentions.bind(controller);
    return { canonicalize, req, resolveActiveMember };
  }

  it('resolves a namespace/account entity through the shared group member resolver', async () => {
    const { canonicalize, req, resolveActiveMember } = setupMentionResolver();

    await expect(
      canonicalize(req, 'hello [@Old](somfp://user/0/alice)'),
    ).resolves.toBe('hello [@Alice](somfp://user/0/alice)');
    expect(resolveActiveMember).toHaveBeenCalledWith(42, {
      namespaceId: 0,
      account: 'alice',
    });
  });

  it('treats a user mention without a namespace as ordinary text', async () => {
    const { canonicalize, req, resolveActiveMember } = setupMentionResolver();

    // A v1 user entity requires two path segments (namespace/account). A single
    // segment is malformed and stays ordinary text; the resolver is not called.
    await expect(
      canonicalize(req, 'hello [@Alice](somfp://user/alice)'),
    ).resolves.toBe('hello [@Alice](somfp://user/alice)');
    expect(resolveActiveMember).not.toHaveBeenCalled();
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
        return { id: '9', threadId: 42, seq: 3, deletionSeq: 6 };
      },
    );
    const controller = new MessageController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { assertCanSend, tickLax } as never,
      { withdraw } as never,
      {} as never,
      {} as never,
      {} as never,
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
        {
          assertP2PWritable: vi.fn().mockResolvedValue(undefined),
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { assertCanSend, tick } as never,
        {} as never,
        {} as never,
        {} as never,
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
        undefined,
      );
      expect(tick).not.toHaveBeenCalled();
    },
  );

  it('forwards a staged quote target into stageMedia', async () => {
    const stageMedia = vi.fn().mockResolvedValue({ clientMessageId: 'cid' });
    const controller = new MessageController(
      { stageMedia } as never,
      {} as never,
      {} as never,
      {
        assertP2PWritable: vi.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { assertCanSend: vi.fn(), tick: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
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
      contentType: ContentType.IMAGE,
      clientMessageId: '00000000-0000-4000-8000-000000000003',
      quoteTargetSeq: 4,
    });

    expect(stageMedia).toHaveBeenCalledWith(
      7,
      42,
      ContentType.IMAGE,
      '00000000-0000-4000-8000-000000000003',
      1,
      false,
      4,
    );
  });

  it('forwards fileCnt for a GALLERY batch', async () => {
    const stageMedia = vi.fn().mockResolvedValue({ clientMessageId: 'cid' });
    const controller = new MessageController(
      { stageMedia } as never,
      {} as never,
      {} as never,
      {
        assertP2PWritable: vi.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { assertCanSend: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
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
      undefined,
    );
  });
});

describe('MessageController.abandonMediaStage', () => {
  it('abandons the caller-owned staged media send', async () => {
    const abandonMediaStage = vi.fn().mockResolvedValue({ abandoned: true });
    const controller = new MessageController(
      { abandonMediaStage } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const req = { user: { userId: 7 } } as unknown as FastifyRequest;

    await controller.abandonMediaStage(req, {
      threadId: 42,
      clientMessageId: '00000000-0000-4000-8000-000000000003',
    });

    expect(abandonMediaStage).toHaveBeenCalledWith(
      7,
      42,
      '00000000-0000-4000-8000-000000000003',
    );
  });
});
