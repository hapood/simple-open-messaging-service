import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { ContentType } from '../database/enums.js';
import {
  forwardBundle,
  forwardBundleAsset,
  forwardBundleDependency,
} from '../database/schema.js';
import {
  authorHomeNamespaceId,
  FORWARD_MAX_WIRE_JSON_BYTES,
  forwardBundleDigest,
  ForwardBundleService,
  type ForwardBundleMessage,
  localizeForwardMediaContent,
} from './forward-bundle.service.js';

const SHA256_HEX = 'a'.repeat(64);

function sourceRow() {
  return {
    id: 1n,
    seq: 7,
    threadId: 4,
    creatorAccount: 'alice',
    publisherNamespaceId: 0,
    profileNamespaceId: 0,
    profileRev: 1,
    contentType: ContentType.FORWARD,
    content: JSON.stringify({
      bundleId: '01childbundle0000000000000',
      summaryLines: ['Alice：child'],
      messageCount: 1,
      depth: 1,
    }),
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
      bundleId: '01childbundle0000000000000',
      bundle: { id: '01childbundle0000000000000' },
    },
  };
}

function sourceQueryRow() {
  const row = sourceRow();
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
    ...sourceRow(),
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

function databaseFake(tx?: unknown) {
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
          findFirst: vi.fn().mockResolvedValue(sourceQueryRow()),
        },
        account: {
          findFirst: vi.fn().mockResolvedValue({
            account: 'alice',
            domain: 'local',
            name: 'Alice',
            avatar: '',
          }),
        },
        localFederationRoot: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        identityNamespace: {
          findFirst: vi.fn().mockResolvedValue({
            domain: 'peer.test',
            rootPublicKey: null,
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
        forwardMessage: {
          findFirst: vi.fn().mockResolvedValue({
            bundleId: '01childbundle0000000000000',
          }),
        },
        forwardBundle: {
          findFirst: vi.fn().mockResolvedValue({
            id: '01childbundle0000000000000',
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
              id: '01childbundle0000000000000',
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
  ])(
    'uses the shared %s message preview in forward-card summaries',
    (contentType, content, expected) => {
      const service = forwardService(databaseFake());

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
    const database = databaseFake();
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

  it('rebuilds untrusted LINK and CONTACT_CARD snapshots and reconciles the manifest exactly', async () => {
    const linkDigest = 'a'.repeat(64);
    const contactDigest = 'b'.repeat(64);
    const retainedDigest = 'c'.repeat(64);
    const rootId = 'a'.repeat(64);
    const messages = [
      {
        id: 1,
        author: { account: 'alice', domain: 'peer.test' },
        profile: { displayName: 'Alice' },
        contentType: ContentType.LINK,
        content: JSON.stringify({
          url: 'https://example.test',
          title: 'Remote',
          description: '',
          image: `/uploads/msg-assets/aa/aa/${linkDigest}`,
        }),
        sentAt: 1,
      },
      {
        id: 2,
        author: { account: 'alice', domain: 'peer.test' },
        profile: { displayName: 'Alice' },
        contentType: ContentType.CONTACT_CARD,
        content: JSON.stringify({
          account: 'bob',
          domain: 'peer.test',
          displayName: 'Bob',
          bio: '',
          avatar: `/uploads/msg-assets/bb/bb/${contactDigest}`,
        }),
        sentAt: 2,
      },
      {
        id: 3,
        author: { account: 'alice', domain: 'peer.test' },
        profile: { displayName: 'Alice' },
        contentType: ContentType.IMAGE,
        content: JSON.stringify({
          url: `/uploads/msg-assets/cc/cc/${retainedDigest}`,
          w: 1,
          h: 1,
          size: 30,
        }),
        sentAt: 3,
      },
    ];
    const bundleUpdates: Array<Record<string, unknown>> = [];
    const insertedAssets: Array<Record<string, unknown>> = [];
    let deletedAssets = false;
    const tx = {
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            if (table === forwardBundle) bundleUpdates.push(values);
          }),
        })),
      })),
      delete: vi.fn((table: unknown) => ({
        where: vi.fn(async () => {
          if (table === forwardBundleAsset) deletedAssets = true;
        }),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(async (values: Array<Record<string, unknown>>) => {
          if (table === forwardBundleAsset) insertedAssets.push(...values);
        }),
      })),
    };
    const database = {
      db: {
        query: {
          forwardBundle: {
            findFirst: vi.fn().mockResolvedValue({
              id: rootId,
              forwardBundleDependencies_parentBundleId: [],
            }),
            findMany: vi.fn().mockResolvedValue([{ id: rootId, messages }]),
          },
          forwardBundleAsset: {
            findMany: vi.fn().mockResolvedValue([
              { digest: linkDigest, bytes: 10n },
              { digest: contactDigest, bytes: 20n },
              { digest: retainedDigest, bytes: 30n },
            ]),
          },
          mediaAsset: {
            findFirst: vi.fn().mockResolvedValue({ bytes: 30n }),
          },
        },
        transaction: vi.fn(async (work: (client: typeof tx) => Promise<void>) =>
          work(tx),
        ),
      },
    };
    const service = forwardService(database);

    await service.rebuildUntrustedCards(rootId, async (url) => ({
      url,
      title: 'Local',
      description: '',
    }));

    expect(deletedAssets).toBe(true);
    expect(insertedAssets).toEqual([
      { bundleId: rootId, ordinal: 0, digest: retainedDigest, bytes: 30n },
    ]);
    const rewritten = bundleUpdates.find((value) => value['messages'])!
      .messages as Array<{ content: string }>;
    expect(JSON.parse(rewritten[0].content)).toEqual({
      url: 'https://example.test',
      title: 'Local',
      description: '',
    });
    expect(JSON.parse(rewritten[1].content)).not.toHaveProperty('avatar');
    expect(bundleUpdates).toContainEqual({ assetCount: 1, totalBytes: 30n });
  });

  it('builds a closure containing an imported minimal forward card', async () => {
    const database = databaseFake() as ReturnType<typeof databaseFake>;
    database.db.query.forwardBundle.findFirst.mockResolvedValueOnce({
      id: 'a'.repeat(64),
      messages: [
        {
          id: 1,
          author: { account: 'a', domain: 'remote.test' },
          profile: { displayName: 'A' },
          contentType: ContentType.FORWARD,
          content: JSON.stringify({
            bundleId: 'b'.repeat(64),
          }),
          childBundleId: 'b'.repeat(64),
          sentAt: 1,
        },
      ],
      forwardBundleDependencies_parentBundleId: [
        { childBundleId: 'b'.repeat(64) },
      ],
      forwardBundleAssets: [],
    });
    database.db.query.forwardBundle.findMany.mockResolvedValueOnce([
      {
        id: 'b'.repeat(64),
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

    const closure = await service.buildClosure('a'.repeat(64));
    expect(closure.messages[0].content).toBe(
      JSON.stringify({ bundleId: closure.children[0]!.id }),
    );
  });

  it('directly forwards text as the caller without retaining its quote', async () => {
    const database = databaseFake();
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

  it('directly forwards a depth-3 card without creating another bundle layer', async () => {
    const database = databaseFake();
    const service = new ForwardBundleService(
      database as never,
      messageServiceFake as never,
      {
        findVisibleByThreadSeq: vi.fn().mockResolvedValue({
          id: 7n,
          contentType: ContentType.FORWARD,
          content: JSON.stringify({
            bundleId: '01childbundle0000000000000',
            summaryLines: ['Alice：nested'],
            messageCount: 3,
            depth: 3,
          }),
        }),
      } as never,
    );

    const result = await service.prepareDirectMessage(9, {
      threadId: 4,
      seq: 7,
    });
    expect(JSON.parse(result.content).bundleId).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([ContentType.SYSTEM])(
    'rejects direct forwarding of system message type %s',
    async (contentType) => {
      const service = new ForwardBundleService(
        databaseFake() as never,
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
      ).rejects.toMatchObject({
        bizCode: BusinessCode.FORWARD_INVALID_BUNDLE,
      });
    },
  );

  it('rejects direct media forwarding when its CAS digest is not bound to the visible source', async () => {
    const digest = 'a'.repeat(64);
    const database = databaseFake();
    const service = new ForwardBundleService(
      database as never,
      messageServiceFake as never,
      {
        findVisibleByThreadSeq: vi.fn().mockResolvedValue({
          id: 7n,
          contentType: ContentType.IMAGE,
          content: JSON.stringify({
            url: `/uploads/msg-assets/aa/aa/${digest}`,
            w: 10,
            h: 10,
          }),
        }),
      } as never,
    );

    await expect(
      service.prepareDirectMessage(9, { threadId: 4, seq: 7 }),
    ).rejects.toMatchObject({
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
    const database = databaseFake() as ReturnType<typeof databaseFake>;
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

  it('rejects forwarding a depth-3 child bundle before preparing or persisting', async () => {
    const database = databaseFake() as ReturnType<typeof databaseFake>;
    database.db.query.message.findFirst.mockResolvedValue({
      ...sourceQueryRow(),
      content: JSON.stringify({
        bundleId: '01childbundle0000000000000',
        summaryLines: [],
        messageCount: 3,
        depth: 3,
      }),
    });
    const service = forwardService(database);
    messageServiceFake.attachQuotePreviews.mockClear();

    await expect(
      service.prepareFromMessages(9, [{ threadId: 4, seq: 7 }]),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FORWARD_MAX_DEPTH_EXCEEDED,
    });
    expect(database.db.transaction).not.toHaveBeenCalled();
  });

  it('rejects a local forward whose aggregate message count exceeds 500', async () => {
    const database = databaseFake();
    database.db.query.message.findFirst.mockResolvedValue({
      ...sourceQueryRow(),
      content: JSON.stringify({
        bundleId: '01childbundle0000000000000',
        summaryLines: [],
        messageCount: 500,
        depth: 1,
      }),
    });
    await expect(
      forwardService(database).prepareFromMessages(9, [
        { threadId: 4, seq: 7 },
      ]),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORWARD_INVALID_BUNDLE });
    expect(database.db.query.forwardBundle.findFirst).not.toHaveBeenCalled();
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
    const database = databaseFake() as ReturnType<typeof databaseFake>;
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
    expect(JSON.parse(prepared.messages[1].content)).toEqual({ text: 'reply' });
  });

  it('retains an absent quote when its target is not selected', async () => {
    const reply = textQueryRow(
      7,
      JSON.stringify({ text: 'reply', quote: { seq: 4 } }),
      'Bob',
    );
    const database = databaseFake() as ReturnType<typeof databaseFake>;
    database.db.query.message.findFirst.mockResolvedValueOnce(reply);
    const service = forwardService(database);

    const prepared = await service.prepareFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(prepared.messages).toHaveLength(1);
    expect(prepared.messages[0]).toMatchObject({ id: 1 });
    expect(prepared.messages[0].quoteTargetId).toBe(0);
    expect(JSON.parse(prepared.messages[0].content)).toEqual({ text: 'reply' });
  });

  it('derives the author home namespace from the publisher for mirrored authors', () => {
    // Mirrored rows carry the remote author's profile inside the publisher's
    // namespace (profileNamespaceId 0); their home domain must come from the
    // publisher namespace, not from the local namespace 0.
    expect(
      authorHomeNamespaceId({ profileNamespaceId: 0, publisherNamespaceId: 9 }),
    ).toBe(9);
    expect(
      authorHomeNamespaceId({ profileNamespaceId: 0, publisherNamespaceId: 0 }),
    ).toBe(0);
  });

  it('keeps the profile namespace as the author home for authority-published members', () => {
    // A remote group member published through a local authority keeps their
    // own home namespace in profileNamespaceId; the publisher (the local
    // authority) must not win the author domain.
    expect(
      authorHomeNamespaceId({ profileNamespaceId: 3, publisherNamespaceId: 0 }),
    ).toBe(3);
  });

  it('uses the creator account as display name when the exact revision is unavailable', async () => {
    const database = databaseFake() as ReturnType<typeof databaseFake>;
    database.db.execute
      .mockResolvedValueOnce({ rows: [{ authorized: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = forwardService(database);

    const prepared = await service.prepareFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(prepared.messages[0].author).toEqual({
      account: 'alice',
      domain: 'peer.test',
    });
    expect(prepared.messages[0].profile).toEqual({ displayName: 'alice' });
  });

  it('keeps a known avatarless exact profile without inventing an avatar', async () => {
    const database = databaseFake();
    const service = forwardService(database);

    const prepared = await service.prepareFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(prepared.messages[0].profile).toEqual({ displayName: 'Alice' });
    expect(prepared.assets).toEqual([]);
  });

  it('keeps the required display name when its avatar cannot be snapshotted', async () => {
    const database = databaseFake() as ReturnType<typeof databaseFake>;
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

    expect(prepared.messages[0].profile).toEqual({ displayName: 'Alice' });
    expect(prepared.assets).toEqual([]);
  });

  it('reuses cleared-history filters when resolving quote previews', async () => {
    const clearedSeq = 3;
    const reply = textQueryRow(
      7,
      JSON.stringify({ text: 'reply', quote: { seq: 4 } }),
      'Bob',
    );
    const database = databaseFake() as ReturnType<typeof databaseFake>;
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

    const filters = messageServiceFake.attachQuotePreviews.mock.calls[0][1]!;
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
      const database = databaseFake() as ReturnType<typeof databaseFake>;
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
      ).rejects.toMatchObject({
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
    const database = databaseFake();
    const service = forwardService(database);

    await expect(service.prepareFromMessages(9, sources)).rejects.toMatchObject(
      {
        bizCode: BusinessCode.FORWARD_INVALID_BUNDLE,
      },
    );
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
      'negative quote target',
      {
        id: 1,
        author: { account: 'a', domain: 'peer.test' },
        profile: { displayName: 'A' },
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'reply' }),
        sentAt: 1,
        quoteTargetId: -1,
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
        quoteTargetId: null,
      },
    ],
  ])('rejects federated %s', async (_label, wireMessage) => {
    const bundleId = '01badquote00000000000000000';
    const service = forwardService({});

    await expect(
      service.importClosure('peer.test', {
        id: bundleId,
        // Malformed on purpose (bad id / negative or null quote target / …): the
        // parameter type is InboundForwardWireBundle — untrusted wire JSON — so hostile
        // fixtures need no cast. importClosure's validation is the gate under test.
        messages: [wireMessage],
        children: [],
        assets: [],
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects cyclic child references before writing any bundles', async () => {
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
          id: 'a'.repeat(64),
          messages: [message('a'.repeat(64))],
          children: [
            { id: 'a'.repeat(64), messages: [message('b'.repeat(64))] },
            { id: 'b'.repeat(64), messages: [message('a'.repeat(64))] },
          ],
          assets: [],
        },
        tx as never,
      ),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FEDERATION_MALFORMED });

    expect(insertedBundles).toHaveLength(0);
  });

  it('imports a depth-three flat closure with localized references and a local depth', async () => {
    const insertedBundles: Array<{
      id: string;
      messages: ForwardBundleMessage[];
    }> = [];
    const dependencies: Array<{
      parentBundleId: string;
      childBundleId: string;
    }> = [];
    const tx = {
      query: {
        forwardBundle: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(async (value: unknown) => {
          if (table === forwardBundle)
            insertedBundles.push(value as (typeof insertedBundles)[number]);
          if (table === forwardBundleDependency)
            dependencies.push(...(value as typeof dependencies));
        }),
      })),
    };
    const card = (bundleId: string) => ({
      id: 1,
      author: { account: 'alice', domain: 'peer.test' },
      profile: { displayName: 'Alice' },
      contentType: ContentType.FORWARD,
      content: JSON.stringify({ bundleId }),
      childBundleId: bundleId,
      sentAt: 1,
    });
    const text = {
      id: 1,
      author: { account: 'alice', domain: 'peer.test' },
      profile: { displayName: 'Alice' },
      contentType: ContentType.PURE_TEXT,
      content: JSON.stringify({ text: 'hello' }),
      sentAt: 1,
    };
    const leafId = forwardBundleDigest([text], [], []);
    const middleMessage = card(leafId);
    const middleId = forwardBundleDigest([middleMessage], [leafId], []);
    const rootMessage = card(middleId);
    const rootId = forwardBundleDigest([rootMessage], [middleId], []);
    const closure = {
      id: rootId,
      messages: [rootMessage],
      children: [
        { id: middleId, messages: [middleMessage] },
        { id: leafId, messages: [text] },
      ],
      assets: [],
    };
    const service = forwardService({});
    const imported = await service.importClosure(
      'peer.test',
      closure,
      tx as never,
    );
    expect(imported.depth).toBe(3);
    expect(insertedBundles).toHaveLength(3);
    expect(dependencies).toHaveLength(2);
    expect(dependencies).toEqual([
      {
        parentBundleId: imported.localRootBundleId,
        childBundleId: insertedBundles[1]!.id,
        ordinal: 0,
      },
      {
        parentBundleId: insertedBundles[1]!.id,
        childBundleId: insertedBundles[2]!.id,
        ordinal: 0,
      },
    ]);
    expect(insertedBundles[0].messages[0].childBundleId).toBe(
      insertedBundles[1].id,
    );
    expect(insertedBundles[1].messages[0].childBundleId).toBe(
      insertedBundles[2].id,
    );
    expect(
      service.localCardContent(
        closure,
        imported.localRootBundleId,
        imported.depth,
      ),
    ).toContain('"depth":3');
  });

  it('rejects federated depth four before writing', async () => {
    const insert = vi.fn();
    const tx = {
      query: { forwardBundle: { findFirst: vi.fn() } },
      insert,
    };
    const card = (bundleId: string) => ({
      id: 1,
      author: { account: 'alice', domain: 'peer.test' },
      profile: { displayName: 'Alice' },
      contentType: ContentType.FORWARD,
      content: JSON.stringify({ bundleId }),
      childBundleId: bundleId,
      sentAt: 1,
    });
    const text = {
      id: 1,
      author: { account: 'alice', domain: 'peer.test' },
      profile: { displayName: 'Alice' },
      contentType: ContentType.PURE_TEXT,
      content: JSON.stringify({ text: 'hello' }),
      sentAt: 1,
    };
    const children = [
      { id: 'a'.repeat(64), messages: [card('b'.repeat(64))] },
      { id: 'b'.repeat(64), messages: [card('c'.repeat(64))] },
      { id: 'c'.repeat(64), messages: [text] },
    ];
    await expect(
      forwardService({}).importClosure(
        'peer.test',
        {
          id: SHA256_HEX,
          messages: [card('a'.repeat(64))],
          children,
          assets: [],
        },
        tx as never,
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects an unreachable federated child before writing', async () => {
    const tx = {
      query: { forwardBundle: { findFirst: vi.fn() } },
      insert: vi.fn(),
    };
    const text = {
      id: 1,
      author: { account: 'alice', domain: 'peer.test' },
      profile: { displayName: 'Alice' },
      contentType: ContentType.PURE_TEXT,
      content: JSON.stringify({ text: 'hello' }),
      sentAt: 1,
    };
    await expect(
      forwardService({}).importClosure(
        'peer.test',
        {
          id: SHA256_HEX,
          messages: [text],
          children: [{ id: 'b'.repeat(64), messages: [text] }],
          assets: [],
        },
        tx as never,
      ),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FEDERATION_MALFORMED });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('accepts a required display name without an author address', async () => {
    const insertedBundles: Array<{ messages: ForwardBundleMessage[] }> = [];
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

    const displayMessage = {
      id: 1,
      profile: { displayName: 'Alice' },
      contentType: ContentType.PURE_TEXT,
      content: JSON.stringify({ text: 'hello' }),
      sentAt: 1,
    } satisfies ForwardBundleMessage;
    const displayBundleId = forwardBundleDigest([displayMessage], [], []);

    await expect(
      service.importClosure(
        'peer.test',
        {
          id: displayBundleId,
          messages: [displayMessage],
          children: [],
          assets: [],
        },
        tx as never,
      ),
    ).resolves.toHaveProperty('localRootBundleId');

    expect(insertedBundles[0].messages[0]).toMatchObject({
      profile: { displayName: 'Alice' },
    });
  });

  it.each([
    ['account only', { account: 'alice' }],
    ['domain only', { domain: 'peer.test' }],
  ])(
    'rejects a partial optional author address: %s',
    async (_label, author) => {
      const service = forwardService({});

      await expect(
        service.importClosure('peer.test', {
          id: 'root',
          messages: [
            {
              id: 1,
              author,
              profile: { displayName: 'Alice' },
              contentType: ContentType.PURE_TEXT,
              content: JSON.stringify({ text: 'hello' }),
              sentAt: 1,
            },
          ],
          children: [],
          assets: [],
        }),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.FEDERATION_MALFORMED,
      });
    },
  );

  it('rejects the old bundle shape without a display name', async () => {
    const service = forwardService({});

    await expect(
      service.importClosure('peer.test', {
        id: 'root',
        messages: [
          {
            id: 1,
            author: { account: 'alice', domain: 'peer.test' },
            contentType: ContentType.PURE_TEXT,
            content: JSON.stringify({ text: 'hello' }),
            sentAt: 1,
          },
        ],
        children: [],
        assets: [],
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
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
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects unknown display fields mixed into the author identity', async () => {
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
            profile: { displayName: 'Alice' },
            contentType: ContentType.PURE_TEXT,
            content: JSON.stringify({ text: 'hello' }),
            sentAt: 1,
          },
        ],
        children: [],
        assets: [],
      } as never),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects federated closure JSON over the wire limit', async () => {
    const messages: ForwardBundleMessage[] = [
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
        id: SHA256_HEX,
        messages,
        children: [],
        assets: [],
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });
});
