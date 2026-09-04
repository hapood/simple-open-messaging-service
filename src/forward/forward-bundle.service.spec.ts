import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import { forwardBundle } from '../database/schema.js';
import {
  FORWARD_MAX_WIRE_JSON_BYTES,
  ForwardBundleService,
  localizeForwardMediaContent,
} from './forward-bundle.service.js';

function sourceRow(childDepth: number) {
  return {
    id: 1n,
    seq: 7,
    threadId: 4,
    creatorAccount: 'alice',
    creatorDomain: 'local',
    creatorNamespaceId: 0,
    profileRev: 1,
    contentType: ContentType.FORWARD,
    content: JSON.stringify({ version: 1, bundleId: 'child' }),
    createdAt: new Date('2026-07-31T00:00:00Z'),
    updatedAt: new Date('2026-07-31T00:00:00Z'),
    isDeleted: false,
    clientMessageId: null,
    originSeq: 7,
    originServerTime: null,
    creatorItem: {
      account: 'alice',
      domain: 'local',
      name: 'Alice',
      avatar: '',
    },
    forwardMessage: {
      bundleId: '01childbundle00000000000000',
      bundle: { id: '01childbundle00000000000000', depth: childDepth },
    },
  };
}

function sourceQueryRow(childDepth: number) {
  const row = sourceRow(childDepth);
  return {
    ...row,
    user: row.creatorItem,
    forwardMessages: [
      { ...row.forwardMessage, forwardBundle: row.forwardMessage.bundle },
    ],
  };
}

function textSourceRow(seq: number, content: string, name: string) {
  return {
    ...sourceRow(0),
    id: BigInt(seq),
    seq,
    contentType: ContentType.PURE_TEXT,
    content,
    creatorItem: {
      account: name.toLowerCase(),
      domain: 'local',
      name,
      avatar: '',
    },
    forwardMessage: null,
  };
}

function textQueryRow(seq: number, content: string, name: string) {
  const row = textSourceRow(seq, content, name);
  return { ...row, user: row.creatorItem, forwardMessages: [] };
}

function databaseFake(childDepth: number, tx?: unknown) {
  const findMemberships = vi.fn().mockResolvedValue([
    {
      threadId: 4,
      clearedSeq: null,
      blocked: false,
      messageThread: { type: 'P2P' },
    },
  ]);
  return {
    db: {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            authorized: true,
            displayName: 'Alice',
            avatar: '',
          },
        ],
      }),
      select: vi.fn(() => {
        const query = {
          from: () => query,
          innerJoin: () => query,
          where: () => findMemberships(),
        };
        return query;
      }),
      query: {
        accountThreadState: {
          findMany: findMemberships,
        },
        message: {
          findFirst: vi.fn().mockResolvedValue(sourceQueryRow(childDepth)),
        },
        user: {
          findFirst: vi.fn().mockResolvedValue({
            account: 'alice',
            domain: 'local',
            name: 'Alice',
            avatar: '',
          }),
        },
        mediaAsset: {
          findFirst: vi.fn().mockResolvedValue({
            digest: 'a'.repeat(64),
            bytes: 10n,
            status: 'READY',
            createdAt: new Date(),
          }),
        },
        messageAsset: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        forwardBundle: {
          findFirst: vi.fn().mockResolvedValue({
            id: '01childbundle00000000000000',
            messages: [
              {
                id: 1,
                author: { account: 'a', domain: 'local' },
                profile: { displayName: 'A' },
                contentType: 'PURE_TEXT',
                content: JSON.stringify({ text: 'nested' }),
                sentAt: 1,
              },
            ],
            forwardBundleDependencies_parentBundleId: [],
            forwardBundleAssets: [],
          }),
          findMany: vi.fn().mockResolvedValue([
            {
              id: '01childbundle00000000000000',
              messages: [
                {
                  id: 1,
                  author: { account: 'a', domain: 'local' },
                  profile: { displayName: 'A' },
                  contentType: 'PURE_TEXT',
                  content: JSON.stringify({ text: 'nested' }),
                  sentAt: 1,
                },
              ],
            },
          ]),
        },
      },
      transaction: vi.fn(async (work: (client: unknown) => Promise<void>) =>
        work(tx),
      ),
    },
  };
}

const messageServiceFake = {
  attachQuotePreviews: vi.fn(
    async (
      rows: ReturnType<typeof textQueryRow>[],
      filters?: Map<number, unknown>,
    ) =>
      rows.map((row) => {
        void filters;
        const content = JSON.parse(row.content) as {
          text?: string;
          quote?: { seq: number; preview?: string };
        };
        return content.quote
          ? {
              ...row,
              content: JSON.stringify({
                ...content,
                quote: {
                  ...content.quote,
                  author: 'Alice',
                  body: 'original',
                },
              }),
            }
          : row;
      }),
  ),
};

function forwardService(database: unknown) {
  return new ForwardBundleService(
    database as never,
    messageServiceFake as never,
    {
      findVisibleByThreadSeq: vi.fn().mockResolvedValue(null),
    } as never,
  );
}

describe('ForwardBundleService', () => {
  it.each([
    [
      ContentType.PURE_TEXT,
      JSON.stringify({ text: 'hello\nworld' }),
      'hello world',
    ],
    [ContentType.IMAGE, '', '[Photo]'],
    [
      ContentType.LINK,
      JSON.stringify({ title: 'Example', url: 'https://example.test' }),
      'Example',
    ],
    [
      ContentType.GALLERY,
      JSON.stringify({ items: [{ kind: 'IMAGE' }, { kind: 'VIDEO' }] }),
      '[File set · 2]',
    ],
    [ContentType.CALL, JSON.stringify({ outcome: 'missed' }), '[Missed call]'],
  ])(
    'uses the shared %s message preview in forward-card summaries',
    (contentType, content, expected) => {
      const service = forwardService(databaseFake(0));

      expect(
        service['summaryLine']({
          author: {
            account: 'alice',
            domain: 'local',
          },
          profile: { displayName: 'Alice' },
          contentType,
          content,
        } as never),
      ).toBe(`Alice：${expected}`);
    },
  );

  it('collects both LINK artwork digests for forward-bundle authorization', async () => {
    const database = databaseFake(0);
    const service = forwardService(database);
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    database.db.query.mediaAsset.findFirst
      .mockResolvedValueOnce({ digest: first, bytes: 10n })
      .mockResolvedValueOnce({ digest: second, bytes: 20n });

    await expect(
      service['assetsFromContent'](
        ContentType.LINK,
        JSON.stringify({
          url: 'https://example.test',
          title: 'Example',
          description: '',
          image: `/uploads/msg-assets/aa/aa/${first}`,
          favicon: `/uploads/msg-assets/bb/bb/${second}`,
        }),
      ),
    ).resolves.toEqual([
      { digest: first, bytes: 10 },
      { digest: second, bytes: 20 },
    ]);
  });

  it('builds a closure containing an imported minimal forward card', async () => {
    const database = databaseFake(0) as ReturnType<typeof databaseFake>;
    database.db.query.forwardBundle.findFirst.mockResolvedValueOnce({
      id: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      messages: [
        {
          id: 1,
          author: { account: 'a', domain: 'remote.test' },
          profile: { displayName: 'A' },
          contentType: ContentType.FORWARD,
          content: JSON.stringify({
            bundleId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          }),
          childBundleId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          sentAt: 1,
        },
      ],
      forwardBundleDependencies_parentBundleId: [
        { childBundleId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      ],
      forwardBundleAssets: [],
    });
    database.db.query.forwardBundle.findMany.mockResolvedValueOnce([
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        messages: [
          {
            id: 1,
            author: { account: 'b', domain: 'remote.test' },
            profile: { displayName: 'B' },
            contentType: ContentType.PURE_TEXT,
            content: JSON.stringify({ text: 'nested' }),
            sentAt: 1,
          },
        ],
      },
    ]);
    const service = forwardService(database);

    await expect(
      service.buildClosure('01BX5ZZKBKACTAV9WEVGEMMVRZ'),
    ).resolves.toMatchObject({
      messages: [
        {
          content: JSON.stringify({
            bundleId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          }),
        },
      ],
    });
  });

  it('directly forwards text as the caller without retaining its quote', async () => {
    const database = databaseFake(0);
    const service = new ForwardBundleService(
      database as never,
      messageServiceFake as never,
      {
        findVisibleByThreadSeq: vi.fn().mockResolvedValue({
          id: 7n,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({ text: 'reply', quote: { seq: 3 } }),
        }),
      } as never,
    );

    await expect(
      service.prepareDirectMessage(9, { threadId: 4, seq: 7 }),
    ).resolves.toEqual({
      content: JSON.stringify({ text: 'reply' }),
      contentType: ContentType.PURE_TEXT,
    });
  });

  it.each([ContentType.CALL])(
    'rejects direct forwarding of system message type %s',
    async (contentType) => {
      const service = new ForwardBundleService(
        databaseFake(0) as never,
        messageServiceFake as never,
        {
          findVisibleByThreadSeq: vi.fn().mockResolvedValue({
            id: 7n,
            contentType,
            content: '{}',
          }),
        } as never,
      );

      await expect(
        service.prepareDirectMessage(9, { threadId: 4, seq: 7 }),
      ).rejects.toMatchObject<Partial<BusinessException>>({
        bizCode: BusinessCode.FORWARD_INVALID_BUNDLE,
      });
    },
  );

  it('rejects direct media forwarding when its CAS digest is not bound to the visible source', async () => {
    const digest = 'a'.repeat(64);
    const database = databaseFake(0);
    const service = new ForwardBundleService(
      database as never,
      messageServiceFake as never,
      {
        findVisibleByThreadSeq: vi.fn().mockResolvedValue({
          id: 7n,
          contentType: ContentType.IMAGE,
          content: JSON.stringify({
            url: `/uploads/msg-assets/aa/aa/${digest}?threadId=4&seq=7`,
            w: 10,
            h: 10,
          }),
        }),
      } as never,
    );

    await expect(
      service.prepareDirectMessage(9, { threadId: 4, seq: 7 }),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FORWARD_INVALID_BUNDLE,
    });
  });

  it('rebuilds a federated absolute media URL as a local CAS path', () => {
    const digest = 'a'.repeat(64);
    const content = localizeForwardMediaContent(
      ContentType.IMAGE,
      JSON.stringify({
        url: `https://evil.test/uploads/msg-assets/aa/aa/${digest}`,
        w: 1,
        h: 1,
      }),
      [
        {
          digest,
          bytes: 10,
        },
      ],
    );

    expect(JSON.parse(content)).toMatchObject({
      url: `/uploads/msg-assets/aa/aa/${digest}`,
      w: 1,
      h: 1,
    });
  });

  it('snapshots attachment metadata without requiring the CAS blob to exist', async () => {
    const digest = 'a'.repeat(64);
    const database = databaseFake(0) as ReturnType<typeof databaseFake>;
    database.db.query.mediaAsset.findFirst.mockResolvedValueOnce({
      digest,
      bytes: 10n,
      status: 'PENDING',
      createdAt: new Date(),
    });
    const service = forwardService(database);

    await expect(
      service['assetsFromContent'](
        ContentType.FILE,
        JSON.stringify({
          url: `/uploads/msg-assets/aa/aa/${digest}`,
          name: 'quarterly-report-with-a-long-name.pdf',
          size: 10,
          mimeType: 'application/pdf',
        }),
      ),
    ).resolves.toMatchObject([{ digest, bytes: 10 }]);
  });

  it('assigns every message an ordered id and links the reply to its selected target', async () => {
    const target = textQueryRow(
      4,
      JSON.stringify({ text: 'original' }),
      'Alice',
    );
    const reply = textQueryRow(
      7,
      JSON.stringify({ text: 'reply', quote: { seq: 4 } }),
      'Bob',
    );
    const database = databaseFake(0) as ReturnType<typeof databaseFake>;
    database.db.query.message.findFirst
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(reply);
    const service = forwardService(database);

    const prepared = await service.prepareFromMessages(9, [
      { threadId: 4, seq: 4 },
      { threadId: 4, seq: 7 },
    ]);

    expect(prepared.messages[0]).toMatchObject({ id: 1 });
    expect(prepared.messages[1]).toMatchObject({ id: 2 });
    expect(prepared.messages[1].quoteTargetId).toBe(1);
  });

  it('omits an unselected quote target', async () => {
    const reply = textQueryRow(
      7,
      JSON.stringify({ text: 'reply', quote: { seq: 4 } }),
      'Bob',
    );
    const database = databaseFake(0) as ReturnType<typeof databaseFake>;
    database.db.query.message.findFirst.mockResolvedValueOnce(reply);
    const service = forwardService(database);

    const prepared = await service.prepareFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(prepared.messages).toHaveLength(1);
    expect(prepared.messages[0]).toMatchObject({ id: 1 });
    expect(prepared.messages[0].quoteTargetId).toBeUndefined();
  });

  it('omits the optional profile when the exact message revision is unavailable', async () => {
    const database = databaseFake(0) as ReturnType<typeof databaseFake>;
    database.db.execute
      .mockResolvedValueOnce({ rows: [{ authorized: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = forwardService(database);

    const prepared = await service.prepareFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(prepared.messages[0].author).toEqual({
      account: 'alice',
      domain: process.env.SOMS_DOMAIN ?? 'local',
    });
    expect(prepared.messages[0].profile).toBeUndefined();
  });

  it('keeps a known avatarless exact profile without inventing an avatar', async () => {
    const database = databaseFake(0);
    const service = forwardService(database);

    const prepared = await service.prepareFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(prepared.messages[0].profile).toEqual({ displayName: 'Alice' });
    expect(prepared.assets).toEqual([]);
  });

  it('omits the complete profile when its referenced avatar cannot be snapshotted', async () => {
    const database = databaseFake(0) as ReturnType<typeof databaseFake>;
    database.db.execute.mockResolvedValue({
      rows: [
        {
          authorized: true,
          displayName: 'Alice',
          avatar: '/uploads/missing.webp',
        },
      ],
    });
    const service = forwardService(database);
    vi.spyOn(service, 'snapshotAvatarForMessage').mockResolvedValue(null);

    const prepared = await service.prepareFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(prepared.messages[0].profile).toBeUndefined();
    expect(prepared.assets).toEqual([]);
  });

  it('reuses cleared-history filters when resolving quote previews', async () => {
    const clearedSeq = 3;
    const reply = textQueryRow(
      7,
      JSON.stringify({ text: 'reply', quote: { seq: 4 } }),
      'Bob',
    );
    const database = databaseFake(0) as ReturnType<typeof databaseFake>;
    database.db.query.accountThreadState.findMany.mockResolvedValueOnce([
      {
        threadId: 4,
        clearedSeq,
        blocked: false,
        messageThread: { type: 'P2P' },
      },
    ]);
    database.db.query.message.findFirst.mockResolvedValueOnce(reply);
    messageServiceFake.attachQuotePreviews.mockClear();
    const service = forwardService(database);

    await service.prepareFromMessages(9, [{ threadId: 4, seq: 7 }]);

    const filters = messageServiceFake.attachQuotePreviews.mock.calls[0][1];
    expect(filters.get(4)).toEqual({
      clearedThroughSeq: clearedSeq,
    });
  });

  it.each([
    ['cleared history', 7, false],
    ['a blocked thread', null, true],
  ])(
    'rejects a source message hidden by %s',
    async (_label, clearedSeq, blocked) => {
      const database = databaseFake(0) as ReturnType<typeof databaseFake>;
      database.db.query.accountThreadState.findMany.mockResolvedValueOnce([
        {
          threadId: 4,
          clearedSeq,
          blocked,
          messageThread: { type: 'P2P' },
        },
      ]);
      messageServiceFake.attachQuotePreviews.mockClear();
      const service = forwardService(database);

      await expect(
        service.prepareFromMessages(9, [{ threadId: 4, seq: 7 }]),
      ).rejects.toMatchObject<Partial<BusinessException>>({
        bizCode: BusinessCode.FORWARD_INVALID_BUNDLE,
      });
      expect(messageServiceFake.attachQuotePreviews).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'duplicate seq',
      [
        { threadId: 4, seq: 7 },
        { threadId: 4, seq: 7 },
      ],
    ],
    [
      'descending seq',
      [
        { threadId: 4, seq: 8 },
        { threadId: 4, seq: 7 },
      ],
    ],
    [
      'multiple source threads',
      [
        { threadId: 4, seq: 7 },
        { threadId: 5, seq: 8 },
      ],
    ],
  ])('rejects %s before querying source rows', async (_label, sources) => {
    const database = databaseFake(0);
    const service = forwardService(database);

    await expect(service.prepareFromMessages(9, sources)).rejects.toMatchObject<
      Partial<BusinessException>
    >({
      bizCode: BusinessCode.FORWARD_INVALID_BUNDLE,
    });
    expect(database.db.query.message.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [
      'non-positive message id',
      {
        id: 0,
        author: { account: 'a', domain: 'peer.test' },
        profile: { displayName: 'A' },
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'hello' }),
        sentAt: 1,
      },
    ],
    [
      'missing quote target',
      {
        id: 1,
        author: { account: 'a', domain: 'peer.test' },
        profile: { displayName: 'A' },
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'reply' }),
        sentAt: 1,
        quote: { preview: 'B：missing', targetId: 2 },
      },
    ],
    [
      'null quote descriptor',
      {
        id: 1,
        author: { account: 'a', domain: 'peer.test' },
        profile: { displayName: 'A' },
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'reply' }),
        sentAt: 1,
        quote: null,
      },
    ],
  ])('rejects federated %s', async (_label, wireMessage) => {
    const bundleId = '01badquote00000000000000000';
    const service = forwardService({});

    await expect(
      service.importClosure('peer.test', {
        id: bundleId,
        messages: [wireMessage],
        children: [],
        assets: [],
        messageCount: 1,
        assetCount: 0,
      }),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('imports cyclic child references and scopes message ids per bundle', async () => {
    const insertedBundles: Array<{
      id: string;
      sourceBundleId: string | null;
      messages: Array<{ id: number; childBundleId?: string; content: string }>;
    }> = [];
    const tx = {
      query: {
        forwardBundle: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(async (value: unknown) => {
          if (table === forwardBundle) {
            insertedBundles.push(value as (typeof insertedBundles)[number]);
          }
        }),
      })),
    };
    const service = forwardService({});
    const card = (bundleId: string) => JSON.stringify({ bundleId });
    const message = (childBundleId: string) => ({
      id: 1,
      author: { account: 'alice', domain: 'peer.test' },
      profile: { displayName: 'A' },
      contentType: ContentType.FORWARD,
      content: card(childBundleId),
      sentAt: 1,
      childBundleId,
      quoteTargetId: 1,
    });

    await expect(
      service.importClosure(
        'peer.test',
        {
          id: 'root',
          messages: [message('a')],
          children: [
            { id: 'a', messages: [message('b')] },
            { id: 'b', messages: [message('a')] },
          ],
          assets: [],
        },
        tx as never,
      ),
    ).resolves.toHaveProperty('localRootBundleId');

    expect(insertedBundles).toHaveLength(3);
    expect(insertedBundles.map((bundle) => bundle.sourceBundleId)).toEqual([
      'root',
      null,
      null,
    ]);
    const localIds = new Set(insertedBundles.map((bundle) => bundle.id));
    for (const bundle of insertedBundles) {
      expect(bundle.messages[0].id).toBe(1);
      expect(localIds).toContain(bundle.messages[0].childBundleId);
      expect(JSON.parse(bundle.messages[0].content).bundleId).toBe(
        bundle.messages[0].childBundleId,
      );
    }
  });

  it('rejects a FORWARD card whose bundleId differs from childBundleId', async () => {
    const service = forwardService({});
    await expect(
      service.importClosure('peer.test', {
        id: 'root',
        messages: [
          {
            id: 1,
            author: {
              account: 'alice',
              domain: 'peer.test',
            },
            profile: { displayName: 'A' },
            contentType: ContentType.FORWARD,
            content: JSON.stringify({ bundleId: 'different' }),
            sentAt: 1,
            childBundleId: 'child',
          },
        ],
        children: [{ id: 'child', messages: [] }],
        assets: [],
      }),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects legacy display fields mixed into the author identity', async () => {
    const service = forwardService({});

    await expect(
      service.importClosure('peer.test', {
        id: 'root',
        messages: [
          {
            id: 1,
            author: {
              account: 'alice',
              domain: 'peer.test',
              displayName: 'Alice',
            },
            contentType: ContentType.PURE_TEXT,
            content: JSON.stringify({ text: 'hello' }),
            sentAt: 1,
          },
        ],
        children: [],
        assets: [],
      } as never),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects federated closure JSON over the wire limit', async () => {
    const messages = [
      {
        id: 1,
        author: { account: 'a', domain: 'peer.test' },
        profile: { displayName: 'A' },
        contentType: 'PURE_TEXT',
        content: 'x'.repeat(FORWARD_MAX_WIRE_JSON_BYTES),
        sentAt: 1,
      },
    ];
    const service = forwardService({});
    await expect(
      service.importClosure('peer.test', {
        id: '01oversize00000000000000000',
        messages,
        children: [],
        assets: [],
        messageCount: 1,
        assetCount: 0,
      }),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });
});
