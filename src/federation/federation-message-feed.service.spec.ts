import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../database/database.service.js';
import { FederationMessageFeedService } from './federation-message-feed.service.js';

interface MessageFeedInternals {
  localDomain: string;
  serializeMessagesInTx(
    tx: DatabaseTransaction,
    rows: Array<Record<string, unknown>>,
    peerDomain: string,
    peerNamespaceId: number,
    threadAddress: { account: string },
  ): Promise<Array<Record<string, unknown>>>;
}

function service(): MessageFeedInternals {
  const value = Object.create(
    FederationMessageFeedService.prototype,
  ) as MessageFeedInternals;
  value.localDomain = 'member.test';
  return value;
}

function transaction(targets: unknown[] = []): DatabaseTransaction & {
  select: ReturnType<typeof vi.fn>;
} {
  const results: unknown[][] = [[]];
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
      federationMessageReceipt: { findMany: vi.fn().mockResolvedValue([]) },
    },
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
    sourceNamespaceId: 0,
    contentType: 'PURE_TEXT',
    content: JSON.stringify({ text: 'hello' }),
    createdAt: new Date('2026-09-04T00:00:00.000Z'),
    clientMessageId: null,
    threadType: 'GROUP',
    groupId: 5,
    authorityNamespaceId: 9,
    authorAccount: 'member',
    authorDomain: 'local',
    ...overrides,
  };
}

describe('FederationMessageFeedService group origin coordinates', () => {
  it.each(['origin.test', 'third-party.test'])(
    'returns the direct origin coordinate for a mirror copy authored on %s',
    async (authorDomain) => {
      const originTime = new Date('2026-09-03T00:00:00.000Z');
      const [receipt] = await service().serializeMessagesInTx(
        transaction(),
        [
          groupRow({
            seq: 99,
            originSeq: 42,
            originServerTime: originTime,
            sourceNamespaceId: 9,
            authorDomain,
          }),
        ],
        'origin.test',
        9,
        { account: '!group' },
      );
      expect(receipt).toMatchObject({
        seq: 99,
        originSeq: 42,
        originCreatedAt: originTime.getTime(),
      });
    },
  );
  it('returns submission coordinates only to the author home of an accepted group message', async () => {
    const publisher = service();
    publisher.localDomain = 'origin.test';
    const originTime = new Date('2026-09-03T00:00:00.000Z');
    const row = groupRow({
      seq: 42,
      originSeq: 7,
      originServerTime: originTime,
      sourceNamespaceId: 12,
      authorityNamespaceId: 0,
      authorDomain: 'member.test',
    });
    const [receipt] = await publisher.serializeMessagesInTx(
      transaction(),
      [row],
      'member.test',
      12,
      { account: '!group' },
    );
    const [distribution] = await publisher.serializeMessagesInTx(
      transaction(),
      [row],
      'other.test',
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
      creatorDomain: 'local',
      sourceNamespaceId: 0,
      expected: { seq: 8 },
    },
    {
      name: 'own target after confirmation',
      creatorDomain: 'local',
      sourceNamespaceId: 9,
      expected: { seq: 8 },
    },
    {
      name: 'authority target',
      creatorDomain: 'origin.test',
      sourceNamespaceId: 9,
      expected: { originSeq: 21 },
    },
    {
      name: 'another member represented by authority',
      creatorDomain: 'third.test',
      sourceNamespaceId: 9,
      expected: { originSeq: 21 },
    },
  ])(
    'publishes $name using the correct coordinate',
    async ({ creatorDomain, sourceNamespaceId, expected }) => {
      const target = {
        id: 8n,
        threadId: 7,
        seq: 8,
        originSeq: 21,
        creatorDomain,
        sourceNamespaceId,
      };
      const [reply] = await service().serializeMessagesInTx(
        transaction([target]),
        [
          groupRow({
            content: JSON.stringify({
              text: 'reply',
              quote: { seq: 8, namespaceId: 0 },
            }),
          }),
        ],
        'origin.test',
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
        creatorDomain: 'wrong.test',
        sourceNamespaceId: 11,
      },
      {
        id: 9n,
        threadId: 7,
        seq: 42,
        originSeq: 8,
        creatorDomain: 'member.test',
        sourceNamespaceId: 12,
        isDeleted: true,
      },
    ];
    const [reply] = await service().serializeMessagesInTx(
      transaction(targets),
      [
        groupRow({
          authorityNamespaceId: 0,
          sourceNamespaceId: 12,
          content: JSON.stringify({
            text: 'reply',
            quote: { seq: 8, namespaceId: 12 },
          }),
        }),
      ],
      'bravo.test',
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
            quote: { seq: 42, namespaceId: 0 },
          }),
        }),
      ],
      'bravo.test',
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
            sourceNamespaceId: 12,
            content: JSON.stringify({
              text: 'reply',
              quote: { seq: 8, namespaceId: 12 },
            }),
          }),
        ],
        'bravo.test',
        19,
        { account: '!group' },
      ),
    ).rejects.toThrow('quote coordinate cannot be represented');
  });

  it('does not expose provisional origin coordinates for a local member message', async () => {
    const messages = await service().serializeMessagesInTx(
      transaction(),
      [groupRow()],
      'origin.test',
      9,
      { account: '!group' },
    );

    expect(messages).toMatchObject([
      {
        author: { account: 'member', domain: 'member.test' },
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
          sourceNamespaceId: 9,
          authorAccount: 'owner',
          authorDomain: 'origin.test',
        }),
      ],
      'origin.test',
      9,
      { account: '!group' },
    );

    expect(messages).toMatchObject([
      {
        author: { account: 'owner', domain: 'origin.test' },
        originSeq: 1,
        originCreatedAt: originTime.getTime(),
      },
    ]);
  });

  it('does not expose an old namespace coordinate to a replacement namespace', async () => {
    const messages = await service().serializeMessagesInTx(
      transaction(),
      [
        groupRow({
          originSeq: 1,
          originServerTime: new Date('2026-09-03T00:00:00.000Z'),
          sourceNamespaceId: 8,
          authorAccount: 'owner',
          authorDomain: 'origin.test',
        }),
      ],
      'origin.test',
      9,
      { account: '!group' },
    );

    expect(messages).toMatchObject([
      { originSeq: null, originCreatedAt: null },
    ]);
  });
});
