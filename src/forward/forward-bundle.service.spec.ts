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
    creator: 9,
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
  return {
    db: {
      query: {
        threadParticipant: {
          findMany: vi.fn().mockResolvedValue([
            {
              threadId: 4,
              clearedSeq: null,
              messageThread: { type: 'P2P' },
            },
          ]),
        },
        message: {
          findFirst: vi.fn().mockResolvedValue(sourceQueryRow(childDepth)),
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
                author: { displayName: 'A', account: 'a', domain: 'local' },
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
                  author: {
                    displayName: 'A',
                    account: 'a',
                    domain: 'local',
                  },
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

const userBlockServiceFake = {
  blockedByMe: vi.fn().mockResolvedValue(new Set<number>()),
};

function forwardService(database: unknown) {
  return new ForwardBundleService(
    database as never,
    messageServiceFake as never,
    userBlockServiceFake as never,
    {
      findVisibleByThreadSeq: vi.fn().mockResolvedValue(null),
    } as never,
  );
}

describe('ForwardBundleService', () => {
  it('directly forwards text as the caller without retaining its quote', async () => {
    const database = databaseFake(0);
    const service = new ForwardBundleService(
      database as never,
      messageServiceFake as never,
      userBlockServiceFake as never,
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

  it.each([ContentType.INVITE, ContentType.CALL])(
    'rejects direct forwarding of system message type %s',
    async (contentType) => {
      const service = new ForwardBundleService(
        databaseFake(0) as never,
        messageServiceFake as never,
        userBlockServiceFake as never,
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
      userBlockServiceFake as never,
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

  it('reuses cleared-history and P2P-block filters when resolving quote previews', async () => {
    const clearedSeq = 3;
    const reply = textQueryRow(
      7,
      JSON.stringify({ text: 'reply', quote: { seq: 4 } }),
      'Bob',
    );
    const database = databaseFake(0) as ReturnType<typeof databaseFake>;
    database.db.query.threadParticipant.findMany.mockResolvedValueOnce([
      {
        threadId: 4,
        clearedSeq,
        messageThread: { type: 'P2P' },
      },
    ]);
    database.db.query.message.findFirst.mockResolvedValueOnce(reply);
    userBlockServiceFake.blockedByMe.mockResolvedValueOnce(new Set([12]));
    messageServiceFake.attachQuotePreviews.mockClear();
    const service = forwardService(database);

    await service.prepareFromMessages(9, [{ threadId: 4, seq: 7 }]);

    const filters = messageServiceFake.attachQuotePreviews.mock.calls[0][1];
    expect(filters.get(4)).toEqual({
      clearedThroughSeq: clearedSeq,
      hideCreatorIds: [12],
    });
  });

  it.each([
    ['cleared history', 7, new Set<number>()],
    ['a blocked P2P creator', null, new Set([9])],
  ])(
    'rejects a source message hidden by %s',
    async (_label, clearedSeq, blocked) => {
      const database = databaseFake(0) as ReturnType<typeof databaseFake>;
      database.db.query.threadParticipant.findMany.mockResolvedValueOnce([
        {
          threadId: 4,
          clearedSeq,
          messageThread: { type: 'P2P' },
        },
      ]);
      userBlockServiceFake.blockedByMe.mockResolvedValueOnce(blocked);
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
        author: { displayName: 'A', account: 'a', domain: 'peer.test' },
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'hello' }),
        sentAt: 1,
      },
    ],
    [
      'missing quote target',
      {
        id: 1,
        author: { displayName: 'A', account: 'a', domain: 'peer.test' },
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
        author: { displayName: 'A', account: 'a', domain: 'peer.test' },
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
      author: { displayName: 'A', account: 'alice', domain: 'peer.test' },
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
              displayName: 'A',
              account: 'alice',
              domain: 'peer.test',
            },
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

  it('rejects federated closure JSON over the wire limit', async () => {
    const messages = [
      {
        id: 1,
        author: { displayName: 'A', account: 'a', domain: 'peer.test' },
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
