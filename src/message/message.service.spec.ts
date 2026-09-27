// Unit tests for MessageService.attachMediaStatus — the bulk readiness decision that backs the
// query-messages mediaStatus field + mounted-message media-status endpoint. Drizzle is mocked.
import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  derivePreview,
  MessageService,
  stripMessageId,
} from './message.service.js';
import {
  MESSAGE_PROFILE_WORK_COMMITTED,
  type MessageProfileWorkCommittedEvent,
} from './message-profile-work.event.js';
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
  message?: Mock<(...args: unknown[]) => unknown>;
  mediaMessage?: Mock<(...args: unknown[]) => unknown>;
  mediaAsset?: Mock<(...args: unknown[]) => unknown>;
  pendingMedia?: Mock<(...args: unknown[]) => unknown>;
  user?: Mock<(...args: unknown[]) => unknown>;
  execute?: Mock<(...args: unknown[]) => unknown>;
}) {
  return {
    db: {
      query: {
        profileTable: {
          findMany: async () => {
            const rows = (queries.user
              ? await queries.user()
              : [
                  {
                    account: 'alice',
                    domain: 'local',
                    namespaceId: 0,
                    name: 'Alice',
                  },
                ]) as Array<{ name: string }>;
            return rows.map((row: { name: string }) => ({
              ...row,
              displayName: row.name,
              profileRev: 1,
            }));
          },
        },
        message: { findMany: queries.message ?? vi.fn() },
        messageAsset: { findMany: queries.mediaMessage ?? vi.fn() },
        mediaAsset: { findMany: queries.mediaAsset ?? vi.fn() },
        pendingMedia: {
          findMany: queries.pendingMedia ?? vi.fn().mockResolvedValue([]),
        },
        account: {
          findMany:
            queries.user ??
            vi.fn().mockResolvedValue([
              {
                account: 'alice',
                domain: 'local',
                namespaceId: 0,
                name: 'Alice',
              },
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
    creatorNamespaceId: 0,
    profileRev: 1,
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

describe('stripMessageId author projection namespace', () => {
  it('uses namespace zero for a local author returned through a remote stream', () => {
    const result = stripMessageId(
      mk({
        id: 1n,
        seq: 1,
        content: '{}',
        creatorDomain: 'local',
        creatorNamespaceId: 0,
        sourceNamespaceId: 7,
      }),
    );

    expect(result.creator?.namespaceId).toBe(0);
  });

  it('uses the stored subject namespace independently of the message source', () => {
    const result = stripMessageId(
      mk({
        id: 1n,
        seq: 1,
        content: '{}',
        creatorDomain: 'remote.test',
        creatorNamespaceId: 7,
        sourceNamespaceId: 11,
      }),
    );

    expect(result.creator?.namespaceId).toBe(7);
  });
});

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

describe('MessageService committed profile work', () => {
  it('emits profile hints after writeSystemMessage commits', async () => {
    const emit = vi.fn();
    const tx = {};
    const svc = new MessageService(
      {
        db: {
          transaction: vi.fn(async (work) => work(tx)),
          select: vi.fn().mockReturnValue(
            selectBuilder(
              [
                {
                  type: 'P2P',
                  groupAccount: null,
                  groupDomain: null,
                },
              ],
              true,
            ),
          ),
        },
      } as never,
      {} as never,
      {} as never,
      { emit } as never,
    );
    const systemContent = {
      type: 'FRIEND_ADDED' as const,
      participants: [
        {
          account: 'alice',
          domain: 'remote.test',
          namespaceId: 7,
          profileRev: 3,
        },
        {
          account: 'bob',
          domain: 'local',
          namespaceId: 0,
          profileRev: 2,
        },
      ] as const,
    };
    vi.spyOn(svc, 'writeSystemMessageInTx').mockResolvedValue({
      messageId: 1n,
      message: {
        threadId: 9,
        seq: 4,
        profileRev: 0,
        creator: { account: '$system', domain: 'local', namespaceId: 0 },
        contentType: 'SYSTEM',
        content: JSON.stringify(systemContent),
        isDeleted: false,
        localState: 'READY',
      } as never,
    });

    await svc.writeSystemMessage(9, systemContent);

    expect(emit).toHaveBeenCalledOnce();
    const event = emit.mock.calls[0][1] as MessageProfileWorkCommittedEvent;
    expect(event.demands).toEqual([
      {
        namespaceId: 7,
        lookup: 'RELATIONSHIP_INTENT_PROFILE',
        target: { account: 'alice', domain: 'remote.test', rev: 3 },
        peerAccount: 'bob',
      },
    ]);
    expect(event.evidenceProjections).toEqual([]);
  });

  it('emits collected profile work for a committed remote-author message', async () => {
    const emit = vi.fn();
    const svc = new MessageService(
      {
        db: {
          select: vi.fn().mockReturnValue(
            selectBuilder(
              [
                {
                  type: 'P2P',
                  groupAccount: null,
                  groupDomain: null,
                },
              ],
              true,
            ),
          ),
        },
      } as never,
      {} as never,
      {} as never,
      { emit } as never,
    );

    await (svc as unknown as {
      publishCommittedProfileWork(message: unknown): Promise<void>;
    }).publishCommittedProfileWork({
      threadId: 9,
      seq: 4,
      profileRev: 3,
      creator: { account: 'alice', domain: 'remote.test', namespaceId: 7 },
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'hello' }),
      isDeleted: false,
      localState: 'READY',
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toBe(MESSAGE_PROFILE_WORK_COMMITTED);
    const event = emit.mock.calls[0][1] as MessageProfileWorkCommittedEvent;
    expect(event.demands).toEqual([
      {
        namespaceId: 7,
        lookup: 'ACCOUNT_PROFILE',
        target: { account: 'alice', domain: 'remote.test', rev: 3 },
      },
    ]);
    expect(event.evidenceProjections).toEqual([
      {
        profile: {
          namespaceId: 7,
          account: 'alice',
          domain: 'remote.test',
          rev: 3,
        },
        lookup: 'ACCOUNT_PROFILE',
        projection: { threadId: 9, messageSeq: 4 },
      },
    ]);
  });
});

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
            profileTable: { findMany: vi.fn().mockResolvedValue([]) },
            message: { findMany: vi.fn() },
            messageAsset: { findMany: vi.fn().mockResolvedValue([]) },
            mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
            pendingMedia: { findMany: vi.fn().mockResolvedValue([]) },
            account: { findMany: vi.fn().mockResolvedValue([]) },
          },
        },
      } as never,
      {} as never,
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
        profileTable: { findMany: vi.fn().mockResolvedValue([]) },
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
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
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
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
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
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
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
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
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
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
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
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
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

describe('MessageService quote previews', () => {
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
      account: { name: 'Alice' },
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
        message: store.message.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
      {} as never,
    );

    const [out] = await svc['attachQuotePreviews'](
      await svc['queryMessageRows'](svc['database'].db, 1, {}),
    );

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
        message: store.message.findMany,
        mediaMessage: store.mediaMessage.findMany,
        mediaAsset: store.mediaAsset.findMany,
      }) as never,
      {} as never,
      {} as never,
    );

    const [out] = await svc['attachQuotePreviews'](
      await svc['queryMessageRows'](svc['database'].db, 1, {}),
    );

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
      account: { name: 'Alice' },
    };
    const svc = new MessageService(
      databaseMock({ message: vi.fn().mockResolvedValue([target]) }) as never,
      {} as never,
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
      account: { name: 'Alice' },
    };
    const svc = new MessageService(
      databaseMock({ message: vi.fn().mockResolvedValue([target]) }) as never,
      {} as never,
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
      account: { name: 'Bob' },
    };
    const svc = new MessageService(
      databaseMock({
        message: vi.fn().mockResolvedValue([target]),
        user: vi.fn().mockResolvedValue([
          {
            account: 'bob',
            domain: 'local',
            namespaceId: 0,
            name: 'Bob',
          },
        ]),
      }) as never,
      {} as never,
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
