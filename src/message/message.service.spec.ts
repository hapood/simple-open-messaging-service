// Unit tests for MessageService.attachMediaStatus — the bulk ready/failed判定 that backs the
// query-messages mediaStatus field + the scroll-probe media-status endpoint. Prisma is mocked.
import { describe, it, expect, vi } from 'vitest';
import { MessageService } from './message.service.js';
import type { Message, ContentType } from '../prisma/generated/client.js';

/** Minimal Message row (only the fields attachMediaStatus reads: id, seq, content, contentType). */
function mk(
  p: Partial<Message> & { id: bigint; seq: number; content: string },
): Message {
  return {
    threadId: 1,
    creator: 1,
    contentType: 'IMAGE' as ContentType,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDeleted: false,
    ...p,
  } as Message;
}

const DIG = 'a'.repeat(64); // 64 lowercase hex (sha256) — matches extractDigests' CAS regex
const D2 = 'b'.repeat(64);
const url = (d: string): string =>
  `/uploads/shards/${d.slice(0, 2)}/${d.slice(2, 4)}/${d}.jpg`;

describe('MessageService.attachMediaStatus', () => {
  it('returns [] for empty input', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn() },
      mediaAsset: { findMany: vi.fn() },
    };
    const svc = new MessageService(prisma as never, {} as never);
    expect(await svc.attachMediaStatus([])).toEqual([]);
    expect(prisma.mediaMessage.findMany).not.toHaveBeenCalled();
  });

  it('a non-media message (no digest) is ready', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn() },
    };
    const svc = new MessageService(prisma as never, {} as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, contentType: 'PURE_TEXT', content: 'hello' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].mediaStatus).toBe('ready');
    expect(out[0].sv).toBe(5);
    expect('id' in out[0]).toBe(false); // id is stripped (throughput side-channel)
  });

  it('keeps an inline text quote inside content while stripping the internal id', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn() },
    };
    const svc = new MessageService(prisma as never, {} as never);
    const content = JSON.stringify({
      text: 'reply',
      quote: { seq: 4, preview: 'Alice：original' },
    });
    const input = mk({
      id: 9n,
      seq: 12,
      contentType: 'PURE_TEXT',
      content,
    });

    const [out] = await svc.attachMediaStatus([input]);

    expect(out.content).toBe(content);
    expect('id' in out).toBe(false);
  });

  it('every digest has an authz row + asset refs>0 → ready', async () => {
    const prisma = {
      mediaMessage: {
        findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]),
      },
      mediaAsset: {
        findMany: vi.fn().mockResolvedValue([{ digest: DIG, refs: 1 }]),
      },
    };
    const svc = new MessageService(prisma as never, {} as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('ready');
  });

  it('a digest with no authz row → failed', async () => {
    const prisma = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const svc = new MessageService(prisma as never, {} as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('failed');
  });

  it('a digest whose asset has refs=0 → failed (bytes gone / GC)', async () => {
    const prisma = {
      mediaMessage: {
        findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]),
      },
      mediaAsset: {
        findMany: vi.fn().mockResolvedValue([{ digest: DIG, refs: 0 }]),
      },
    };
    const svc = new MessageService(prisma as never, {} as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('failed');
  });

  it('a batch is served by ONE mediaMessage + ONE mediaAsset query (no per-row N+1)', async () => {
    const prisma = {
      mediaMessage: {
        findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]),
      },
      mediaAsset: {
        findMany: vi.fn().mockResolvedValue([{ digest: DIG, refs: 1 }]),
      },
    };
    const svc = new MessageService(prisma as never, {} as never);
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }), // ready
      mk({ id: 2n, seq: 6, content: JSON.stringify({ url: url(D2) }) }), // failed (D2 absent)
    ]);
    expect(out[0].mediaStatus).toBe('ready');
    expect(out[1].mediaStatus).toBe('failed');
    expect(prisma.mediaMessage.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('MessageService.queryMessages quote previews', () => {
  const replyContent = JSON.stringify({ text: 'reply', quote: { seq: 4 } });

  it('batch-inlines a current target preview without changing stored content', async () => {
    const reply = mk({
      id: 9n,
      seq: 12,
      contentType: 'PURE_TEXT',
      content: replyContent,
    });
    const target = {
      ...mk({
        id: 4n,
        seq: 4,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'original' }),
      }),
      creatorItem: { name: 'Alice' },
    };
    const prisma = {
      message: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([reply])
          .mockResolvedValueOnce([target]),
      },
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const svc = new MessageService(prisma as never, {} as never);

    const [out] = await svc.queryMessages(1, {});

    expect(JSON.parse(out.content)).toEqual({
      text: 'reply',
      quote: { seq: 4, preview: 'Alice：original' },
    });
    expect(reply.content).toBe(replyContent);
    expect(prisma.message.findMany).toHaveBeenCalledTimes(2);
  });

  it('leaves preview absent when the target is unavailable', async () => {
    const reply = mk({
      id: 9n,
      seq: 12,
      contentType: 'PURE_TEXT',
      content: replyContent,
    });
    const prisma = {
      message: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([reply])
          .mockResolvedValueOnce([]),
      },
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const svc = new MessageService(prisma as never, {} as never);

    const [out] = await svc.queryMessages(1, {});

    expect(JSON.parse(out.content)).toEqual({
      text: 'reply',
      quote: { seq: 4 },
    });
  });
});

describe('MessageService.countUnreadByThread', () => {
  it('counts from seq 0 for a null watermark and excludes the current user', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { threadId: 7, unread: 2 },
      { threadId: 8, unread: 0 },
    ]);
    const svc = new MessageService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    await expect(svc.countUnreadByThread(42, [7, 8])).resolves.toEqual(
      new Map([
        [7, 2],
        [8, 0],
      ]),
    );

    const [strings, ...values] = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join('?');
    expect(sql).toContain('msg.seq > COALESCE(tp."lastReadSeq", -1)');
    expect(sql).toContain('msg.creator <>');
    expect(sql).toContain('LIMIT 1000');
    expect(values.filter((value) => value === 42)).toHaveLength(2);
  });

  it('does not query PostgreSQL for an empty thread list', async () => {
    const queryRaw = vi.fn();
    const svc = new MessageService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    await expect(svc.countUnreadByThread(42, [])).resolves.toEqual(new Map());
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('MessageService.unreadMentionStates', () => {
  it('uses semantic entities, ignores escaped protocol text, and preserves both mention kinds', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        threadId: 7,
        content: JSON.stringify({
          text: '大家好 [@所有人](soms://audience/all?v=1)',
        }),
      },
      {
        threadId: 7,
        content: JSON.stringify({ text: '请看 [@我](soms://user/self?v=1)' }),
      },
      {
        threadId: 8,
        content: JSON.stringify({
          text: String.raw`\[@我](soms://user/self?v=1)`,
        }),
      },
    ]);
    const svc = new MessageService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    await expect(svc.unreadMentionStates(42, 'SELF', [7, 8])).resolves.toEqual(
      new Map([
        [7, ['all', 'me']],
        [8, []],
      ]),
    );
  });
});

describe('MessageService unified attention queries', () => {
  it('commits the max read HWM and returns one capped authoritative state', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        lastReadSeq: 9,
        unread: 1000,
        mentionContents: [
          JSON.stringify({ text: '[@所有人](soms://audience/all?v=1)' }),
          JSON.stringify({ text: '[@我](soms://user/self?v=1)' }),
        ],
        account: 'self',
      },
    ]);
    const svc = new MessageService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    await expect(svc.commitReadState(42, 7, 9)).resolves.toEqual({
      lastReadSeq: 9,
      count: 1000,
      mention: ['all', 'me'],
    });
    const [strings] = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join('?');
    expect(sql).toContain('GREATEST(COALESCE("lastReadSeq", -1)');
    expect(sql).toContain('LIMIT 1000');
  });

  it('returns unread count and semantic mention from one PostgreSQL result set', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        threadId: 7,
        unread: 3,
        mentionContents: [
          JSON.stringify({
            text: '大家好 [@所有人](soms://audience/all?v=1)',
          }),
          JSON.stringify({ text: '请看 [@我](soms://user/self?v=1)' }),
        ],
      },
      {
        threadId: 8,
        unread: 1,
        mentionContents: [
          JSON.stringify({ text: String.raw`\[@我](soms://user/self?v=1)` }),
        ],
      },
    ]);
    const svc = new MessageService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    await expect(
      svc.unreadAttentionByThread(42, 'SELF', [7, 8]),
    ).resolves.toEqual(
      new Map([
        [7, { count: 3, mention: ['all', 'me'] }],
        [8, { count: 1, mention: [] }],
      ]),
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('applies global and per-thread dismiss bounds before deriving away count and mention', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        threadId: 7,
        cnt: 2n,
        latest: 12,
        mentionContents: [
          JSON.stringify({ text: '[@我](soms://user/self?v=1)' }),
        ],
      },
    ]);
    const svc = new MessageService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    await expect(
      svc.awayAttentionByThread(42, 'self', 100n, 30, { 7: 10 }, [42]),
    ).resolves.toEqual(
      new Map([[7, { count: 2, latestSeq: 12, mention: ['me'] }]]),
    );

    const [strings] = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join('?');
    expect(sql).toContain('LEFT JOIN thread_hwm');
    expect(sql).toContain('m.seq > COALESCE(h.since_seq, -1)');
    expect(sql.indexOf('m.seq > COALESCE')).toBeLessThan(
      sql.indexOf('ARRAY_AGG(content)'),
    );
  });
});
