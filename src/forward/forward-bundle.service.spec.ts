import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import { forwardBundle, forwardBundleDependency } from '../database/schema.js';
import {
  digestManifest,
  FORWARD_MAX_WIRE_JSON_BYTES,
  ForwardBundleService,
  localizeForwardMediaContent,
  type ForwardManifest,
  type ForwardWireClosure,
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
            depth: childDepth,
            manifestDigest: 'a'.repeat(64),
            manifest: {
              schemaVersion: 1,
              bundleId: '01childbundle00000000000000',
              depth: childDepth,
              children: [],
              messages: [
                {
                  sender: { displayName: 'A', account: 'a', domain: 'local' },
                  contentType: 'PURE_TEXT',
                  content: JSON.stringify({ text: 'nested' }),
                  sentAt: 1,
                },
              ],
            },
            forwardBundleDependencies_parentBundleId: [],
          }),
          findMany: vi.fn().mockResolvedValue([
            {
              id: '01childbundle00000000000000',
              depth: childDepth,
              manifestDigest: 'a'.repeat(64),
              manifest: {
                schemaVersion: 1,
                bundleId: '01childbundle00000000000000',
                depth: childDepth,
                children: [],
                messages: [
                  {
                    sender: {
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
              forwardBundleAssets: [],
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
      _filters?: Map<number, unknown>,
    ) =>
      rows.map((row) => {
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
          kind: 'image',
          extension: 'webp',
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

    expect(prepared.manifest.messages[0]).toMatchObject({ id: 1 });
    expect(prepared.manifest.messages[1]).toMatchObject({ id: 2 });
    expect(prepared.manifest.messages[1].quote).toEqual({
      preview: 'Alice：original',
      targetId: 1,
    });
  });

  it('keeps an unselected quote as a non-jumpable preview without adding it', async () => {
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

    expect(prepared.manifest.messages).toHaveLength(1);
    expect(prepared.manifest.messages[0]).toMatchObject({ id: 1 });
    expect(prepared.manifest.messages[0].quote).toEqual({
      preview: 'Alice：original',
    });
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

  it('rejects forwarding an existing depth-3 bundle because the result would be depth 4', async () => {
    const service = forwardService(databaseFake(3));

    await expect(
      service.createFromMessages(9, [{ threadId: 4, seq: 7 }]),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FORWARD_MAX_DEPTH_EXCEEDED,
    });
  });

  it('stores children as a JSON array and a searchable dependency when result depth is 3', async () => {
    const createBundle = vi.fn().mockResolvedValue(undefined);
    const createDependencies = vi.fn().mockResolvedValue(undefined);
    const tx = {
      insert: vi.fn((table: unknown) => ({
        values:
          table === forwardBundle
            ? createBundle
            : table === forwardBundleDependency
              ? createDependencies
              : vi.fn(),
      })),
    };
    const service = forwardService(databaseFake(2, tx));
    const result = await service.createFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(result.depth).toBe(3);
    const manifest = createBundle.mock.calls[0][0].manifest as ForwardManifest;
    expect(manifest.children).toEqual(['01childbundle00000000000000']);
    expect(createDependencies).toHaveBeenCalledWith([
      {
        parentBundleId: result.bundleId,
        childBundleId: '01childbundle00000000000000',
        ordinal: 0,
      },
    ]);
  });

  it('hashes manifests canonically rather than depending on object key insertion order', () => {
    const first = {
      schemaVersion: 1,
      bundleId: '01bundle0000000000000000000',
      depth: 1,
      children: [],
      messages: [],
    } as ForwardManifest;
    const second = {
      messages: [],
      children: [],
      depth: 1,
      bundleId: '01bundle0000000000000000000',
      schemaVersion: 1,
    } as ForwardManifest;
    expect(digestManifest(first)).toBe(digestManifest(second));
  });

  it.each([
    [
      'non-canonical message id',
      {
        id: 2,
        sender: { displayName: 'A', account: 'a', domain: 'peer.test' },
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'hello' }),
        sentAt: 1,
      },
    ],
    [
      'missing quote target',
      {
        id: 1,
        sender: { displayName: 'A', account: 'a', domain: 'peer.test' },
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
        sender: { displayName: 'A', account: 'a', domain: 'peer.test' },
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'reply' }),
        sentAt: 1,
        quote: null,
      },
    ],
  ])('rejects federated %s', async (_label, wireMessage) => {
    const manifest = {
      schemaVersion: 1,
      bundleId: '01badquote00000000000000000',
      depth: 1,
      children: [],
      messages: [wireMessage],
    } as unknown as ForwardManifest;
    const service = forwardService({});

    await expect(
      service.importClosure('peer.test', {
        schemaVersion: 1,
        rootBundleId: manifest.bundleId,
        bundles: [
          {
            id: manifest.bundleId,
            depth: 1,
            manifest,
            manifestDigest: digestManifest(manifest),
            assets: [],
          },
        ],
        assets: [],
      }),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects a cyclic federated closure before writing any bundle', async () => {
    const manifestA: ForwardManifest = {
      schemaVersion: 1,
      bundleId: '01cyclea0000000000000000000',
      depth: 2,
      children: ['01cycleb0000000000000000000'],
      messages: [
        {
          sender: { displayName: 'A', account: 'a', domain: 'peer.test' },
          contentType: 'FORWARD',
          content: '{}',
          sentAt: 1,
          childBundleId: '01cycleb0000000000000000000',
        },
      ],
    };
    const manifestB: ForwardManifest = {
      schemaVersion: 1,
      bundleId: '01cycleb0000000000000000000',
      depth: 2,
      children: ['01cyclea0000000000000000000'],
      messages: [
        {
          sender: { displayName: 'B', account: 'b', domain: 'peer.test' },
          contentType: 'FORWARD',
          content: '{}',
          sentAt: 1,
          childBundleId: '01cyclea0000000000000000000',
        },
      ],
    };
    const closure: ForwardWireClosure = {
      schemaVersion: 1,
      rootBundleId: manifestA.bundleId,
      bundles: [
        {
          id: manifestA.bundleId,
          depth: 2,
          manifest: manifestA,
          manifestDigest: digestManifest(manifestA),
          assets: [],
        },
        {
          id: manifestB.bundleId,
          depth: 2,
          manifest: manifestB,
          manifestDigest: digestManifest(manifestB),
          assets: [],
        },
      ],
      assets: [],
    };
    const service = forwardService({});
    await expect(
      service.importClosure('peer.test', closure),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects federated closure JSON over the wire limit', async () => {
    const manifest: ForwardManifest = {
      schemaVersion: 1,
      bundleId: '01oversize00000000000000000',
      depth: 1,
      children: [],
      messages: [
        {
          sender: { displayName: 'A', account: 'a', domain: 'peer.test' },
          contentType: 'PURE_TEXT',
          content: 'x'.repeat(FORWARD_MAX_WIRE_JSON_BYTES),
          sentAt: 1,
        },
      ],
    };
    const service = forwardService({});
    await expect(
      service.importClosure('peer.test', {
        schemaVersion: 1,
        rootBundleId: manifest.bundleId,
        bundles: [
          {
            id: manifest.bundleId,
            depth: 1,
            manifest,
            manifestDigest: digestManifest(manifest),
            assets: [],
          },
        ],
        assets: [],
      }),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });
});
