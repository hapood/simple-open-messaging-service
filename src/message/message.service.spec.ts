// Unit tests for MessageService.attachMediaStatus — the bulk readiness decision that backs the
// query-messages mediaStatus field + mounted-message media-status endpoint. Drizzle is mocked.
import { describe, it, expect, vi } from 'vitest';
import { derivePreview, MessageService } from './message.service.js';
import type { Message } from './message.service.js';
import type { ContentType } from '../database/enums.js';

describe('derivePreview', () => {
  it('uses one file-set label for every multi-file message', () => {
    expect(
      derivePreview(
        'GALLERY',
        JSON.stringify({ items: [{ kind: 'FILE' }, { kind: 'FILE' }] }),
      ),
    ).toBe('[File set · 2]');
    expect(
      derivePreview(
        'GALLERY',
        JSON.stringify({ items: [{ kind: 'IMAGE' }, { kind: 'VIDEO' }] }),
      ),
    ).toBe('[File set · 2]');
  });
});

function databaseMock(queries: {
  message?: ReturnType<typeof vi.fn>;
  mediaMessage?: ReturnType<typeof vi.fn>;
  mediaAsset?: ReturnType<typeof vi.fn>;
  pendingMedia?: ReturnType<typeof vi.fn>;
  user?: ReturnType<typeof vi.fn>;
  execute?: ReturnType<typeof vi.fn>;
}) {
  return {
    db: {
      query: {
        message: { findMany: queries.message ?? vi.fn() },
        messageAsset: { findMany: queries.mediaMessage ?? vi.fn() },
        mediaAsset: { findMany: queries.mediaAsset ?? vi.fn() },
        pendingMedia: {
          findMany: queries.pendingMedia ?? vi.fn().mockResolvedValue([]),
        },
        user: {
          findMany:
            queries.user ??
            vi
              .fn()
              .mockResolvedValue([
                { account: 'alice', domain: 'local', name: 'Alice' },
              ]),
        },
      },
      execute: queries.execute ?? vi.fn(),
    },
  };
}

/** Minimal persisted Message row with the database's READY default. */
function mk(
  p: Partial<Message> & { id: bigint; seq: number; content: string },
): Message {
  return {
    threadId: 1,
    creatorAccount: 'alice',
    creatorDomain: 'local',
    contentType: 'IMAGE' as ContentType,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDeleted: false,
    localState: 'READY',
    ...p,
  } as Message;
}

const DIG = 'a'.repeat(64); // 64 lowercase hex (sha256) — matches extractDigests' CAS regex
const D2 = 'b'.repeat(64);
const url = (d: string): string =>
  `/uploads/msg-assets/${d.slice(0, 2)}/${d.slice(2, 4)}/${d}`;

function selectBuilder<T>(result: T, resolvesAtLimit = false) {
  const promise = Promise.resolve(result);
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    limit: () => (resolvesAtLimit ? promise : builder),
    then: promise.then.bind(promise),
  };
  return builder;
}

describe('MessageService.queryClientMessagePage', () => {
  it('returns authoritative recovery cursors before querying an out-of-range before cursor', async () => {
    const tx = {
      select: vi.fn().mockReturnValue(
        selectBuilder(
          [
            {
              clearedSeq: 9,
              visibleThroughSeq: null,
              currentEnd: 50,
            },
          ],
          true,
        ),
      ),
      query: { message: { findMany: vi.fn() } },
    };
    const svc = new MessageService(
      {
        db: { transaction: vi.fn((work) => work(tx)) },
      } as never,
      {} as never,
    );

    await expect(
      svc.queryClientMessagePage(7, {
        threadId: 1,
        before: 9,
        take: 3,
      }),
    ).rejects.toMatchObject({
      bizCode: 30006,
      data: { resumeAfter: 9, resumeBefore: 51 },
    });
    expect(tx.query.message.findMany).not.toHaveBeenCalled();
  });

  it('selects messages, visibility, scan metadata, and full intersecting gaps in one snapshot', async () => {
    const rows = [
      mk({
        id: 11n,
        seq: 11,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'eleven' }),
      }),
    ];
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(
          selectBuilder(
            [
              {
                clearedSeq: 9,
                visibleThroughSeq: 45,
                currentEnd: 50,
              },
            ],
            true,
          ),
        )
        .mockReturnValueOnce(
          selectBuilder([
            {
              startSeq: 5,
              endSeq: 25,
              messageSeqOffset: 10,
              recoverable: true,
            },
            {
              startSeq: 31,
              endSeq: 50,
              messageSeqOffset: 10,
              recoverable: false,
            },
          ]),
        ),
      query: { message: { findMany: vi.fn().mockResolvedValue(rows) } },
    };
    const transaction = vi.fn(async (work, config) => {
      expect(config).toEqual({
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
      return work(tx);
    });
    const svc = new MessageService(
      {
        db: {
          transaction,
          query: {
            message: { findMany: vi.fn() },
            messageAsset: { findMany: vi.fn().mockResolvedValue([]) },
            mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
            pendingMedia: { findMany: vi.fn().mockResolvedValue([]) },
            user: { findMany: vi.fn().mockResolvedValue([]) },
          },
        },
      } as never,
      {} as never,
    );

    const page = await svc.queryClientMessagePage(7, {
      threadId: 1,
      after: 10,
      through: 20,
      take: 3,
    });

    expect(page.messages.map((message) => message.seq)).toEqual([11]);
    expect(page.gaps).toEqual([
      { startSeq: 15, endSeq: 35, recoverable: true },
    ]);
    expect(page.scannedThrough).toBe(20);
    expect(page.hasMore).toBe(false);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('rejects a selected message that overlaps a gap from the same snapshot', async () => {
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(
          selectBuilder(
            [
              {
                clearedSeq: null,
                visibleThroughSeq: null,
                currentEnd: 50,
              },
            ],
            true,
          ),
        )
        .mockReturnValueOnce(
          selectBuilder([
            {
              startSeq: 15,
              endSeq: 20,
              messageSeqOffset: 0,
              recoverable: true,
            },
          ]),
        ),
      query: {
        message: {
          findMany: vi.fn().mockResolvedValue([
            mk({
              id: 15n,
              seq: 15,
              contentType: 'PURE_TEXT',
              content: JSON.stringify({ text: 'invalid overlap' }),
            }),
          ]),
        },
      },
    };
    const svc = new MessageService(
      {
        db: {
          transaction: vi.fn((work) => work(tx)),
        },
      } as never,
      {} as never,
    );

    await expect(
      svc.queryClientMessagePage(7, {
        threadId: 1,
        after: 10,
        through: 20,
        take: 3,
      }),
    ).rejects.toThrow('message 1:15 overlaps a history gap');
  });
});

describe('MessageService.attachMediaStatus', () => {
  it('returns [] for empty input', async () => {
    const store = {
      mediaMessage: { findMany: vi.fn() },
      mediaAsset: { findMany: vi.fn() },
    };
    const svc = new MessageService(
      databaseMock({
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );
    expect(await svc.attachMediaStatus([])).toEqual([]);
    expect(store.mediaMessage.findMany).not.toHaveBeenCalled();
  });

  it('a non-media message (no digest) is ready', async () => {
    const store = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn() },
    };
    const svc = new MessageService(
      databaseMock({
        message: store.message?.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, contentType: 'PURE_TEXT', content: 'hello' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].mediaStatus).toBe('ready');
    expect('sv' in out[0]).toBe(false);
    expect('id' in out[0]).toBe(false); // id is stripped (throughput side-channel)
  });

  it('keeps an inline text quote inside content while stripping the internal id', async () => {
    const store = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn() },
    };
    const svc = new MessageService(
      databaseMock({
        message: store.message?.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );
    const content = JSON.stringify({
      text: 'reply',
      quote: { seq: 4, author: 'Alice', body: 'original' },
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

  it('every digest has an authz row + READY asset → ready', async () => {
    const store = {
      mediaMessage: {
        findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]),
      },
      mediaAsset: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ digest: DIG, isDeleted: false }]),
      },
    };
    const svc = new MessageService(
      databaseMock({
        message: store.message?.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('ready');
  });

  it.each([
    ['pending', 'pending'],
    ['downloading', 'downloading'],
  ] as const)('maps an inbound STUB %s job to %s', async (job, expected) => {
    const svc = new MessageService(
      databaseMock({
        mediaMessage: vi.fn().mockResolvedValue([]),
        mediaAsset: vi.fn().mockResolvedValue([]),
        pendingMedia: vi
          .fn()
          .mockResolvedValue([{ messageId: 1n, status: job }]),
      }) as never,
      {} as never,
    );
    const out = await svc.attachMediaStatus([
      mk({
        id: 1n,
        seq: 5,
        localState: 'STUB',
        content: JSON.stringify({ url: url(DIG) }),
      }),
    ]);

    expect(out[0].mediaStatus).toBe(expected);
  });

  it('maps an inbound FAILED message to failed while retaining its job row', async () => {
    const svc = new MessageService(
      databaseMock({
        mediaMessage: vi.fn().mockResolvedValue([]),
        mediaAsset: vi.fn().mockResolvedValue([]),
        pendingMedia: vi
          .fn()
          .mockResolvedValue([{ messageId: 1n, status: 'failed' }]),
      }) as never,
      {} as never,
    );
    const out = await svc.attachMediaStatus([
      mk({
        id: 1n,
        seq: 5,
        localState: 'FAILED',
        content: JSON.stringify({ url: url(DIG) }),
      }),
    ]);

    expect(out[0].mediaStatus).toBe('failed');
  });

  it('a digest with no authz row → failed', async () => {
    const store = {
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const svc = new MessageService(
      databaseMock({
        message: store.message?.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('failed');
  });

  it('a READY asset does not depend on a cached reference count', async () => {
    const store = {
      mediaMessage: {
        findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]),
      },
      mediaAsset: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ digest: DIG, isDeleted: false }]),
      },
    };
    const svc = new MessageService(
      databaseMock({
        message: store.message?.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('ready');
  });

  it('a reaped (non-live) asset is not exposed as ready', async () => {
    const svc = new MessageService(
      databaseMock({
        mediaMessage: vi
          .fn()
          .mockResolvedValue([{ messageId: 1n, digest: DIG }]),
        mediaAsset: vi
          .fn()
          .mockResolvedValue([{ digest: DIG, isDeleted: true }]),
      }) as never,
      {} as never,
    );
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }),
    ]);
    expect(out[0].mediaStatus).toBe('failed');
  });

  it('a batch is served by ONE mediaMessage + ONE mediaAsset query (no per-row N+1)', async () => {
    const store = {
      mediaMessage: {
        findMany: vi.fn().mockResolvedValue([{ messageId: 1n, digest: DIG }]),
      },
      mediaAsset: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ digest: DIG, isDeleted: false }]),
      },
    };
    const svc = new MessageService(
      databaseMock({
        message: store.message?.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );
    const out = await svc.attachMediaStatus([
      mk({ id: 1n, seq: 5, content: JSON.stringify({ url: url(DIG) }) }), // ready
      mk({ id: 2n, seq: 6, content: JSON.stringify({ url: url(D2) }) }), // failed (D2 absent)
    ]);
    expect(out[0].mediaStatus).toBe('ready');
    expect(out[1].mediaStatus).toBe('failed');
    expect(store.mediaMessage.findMany).toHaveBeenCalledTimes(1);
    expect(store.mediaAsset.findMany).toHaveBeenCalledTimes(1);
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
      user: { name: 'Alice' },
    };
    const store = {
      message: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([reply])
          .mockResolvedValueOnce([target]),
      },
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const svc = new MessageService(
      databaseMock({
        message: store.message?.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );

    const [out] = await svc.queryMessages(1, {});

    expect(JSON.parse(out.content)).toEqual({
      text: 'reply',
      quote: {
        seq: 4,
        author: 'Alice',
        body: 'original',
        contentType: 'PURE_TEXT',
      },
    });
    expect(reply.content).toBe(replyContent);
    expect(store.message.findMany).toHaveBeenCalledTimes(2);
  });

  it('leaves preview absent when the target is unavailable', async () => {
    const reply = mk({
      id: 9n,
      seq: 12,
      contentType: 'PURE_TEXT',
      content: replyContent,
    });
    const store = {
      message: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([reply])
          .mockResolvedValueOnce([]),
      },
      mediaMessage: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const svc = new MessageService(
      databaseMock({
        message: store.message?.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
    );

    const [out] = await svc.queryMessages(1, {});

    expect(JSON.parse(out.content)).toEqual({
      text: 'reply',
      quote: { seq: 4 },
    });
  });

  it('combines the shared image summary with independent reply visual metadata', async () => {
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
        contentType: 'IMAGE',
        content: JSON.stringify({
          url: '/uploads/cas/aa/bb/asset.jpg',
          size: 2048,
        }),
      }),
      user: { name: 'Alice' },
    };
    const svc = new MessageService(
      databaseMock({ message: vi.fn().mockResolvedValue([target]) }) as never,
      {} as never,
    );

    const [out] = await svc.attachQuotePreviews([reply]);

    expect(JSON.parse(out.content).quote).toEqual({
      seq: 4,
      author: 'Alice',
      body: '[Photo]',
      contentType: 'IMAGE',
      image: '/uploads/cas/aa/bb/asset.jpg',
      imageSize: 2048,
      imageShape: 'thumbnail',
    });
  });

  it('uses a link card title and thumbnail in a reply preview', async () => {
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
        contentType: 'LINK',
        content: JSON.stringify({
          url: 'https://example.com/article',
          title: '',
          description: 'Example article description',
          image: 'data:image/webp;base64,preview',
        }),
      }),
      user: { name: 'Alice' },
    };
    const svc = new MessageService(
      databaseMock({ message: vi.fn().mockResolvedValue([target]) }) as never,
      {} as never,
    );

    const [out] = await svc.attachQuotePreviews([reply]);

    expect(JSON.parse(out.content).quote).toEqual({
      seq: 4,
      author: 'Alice',
      body: 'Example article description',
      contentType: 'LINK',
      image: 'data:image/webp;base64,preview',
      imageShape: 'thumbnail',
    });
  });

  it('uses contact card identity and avatar in a reply preview', async () => {
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
        contentType: 'CONTACT_CARD',
        creatorAccount: 'bob',
        content: JSON.stringify({
          account: 'alice',
          domain: 'remote.example',
          displayName: 'Alice',
          avatar: '/uploads/cas/aa/bb/avatar.webp',
        }),
      }),
      user: { name: 'Bob' },
    };
    const svc = new MessageService(
      databaseMock({
        message: vi.fn().mockResolvedValue([target]),
        user: vi
          .fn()
          .mockResolvedValue([
            { account: 'bob', domain: 'local', name: 'Bob' },
          ]),
      }) as never,
      {} as never,
    );

    const [out] = await svc.attachQuotePreviews([reply]);

    expect(JSON.parse(out.content).quote).toEqual({
      seq: 4,
      author: 'Bob',
      body: '[Contact] Alice',
      contentType: 'CONTACT_CARD',
      image: '/uploads/cas/aa/bb/avatar.webp',
      imageLabel: 'Alice',
      imageIdentity: 'alice',
      imageShape: 'avatar',
    });
  });
});

describe('MessageService.unreadMentionStates', () => {
  it('uses semantic entities, ignores escaped protocol text, and preserves both mention kinds', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        threadId: 7,
        content: JSON.stringify({
          text: '大家好 [@所有人](somfp://audience/all)',
        }),
      },
      {
        threadId: 7,
        content: JSON.stringify({ text: '请看 [@我](somfp://user/self)' }),
      },
      {
        threadId: 8,
        content: JSON.stringify({
          text: String.raw`\[@我](somfp://user/self)`,
        }),
      },
    ]);
    const svc = new MessageService(
      databaseMock({
        execute: vi.fn(async () => ({ rows: await queryRaw() })),
      }) as never,
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
        readRevision: 4,
        unread: 1000,
        mentionContents: [
          JSON.stringify({ text: '[@所有人](somfp://audience/all)' }),
          JSON.stringify({ text: '[@我](somfp://user/self)' }),
        ],
        account: 'self',
      },
    ]);
    const svc = new MessageService(
      databaseMock({
        execute: vi.fn(async () => ({ rows: await queryRaw() })),
      }) as never,
      {} as never,
    );

    await expect(svc.commitReadState(42, 7, 9)).resolves.toEqual({
      lastReadSeq: 9,
      readRevision: 4,
      count: 1000,
      mention: ['all', 'me'],
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns unread count and semantic mention from one PostgreSQL result set', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        threadId: 7,
        unread: 3,
        mentionContents: [
          JSON.stringify({
            text: '大家好 [@所有人](somfp://audience/all)',
          }),
          JSON.stringify({ text: '请看 [@我](somfp://user/self)' }),
        ],
      },
      {
        threadId: 8,
        unread: 1,
        mentionContents: [
          JSON.stringify({ text: String.raw`\[@我](somfp://user/self)` }),
        ],
      },
    ]);
    const svc = new MessageService(
      databaseMock({
        execute: vi.fn(async () => ({ rows: await queryRaw() })),
      }) as never,
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
        mentionContents: [JSON.stringify({ text: '[@我](somfp://user/self)' })],
      },
    ]);
    const svc = new MessageService(
      databaseMock({
        execute: vi.fn(async () => ({ rows: await queryRaw() })),
      }) as never,
      {} as never,
    );

    await expect(
      svc.awayAttentionByThread(
        42,
        'self',
        30,
        { 7: 10 },
        [42],
        1000,
        undefined,
        100n,
      ),
    ).resolves.toEqual(
      new Map([[7, { count: 2, latestSeq: 12, mention: ['me'] }]]),
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
