import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../database/database.service.js';
import { FederationMessageFeedService } from './federation-message-feed.service.js';

interface MessageFeedInternals {
  serializeMessagesInTx(
    tx: DatabaseTransaction,
    rows: Array<Record<string, unknown>>,
    peerNamespaceId: number,
    threadAddress: { account: string; peerAccount?: string },
  ): Promise<Array<Record<string, unknown>>>;
}

function service(): MessageFeedInternals {
  const instance = Object.create(
    FederationMessageFeedService.prototype,
  ) as MessageFeedInternals & {
    logger: { warn: (...args: unknown[]) => void };
    database: unknown;
  };
  instance.logger = { warn: vi.fn() };
  return instance;
}

function transaction(
  targets: unknown[] = [],
  assetRows: unknown[] = [],
): DatabaseTransaction & {
  select: ReturnType<typeof vi.fn>;
} {
  const results: unknown[][] = [assetRows];
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => Promise.resolve(rows),
    };
    return query;
  });
  return {
    select,
    query: {
      message: { findMany: vi.fn().mockResolvedValue(targets) },
    },
    logger: { warn: vi.fn() },
  } as unknown as DatabaseTransaction & {
    select: ReturnType<typeof vi.fn>;
  };
}

function groupRow(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 1n,
    threadId: 7,
    seq: 2,
    profileRev: 1,
    originSeq: 2,
    originServerTime: null,
    publisherNamespaceId: 0,
    contentType: 'PURE_TEXT',
    content: JSON.stringify({ text: 'hello' }),
    payloadDigest: 'a'.repeat(64),
    federationEnvelopeDigest: null,
    forwardBundleSourceId: null,
    createdAt: new Date('2026-09-04T00:00:00.000Z'),
    threadType: 'GROUP',
    authorityNamespaceId: 9,
    authorAccount: 'member',
    profileNamespaceId: 0,
    ...overrides,
  };
}

describe('FederationMessageFeedService group origin coordinates', () => {
  it('uses message byte descriptors even when physical storage metadata differs', async () => {
    const digest = 'd'.repeat(64);
    const [receipt] = await service().serializeMessagesInTx(
      transaction([], [{ messageId: 1n, digest, bytes: 999n }]),
      [
        groupRow({
          contentType: 'FILE',
          content: JSON.stringify({
            url: `/uploads/msg-assets/dd/dd/${digest}`,
            name: 'asset.bin',
            mimeType: 'application/octet-stream',
            size: 20,
          }),
        }),
      ],
      9,
      { account: '!group' },
    );
    expect(receipt.assets).toEqual([{ digest, bytes: 20 }]);
  });
  it('returns the direct origin coordinate for a mirror copy', async () => {
    const originTime = new Date('2026-09-03T00:00:00.000Z');
    const [receipt] = await service().serializeMessagesInTx(
      transaction(),
      [
        groupRow({
          seq: 99,
          originSeq: 42,
          originServerTime: originTime,
          publisherNamespaceId: 9,
          profileNamespaceId: 12,
        }),
      ],
      9,
      { account: '!group' },
    );
    expect(receipt).toMatchObject({
      seq: 99,
      originSeq: 42,
      originCreatedAt: originTime.getTime(),
    });
  });
  it('returns submission coordinates only to the author home of an accepted group message', async () => {
    const publisher = service();
    const originTime = new Date('2026-09-03T00:00:00.000Z');
    const row = groupRow({
      seq: 42,
      originSeq: 7,
      originServerTime: originTime,
      publisherNamespaceId: 12,
      authorityNamespaceId: 0,
      profileNamespaceId: 12,
    });
    const [receipt] = await publisher.serializeMessagesInTx(
      transaction(),
      [row],
      12,
      { account: '!group' },
    );
    const [distribution] = await publisher.serializeMessagesInTx(
      transaction(),
      [row],
      19,
      { account: '!group' },
    );
    expect(receipt).toMatchObject({
      seq: 42,
      originSeq: 7,
      originCreatedAt: originTime.getTime(),
    });
    expect(distribution).toMatchObject({
      seq: 42,
      originSeq: null,
      originCreatedAt: null,
    });
  });

  it.each([
    {
      name: 'own target before confirmation',
      profileNamespaceId: 0,
      publisherNamespaceId: 0,
      expected: { seq: 8 },
    },
    {
      name: 'receiver authority target from local mirror author',
      profileNamespaceId: 0,
      publisherNamespaceId: 9,
      expected: { originSeq: 21 },
    },
    {
      name: 'authority target',
      profileNamespaceId: 12,
      publisherNamespaceId: 9,
      expected: { originSeq: 21 },
    },
    {
      name: 'another member represented by authority',
      profileNamespaceId: 13,
      publisherNamespaceId: 9,
      expected: { originSeq: 21 },
    },
  ])(
    'publishes $name using the correct coordinate',
    async ({ profileNamespaceId, publisherNamespaceId, expected }) => {
      const target = {
        id: 8n,
        threadId: 7,
        seq: 8,
        originSeq: 21,
        profileNamespaceId,
        publisherNamespaceId,
      };
      const [reply] = await service().serializeMessagesInTx(
        transaction([target]),
        [
          groupRow({
            content: JSON.stringify({
              text: 'reply',
              quote: { seq: 8, namespaceId: 0, digest: 'd'.repeat(64) },
            }),
          }),
        ],
        9,
        { account: '!group' },
      );
      expect(reply.quoteTarget).toEqual(expected);
    },
  );

  it('republishes a peer reference using the group authority sequence, including withdrawn targets', async () => {
    const targets = [
      {
        id: 8n,
        threadId: 7,
        seq: 31,
        originSeq: 8,
        profileNamespaceId: 11,
        publisherNamespaceId: 11,
      },
      {
        id: 9n,
        threadId: 7,
        seq: 42,
        originSeq: 8,
        profileNamespaceId: 12,
        publisherNamespaceId: 12,
        isDeleted: true,
      },
    ];
    const [reply] = await service().serializeMessagesInTx(
      transaction(targets),
      [
        groupRow({
          authorityNamespaceId: 0,
          publisherNamespaceId: 12,
          content: JSON.stringify({
            text: 'reply',
            quote: { seq: 8, namespaceId: 12, digest: 'd'.repeat(64) },
          }),
        }),
      ],
      19,
      { account: '!group' },
    );
    expect(reply.quoteTarget).toEqual({ seq: 42 });
  });

  it('preserves a known authority coordinate even when its target body is absent', async () => {
    const [reply] = await service().serializeMessagesInTx(
      transaction(),
      [
        groupRow({
          authorityNamespaceId: 0,
          content: JSON.stringify({
            text: 'reply',
            quote: { seq: 42, namespaceId: 0, digest: 'd'.repeat(64) },
          }),
        }),
      ],
      19,
      { account: '!group' },
    );
    expect(reply.quoteTarget).toEqual({ seq: 42 });
  });

  it('does not fabricate a coordinate or drop a quote when a local mapping invariant is broken', async () => {
    await expect(
      service().serializeMessagesInTx(
        transaction(),
        [
          groupRow({
            authorityNamespaceId: 0,
            publisherNamespaceId: 12,
            content: JSON.stringify({
              text: 'reply',
              quote: { seq: 8, namespaceId: 12, digest: 'd'.repeat(64) },
            }),
          }),
        ],
        19,
        { account: '!group' },
      ),
    ).rejects.toThrow('quote coordinate cannot be represented');
  });

  it('does not expose provisional origin coordinates for a local member message', async () => {
    const messages = await service().serializeMessagesInTx(
      transaction(),
      [groupRow()],
      9,
      { account: '!group' },
    );

    expect(messages).toMatchObject([
      {
        author: { account: 'member', namespaceId: 0 },
        originSeq: null,
        originCreatedAt: null,
      },
    ]);
  });

  it('exposes complete origin coordinates for a message received from the origin', async () => {
    const originTime = new Date('2026-09-03T00:00:00.000Z');
    const messages = await service().serializeMessagesInTx(
      transaction(),
      [
        groupRow({
          originSeq: 1,
          originServerTime: originTime,
          publisherNamespaceId: 9,
          authorAccount: 'owner',
          profileNamespaceId: 0,
        }),
      ],
      9,
      { account: '!group' },
    );

    expect(messages).toMatchObject([
      {
        author: { account: 'owner', namespaceId: 0 },
        originSeq: 1,
        originCreatedAt: originTime.getTime(),
      },
    ]);
  });

  it('publishes a foreign native author in the authority namespace space without domain or duplicate nsid', async () => {
    const [message] = await service().serializeMessagesInTx(
      transaction(),
      [
        groupRow({
          publisherNamespaceId: 1,
          profileNamespaceId: 0,
          authorityNamespaceId: 0,
        }),
      ],
      2,
      { account: '!group' },
    );
    expect(message.author).toEqual({ account: 'member', namespaceId: 1 });
    expect(message).not.toHaveProperty('namespaceId');
    expect(message.author).not.toHaveProperty('domain');
  });

  it('distinguishes same-name P2P endpoints by author namespace and keeps one nested address', async () => {
    for (const publisherNamespaceId of [0, 9]) {
      const [message] = await service().serializeMessagesInTx(
        transaction(),
        [
          groupRow({
            threadType: 'P2P',
            authorAccount: 'same',
            publisherNamespaceId,
            profileNamespaceId: 0,
          }),
        ],
        9,
        { account: 'same', peerAccount: 'same' },
      );
      expect(message.author).toEqual({
        ref:
          publisherNamespaceId === 0 ? 'THREAD_ACCOUNT' : 'THREAD_PEER_ACCOUNT',
        namespaceId: publisherNamespaceId,
      });
      expect(message).not.toHaveProperty('authorRef');
      expect(message).not.toHaveProperty('namespaceId');
    }
  });

  it('does not expose an old namespace coordinate to a replacement namespace', async () => {
    const messages = await service().serializeMessagesInTx(
      transaction(),
      [
        groupRow({
          originSeq: 1,
          originServerTime: new Date('2026-09-03T00:00:00.000Z'),
          publisherNamespaceId: 8,
          authorAccount: 'owner',
          profileNamespaceId: 0,
        }),
      ],
      9,
      { account: '!group' },
    );

    expect(messages).toMatchObject([
      { originSeq: null, originCreatedAt: null },
    ]);
  });
});
