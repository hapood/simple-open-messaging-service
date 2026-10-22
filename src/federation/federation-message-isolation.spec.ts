import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../common/locks/thread-content-lock.js', () => ({
  lockThreadContentInTx: vi.fn().mockResolvedValue(true),
  requireThreadContentLockInTx: vi.fn(
    async (tx, threadId, held) => held ?? { tx, threadId },
  ),
  acquireThreadContentLockInTx: vi.fn(async (tx, threadId) => ({
    tx,
    threadId,
  })),
}));
import { ThreadFeedHeadWriter } from '../message/thread-feed-head.writer.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { FederationMessageContextError } from './federation-errors.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';
import { FederationInboundMessageEffectsService } from './federation-inbound-message-effects.service.js';
import { FederationInboundMessageStoreService } from './federation-inbound-message-store.service.js';
import { FederationInboundMessagePageService } from './federation-inbound-message-page.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';

/** Always the thread-author feed member; assignments below rely on it. */
const item = (
  sequence: string,
): Extract<
  FederationMessageFeedMessage,
  { thread: { peerAccount: string } }
> => ({
  thread: {
    account: 'alice',
    peerAccount: 'bob',
  },
  author: { ref: 'THREAD_PEER_ACCOUNT', namespaceId: 12 },
  seq: Number(sequence),
  profileRev: 3,
  originSeq: Number(sequence),
  contentType: 'PURE_TEXT',
  content: JSON.stringify({ text: `message ${sequence}` }),
  createdAt: 1_700_000_001_000,
  originCreatedAt: 1_700_000_000_000,
  assets: [],
});

const dialect = new PgDialect();

afterEach(() => vi.restoreAllMocks());

function createMessagePageService() {
  const service = Object.create(
    FederationInboundMessagePageService.prototype,
  ) as FederationInboundMessagePageService & Record<string, unknown>;
  const routes = Object.create(
    FederationInboundMessageRouteService.prototype,
  ) as FederationInboundMessageRouteService & Record<string, unknown>;
  Object.assign(routes, { config: { domain: 'local.test' } });
  Object.assign(service, {
    config: { domain: 'local.test' },
    logger: { error: vi.fn(), warn: vi.fn() },
    threadAccess: { assertPeerResponseWritable: vi.fn() },
    validator: new FederationInboundMessageValidatorService(),
    routes: Object.assign(routes, {
      messageAuthor: vi.fn(
        (
          value: FederationMessageFeedMessage,
          sourceDomain: string,
          peerAssignedLocalNamespaceId?: number,
        ) =>
          FederationInboundMessageRouteService.prototype.messageAuthor.call(
            routes,
            value,
            sourceDomain,
            peerAssignedLocalNamespaceId ?? 12,
          ),
      ),
    }),
    inboundMessageStore: {
      store: vi.fn(),
      applyProcessingReceipt: vi.fn(),
    },
    deletedMessages: { applyPendingReceiptInTx: vi.fn() },
  });
  return service;
}

describe('federation message context isolation', () => {
  it.each([{ seq: 8 }, { originSeq: 8 }])(
    'accepts a single quote coordinate %j at the envelope boundary',
    (quoteTarget) => {
      const validator = new FederationInboundMessageValidatorService();
      expect(() =>
        validator.assertEnvelope({
          ...item('10'),
          quoteTarget,
          quoteDigest: 'd'.repeat(64),
        }),
      ).not.toThrow();
    },
  );

  it.each([
    null,
    {},
    { seq: 0 },
    { originSeq: 0 },
    { seq: 8, originSeq: 8 },
    { targetSeq: 8 },
    { seq: Number.MAX_SAFE_INTEGER },
  ])(
    'rejects invalid quote shape %j at the envelope boundary',
    (quoteTarget) => {
      const validator = new FederationInboundMessageValidatorService();
      expect(() =>
        validator.assertEnvelope({
          ...item('10'),
          quoteTarget,
          quoteDigest: 'd'.repeat(64),
        } as never),
      ).toThrow();
    },
  );
  it.each(
    [false, true].flatMap((reverse) =>
      ['SYSTEM', 'FORWARD', 'GALLERY'].map((contentType) => ({
        reverse,
        contentType,
      })),
    ),
  )(
    'continues past malformed $contentType data in a page (reverse=$reverse)',
    async ({ reverse, contentType }) => {
      const service = createMessagePageService();
      const resolve = vi.fn().mockResolvedValue({
        threadId: 9,
        creatorAccount: 'alice',
        profileNamespaceId: 12,
        authority: 'PEER',
      });
      Object.assign(service, { resolveMissedThreadInTransaction: resolve });
      const bad = item(reverse ? '71' : '69');
      bad.contentType = contentType;
      bad.content =
        contentType === 'FORWARD' ? 'invalid-json' : '{"items":null}';
      const good: FederationMessageFeedMessage = {
        ...item('70'),
        author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
        originSeq: null,
        originCreatedAt: null,
      };
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        query: {
          message: {
            findFirst: vi.fn().mockResolvedValue({
              originServerTime: new Date(good.createdAt),
            }),
          },
        },
      };
      const options = reverse
        ? {
            sequencePolicy: {
              kind: 'MAP_ORIGIN' as const,
              beforeSeq: 100,
              throughSeq: 40,
              messageSeqOffset: 0,
            },
          }
        : {};
      await expect(
        service.apply(
          tx as never,
          'peer.test',
          [bad, good],
          { namespaceId: 9 } as never,
          options,
        ),
      ).resolves.toEqual([]);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(tx.query.message.findFirst).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    [false, true].flatMap((reverse) =>
      [12, 13].flatMap((authorNamespaceId) =>
        [false, true].map((receipt) => ({
          reverse,
          authorNamespaceId,
          receipt,
        })),
      ),
    ),
  )(
    'skips non-home group authors without receipt side effects and continues the page (reverse=$reverse, namespace=$authorNamespaceId, receipt=$receipt)',
    async ({ reverse, authorNamespaceId, receipt }) => {
      const service = createMessagePageService();
      const good: FederationMessageFeedMessage = {
        ...item('70'),
        thread: { account: '!group' },
        author: { account: 'alice', namespaceId: 0 },
        originSeq: null,
        originCreatedAt: null,
      };
      const bad: FederationMessageFeedMessage = {
        ...good,
        seq: reverse ? 71 : 69,
        // Same account as the accepted home author, but a different identity.
        author: { account: 'alice', namespaceId: authorNamespaceId },
        originSeq: receipt ? 3 : null,
        originCreatedAt: receipt ? good.createdAt : null,
      };
      const execute = vi.fn(async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        return {
          rows: query.sql.includes('FROM "RelationshipPair" pair')
            ? [{ threadId: 9, toAccount: '!group' }]
            : [],
        };
      });
      const findFirst = vi.fn().mockResolvedValue({
        federationEnvelopeDigest:
          new FederationInboundMessageValidatorService().immutableEnvelopeDigest(
            good,
          ),
      });
      const store = vi.fn();
      const applyProcessingReceipt = vi.fn();
      Object.assign(service, {
        inboundMessageStore: { store, applyProcessingReceipt },
      });
      await expect(
        service.apply(
          { execute, query: { message: { findFirst } } } as never,
          'peer.test',
          [bad, good],
          { namespaceId: 9, peerAssignedLocalNamespaceId: 12 } as never,
          {
            expectedThreadId: 9,
            ...(reverse
              ? {
                  sequencePolicy: {
                    kind: 'MAP_ORIGIN' as const,
                    beforeSeq: 100,
                    throughSeq: 40,
                    messageSeqOffset: 0,
                  },
                }
              : {}),
          },
        ),
      ).resolves.toEqual([]);
      // The following home-authored replay still reaches message lookup.
      // The filtered item never reaches receipt association or message writes.
      expect(findFirst).toHaveBeenCalledOnce();
      expect(store).not.toHaveBeenCalled();
      expect(applyProcessingReceipt).not.toHaveBeenCalled();
      const statements = execute.mock.calls.map(
        ([statement]) => dialect.sqlToQuery(statement).sql,
      );
      expect(
        statements.filter((query) => query.startsWith('ROLLBACK TO SAVEPOINT')),
      ).toHaveLength(1);
    },
  );

  it('does not discard database failures as malformed peer messages', async () => {
    const service = createMessagePageService();
    Object.assign(service, {
      resolveMissedThreadInTransaction: vi
        .fn()
        .mockRejectedValue(new Error('database unavailable')),
    });
    await expect(
      service.apply(
        { execute: vi.fn() } as never,
        'peer.test',
        [item('1')],
        {} as never,
      ),
    ).rejects.toThrow('database unavailable');
  });
  it.each(
    [false, true].flatMap((reverse) =>
      [false, true].map((media) => ({ reverse, media })),
    ),
  )(
    'admits fanout only for forward messages (reverse=$reverse, media=$media)',
    async ({ reverse, media }) => {
      const service = Object.create(
        FederationInboundMessageStoreService.prototype,
      ) as FederationInboundMessageStoreService & Record<string, unknown>;
      const insertedValues = vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        returning: vi.fn().mockResolvedValue([
          {
            id: 1n,
            threadId: 9,
            seq: 70,
            originSeq: 70,
            publisherNamespaceId: 4,
            creatorAccount: 'bob',
            profileNamespaceId: 12,
            contentType: 'PURE_TEXT',
            content: JSON.stringify({ text: 'history' }),
            localState: 'STUB',
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      });
      const tx = {
        query: {
          message: { findFirst: vi.fn().mockResolvedValue(undefined) },
          federatedMessageTombstone: {
            findFirst: vi.fn().mockResolvedValue(undefined),
          },
        },
        insert: vi.fn().mockReturnValue({ values: insertedValues }),
        select: vi.fn().mockReturnValue({
          from: () => ({
            where: () => ({ limit: async () => [{ authorizationEpoch: 0 }] }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({ rowCount: 0 }),
      };
      Object.assign(service, {
        config: { domain: 'local.example' },
        threadAccess: { assertResponseWritable: vi.fn() },
        assertMappedMessageSeqAvailable: vi.fn(),
        enqueueFanout: vi.fn(),
        allocateMessageSeq: vi.fn().mockResolvedValue(78),
        quota: { tickLax: vi.fn() },
      });
      vi.spyOn(
        DeletedMessageService,
        'lockFederatedIdentity',
      ).mockResolvedValue({} as never);
      const publishMessage = vi
        .spyOn(ThreadFeedHeadWriter, 'advanceInTx')
        .mockResolvedValue({} as never);

      await service.store(tx as never, {
        threadId: 9,
        creator: { account: 'bob', namespaceId: 12 },
        fetchedFromDomain: 'origin.test',
        namespaceId: 12,
        profileNamespaceId: 12,
        message: {
          originSeq: 70,
          profileRev: 0,
          contentType: media ? 'FILE' : 'PURE_TEXT',
          content: JSON.stringify(
            media
              ? {
                  url: `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`,
                  name: 'history.txt',
                  size: 1,
                  mimeType: 'text/plain',
                }
              : { text: 'history' },
          ),
          ts: 1_700_000_000_000,
        },
        payloadDigest: 'a'.repeat(64),
        federationEnvelopeDigest: 'b'.repeat(64),
        incomingText: null,
        originTime: new Date(1_700_000_000_000),
        sequencePolicy: reverse
          ? {
              kind: 'MAP_ORIGIN',
              beforeSeq: 100,
              throughSeq: 40,
              messageSeqOffset: 7,
            }
          : undefined,
      });

      expect(insertedValues).toHaveBeenCalledWith(
        expect.objectContaining({
          seq: reverse ? 77 : 78,
          localState: reverse || media ? 'STUB' : 'READY',
        }),
      );
      expect(publishMessage).not.toHaveBeenCalled();
      expect(
        (
          service as unknown as {
            enqueueFanout: { mock: { calls: unknown[][] } };
          }
        ).enqueueFanout.mock.calls,
      ).toHaveLength(reverse ? 0 : 1);
    },
  );

  it('does not publish realtime effects for a committed historical message', async () => {
    const service = Object.create(
      FederationInboundMessageEffectsService.prototype,
    ) as FederationInboundMessageEffectsService & Record<string, unknown>;
    const rebuildUntrustedCards = vi.fn();
    const localizeForwardAssets = vi.fn();
    const runFileSyncBatch = vi.fn();
    Object.assign(service, {
      config: { forwardedResourcePolicy: 'trust' },
      forwardBundles: { rebuildUntrustedCards },
      linkPreview: { buildCardContent: vi.fn() },
      mediaLocalization: { localizeForwardAssets },
      inboundMediaBatches: { runFileSyncBatch },
    });

    await service.publish('origin.test', [
      {
        kind: 'message',
        historical: true,
        threadId: 9,
        originSeq: 70,
        recipients: [7],
        toAccount: 'alice',
        author: { account: 'bob', namespaceId: 12 },
        message: {
          seq: 70,
          creatorAccount: 'bob',
          profileNamespaceId: 12,
          createdAt: new Date(),
          isDeleted: false,
        },
      },
    ] as never);

    expect(rebuildUntrustedCards).not.toHaveBeenCalled();
    expect(localizeForwardAssets).not.toHaveBeenCalled();
    expect(runFileSyncBatch).not.toHaveBeenCalled();
  });

  it('executes profile fetch and evidence work carried by the committed message effect', async () => {
    const service = Object.create(
      FederationInboundMessageEffectsService.prototype,
    ) as FederationInboundMessageEffectsService & Record<string, unknown>;
    const resolveDemand = vi.fn().mockResolvedValue(undefined);
    const resolveEvidence = vi.fn().mockResolvedValue(undefined);
    const demand = {
      namespaceId: 7,
      lookup: 'GROUP_MEMBER_PROFILE',
      target: {
        account: 'bob',
        domain: 'member.test',
        rev: 4,
      },
      groupAccount: '!group',
    };
    const evidence = {
      profile: {
        namespaceId: 7,
        account: 'bob',
        domain: 'member.test',
        rev: 4,
      },
      lookup: 'GROUP_MEMBER_PROFILE',
      groupAccount: '!group',
      projection: { threadId: 9, messageSeq: 70 },
    };
    Object.assign(service, {
      config: { forwardedResourcePolicy: 'trust' },
      profileResolutions: { resolveDemand },
      profileEvidenceProjections: { resolve: resolveEvidence },
      forwardBundles: { rebuildUntrustedCards: vi.fn() },
    });

    await service.publish('origin.test', [
      {
        kind: 'message',
        historical: true,
        threadId: 9,
        originSeq: 70,
        recipients: [],
        toAccount: '!group',
        author: { account: 'bob', namespaceId: 12 },
        profileDemand: demand,
        profileEvidenceProjection: evidence,
        message: {
          seq: 70,
          createdAt: new Date(),
          isDeleted: false,
        },
      },
    ] as never);

    expect(resolveDemand).toHaveBeenCalledOnce();
    expect(resolveDemand).toHaveBeenCalledWith(demand);
    expect(resolveEvidence).toHaveBeenCalledOnce();
    expect(resolveEvidence).toHaveBeenCalledWith(evidence);
  });

  it.each([
    ['trust', 0],
    ['rebuild', 1],
  ] as const)(
    'applies the %s forwarded-resource policy after bundle import',
    async (policy, expectedCalls) => {
      const service = Object.create(
        FederationInboundMessageEffectsService.prototype,
      ) as FederationInboundMessageEffectsService & Record<string, unknown>;
      const rebuildUntrustedCards = vi.fn().mockResolvedValue(undefined);
      Object.assign(service, {
        config: { forwardedResourcePolicy: policy },
        forwardBundles: { rebuildUntrustedCards },
        linkPreview: { buildCardContent: vi.fn() },
      });

      await service.publish('origin.test', [
        {
          kind: 'message',
          historical: true,
          threadId: 9,
          originSeq: 70,
          recipients: [],
          toAccount: 'alice',
          author: { account: 'bob', namespaceId: 12 },
          localForwardBundleId: 'bundle',
          message: {
            seq: 70,
            profileRev: 0,
            creatorAccount: 'bob',
            profileNamespaceId: 12,
            createdAt: new Date(),
            isDeleted: false,
          },
        },
      ] as never);

      expect(rebuildUntrustedCards).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it('leaves live-message device notifications to durable fanout', async () => {
    const service = Object.create(
      FederationInboundMessageEffectsService.prototype,
    ) as FederationInboundMessageEffectsService & Record<string, unknown>;
    const rebuildUntrustedCards = vi.fn();
    const localizeForwardAssets = vi.fn();
    const runFileSyncBatch = vi.fn();
    Object.assign(service, {
      config: { forwardedResourcePolicy: 'trust' },
      forwardBundles: { rebuildUntrustedCards },
      linkPreview: { buildCardContent: vi.fn() },
      mediaLocalization: { localizeForwardAssets },
      inboundMediaBatches: { runFileSyncBatch },
    });

    await service.publish('origin.test', [
      {
        kind: 'message',
        historical: false,
        threadId: 9,
        originSeq: 70,
        recipients: [8, 7, 8],
        toAccount: 'alice',
        author: { account: 'bob', namespaceId: 12 },
        message: {
          seq: 12,
          profileRev: 0,
          creatorAccount: 'bob',
          profileNamespaceId: 12,
          createdAt: new Date(),
          isDeleted: false,
        },
      },
    ] as never);

    expect(rebuildUntrustedCards).not.toHaveBeenCalled();
    expect(localizeForwardAssets).not.toHaveBeenCalled();
    expect(runFileSyncBatch).not.toHaveBeenCalled();
  });

  it('records a receipt against a deleted local-authority message without warning', async () => {
    const service = createMessagePageService();
    const update = vi.fn();
    const warn = vi.fn();
    const applyProcessingReceipt = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger: { error: vi.fn(), warn },
      inboundMessageStore: { applyProcessingReceipt, store: vi.fn() },
      assertPeerResponseWritable: vi.fn(),
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorId: 7,
        authority: 'LOCAL',
        recipients: [7],
        toAccount: 'alice',
      }),
    });
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: {
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: 1n,
            createdAt: new Date(1_700_000_000_000),
            isDeleted: true,
          }),
        },
      },
      insert: vi.fn(),
      update,
    };

    await expect(
      service.apply(tx as never, 'group-origin.test', [item('1')], {
        namespaceId: 9,
      } as never),
    ).resolves.toEqual([]);

    expect(update).not.toHaveBeenCalled();
    expect(applyProcessingReceipt).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        namespaceId: 9,
        threadId: 9,
        peerSeq: 1,
        originSeq: 1,
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and skips a local-authority receipt whose origin target is absent', async () => {
    const service = createMessagePageService();
    const warn = vi.fn();
    const inboundStore = {
      store: vi.fn(),
      applyProcessingReceipt: vi.fn(async () => {
        warn('LOCAL_SOURCE_MESSAGE_NOT_FOUND');
      }),
    };
    Object.assign(service, {
      logger: { error: vi.fn(), warn },
      inboundMessageStore: inboundStore,
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorAccount: 'bob',
        profileNamespaceId: 0,
        authority: 'LOCAL',
        recipients: [7],
        toAccount: 'alice',
      }),
    });
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: {
        message: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    };

    await expect(
      service.apply(tx as never, 'peer.test', [item('7')], {
        namespaceId: 9,
      } as never),
    ).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('LOCAL_SOURCE_MESSAGE_NOT_FOUND'),
    );
    expect(inboundStore.store).not.toHaveBeenCalled();
  });

  it('rejects origin coordinates on a peer-authoritative message', async () => {
    const service = createMessagePageService();
    const warn = vi.fn();
    Object.assign(service, {
      logger: { error: vi.fn(), warn },
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorAccount: 'alice',
        profileNamespaceId: 12,
        authority: 'PEER',
        recipients: [7],
        toAccount: 'alice',
      }),
    });
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

    await expect(
      service.apply(tx as never, 'peer.test', [item('7')], {
        namespaceId: 9,
      } as never),
    ).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'peer-authoritative message must not carry origin coordinates',
      ),
    );
  });

  it('records a reverse receipt without rewriting the local message source', async () => {
    const service = createMessagePageService();
    const update = vi.fn();
    const applyProcessingReceipt = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger: { error: vi.fn() },
      inboundMessageStore: { applyProcessingReceipt, store: vi.fn() },
      assertPeerResponseWritable: vi.fn(),
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorId: 7,
        authority: 'LOCAL',
        recipients: [7],
        toAccount: 'alice',
      }),
    });
    const tx = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => [{ id: 9 }] }),
          }),
        }),
      })),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: {
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: 1n,
            createdAt: new Date(1_700_000_000_000),
          }),
        },
      },
      insert: vi.fn(),
      update,
    };

    const reverseItem = item('70');
    await expect(
      service.apply(
        tx as never,
        'group-origin.test',
        [reverseItem],
        { namespaceId: 9 } as never,
        {
          sequencePolicy: {
            kind: 'MAP_ORIGIN',
            beforeSeq: 100,
            throughSeq: 40,
            messageSeqOffset: 0,
          },
        },
      ),
    ).resolves.toEqual([]);

    expect(update).not.toHaveBeenCalled();
    expect(applyProcessingReceipt).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        namespaceId: 9,
        threadId: 9,
        peerSeq: 70,
        originSeq: 70,
        sequencePolicy: expect.objectContaining({ kind: 'MAP_ORIGIN' }),
      }),
    );
  });

  it('deduplicates an exact immutable-envelope replay by publisher namespace', async () => {
    const service = createMessagePageService();
    const incoming = item('70');
    incoming.createdAt = 1_700_000_001_000;
    incoming.author.ref = 'THREAD_ACCOUNT';
    incoming.author.namespaceId = 0;
    incoming.originSeq = null;
    incoming.originCreatedAt = null;
    const findFirst = vi.fn().mockResolvedValue({
      id: 1n,
      creatorAccount: 'bob',
      profileNamespaceId: 12,
      profileRev: incoming.profileRev,
      contentType: incoming.contentType,
      originServerTime: new Date(incoming.createdAt),
      payloadDigest: 'unused-for-fingerprinted-row',
      federationEnvelopeDigest:
        new FederationInboundMessageValidatorService().immutableEnvelopeDigest(
          incoming,
        ),
    });
    Object.assign(service, {
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorId: 7,
        creatorAccount: 'bob',
        profileNamespaceId: 12,
        authority: 'PEER',
        recipients: [7],
        toAccount: 'alice',
      }),
    });
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: { message: { findFirst } },
    };

    await expect(
      service.apply(tx as never, 'peer.test', [incoming], {
        namespaceId: 22,
      } as never),
    ).resolves.toEqual([]);

    const query = dialect.sqlToQuery(findFirst.mock.calls[0]![0].where as SQL);
    expect(query.sql).toContain('"Message"."publisherNamespaceId"');
    expect(query.params).toContain(22);
  });

  it('rejects conflicting immutable fields at an existing origin coordinate', async () => {
    const service = createMessagePageService();
    const warn = vi.fn();
    const incoming: FederationMessageFeedMessage = {
      ...item('70'),
      author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
      originSeq: null,
      originCreatedAt: null,
    };
    Object.assign(service, {
      logger: { error: vi.fn(), warn },
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorAccount: 'bob',
        profileNamespaceId: 12,
        authority: 'PEER',
        recipients: [7],
        toAccount: 'alice',
      }),
    });
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: {
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: 1n,
            creatorAccount: 'bob',
            profileNamespaceId: 12,
            profileRev: incoming.profileRev,
            contentType: incoming.contentType,
            originServerTime: new Date(incoming.createdAt),
            payloadDigest: 'retained',
            federationEnvelopeDigest: 'different-envelope',
          }),
        },
      },
    };

    await expect(
      service.apply(tx as never, 'peer.test', [incoming], {
        namespaceId: 22,
      } as never),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'conflicting immutable federated message envelope',
      ),
    );
  });

  it('rejects a reverse page item below its persisted closure target before applying it', async () => {
    const service = createMessagePageService();
    Object.assign(service, {
      assertPeerResponseWritable: vi.fn(),
    });
    const tx = { execute: vi.fn() };

    await expect(
      service.apply(
        tx as never,
        'group-origin.test',
        [item('39')],
        {} as never,
        {
          sequencePolicy: {
            kind: 'MAP_ORIGIN',
            beforeSeq: 100,
            throughSeq: 40,
            messageSeqOffset: 0,
          },
        },
      ),
    ).rejects.toThrow(
      'federated message origin seq must not precede the reverse through cursor',
    );
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('rolls back a page that references an unknown thread', async () => {
    const service = createMessagePageService();
    const logger = { error: vi.fn() };
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger,
      assertPeerResponseWritable: vi.fn(),
    });
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(
        new FederationMessageContextError('friend/thread is absent'),
      )
      .mockResolvedValueOnce({
        threadId: 9,
        creatorId: 7,
        authority: 'LOCAL',
        recipients: [7],
        toAccount: 'alice',
      });
    Object.assign(service, { resolveMissedThreadInTransaction: resolve });
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: {
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: 1n,
            originSeq: null,
            originServerTime: null,
          }),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    };
    await expect(
      service.apply(
        tx as never,
        'peer.test',
        [item('1'), item('2')],
        {} as never,
      ),
    ).rejects.toThrow('friend/thread is absent');
    expect(resolve).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips an unresolved thread after state recovery so later messages can progress', async () => {
    const service = createMessagePageService();
    const logger = { error: vi.fn() };
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger,
      assertPeerResponseWritable: vi.fn(),
      resolveMissedThreadInTransaction: vi
        .fn()
        .mockRejectedValue(
          new FederationMessageContextError('friend/thread is absent'),
        ),
    });
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

    await expect(
      service.apply(tx as never, 'peer.test', [item('1')], {} as never, {
        isolateMissingContext: true,
      }),
    ).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unresolved context after state recovery'),
    );
  });

  it('stores a local P2P author with profile namespace zero after inbound normalization', async () => {
    const service = createMessagePageService();
    const store = vi.fn().mockResolvedValue({
      kind: 'message',
      message: {
        threadId: 9,
        seq: 1,
        profileRev: 3,
        creatorAccount: 'bob',
        profileNamespaceId: 0,
        isDeleted: false,
      },
    });
    Object.assign(service, {
      inboundMessageStore: { store },
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorAccount: 'bob',
        profileNamespaceId: 0,
        authority: 'PEER',
        recipients: [7],
        toAccount: 'alice',
      }),
    });
    const inbound = {
      ...item('1'),
      originSeq: null,
      originCreatedAt: null,
    };
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: {
        message: { findFirst: vi.fn().mockResolvedValue(undefined) },
        deletedMessage: { findFirst: vi.fn() },
      },
    };

    await service.apply(tx as never, 'peer.test', [inbound], {
      namespaceId: 7,
    } as never);

    expect(store).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        creator: { account: 'bob', namespaceId: 0 },
        namespaceId: 7,
        profileNamespaceId: 0,
      }),
    );
  });

  it('keeps a publisher-local group author as the local marker', async () => {
    const service = createMessagePageService();
    const logger = { error: vi.fn(), warn: vi.fn() };
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger,
      assertPeerResponseWritable: vi.fn(),
    });
    const localAuthorItem = {
      ...item('1'),
      thread: { account: '!group' },
      author: { account: 'alice', namespaceId: 0 },
    } satisfies FederationMessageFeedMessage;
    const author = (
      service as unknown as {
        federatedMessageAuthor(
          value: FederationMessageFeedMessage,
          peerDomain: string,
          peerAssignedLocalNamespaceId: number,
        ): { account: string; namespaceId: number };
      }
    ).federatedMessageAuthor(localAuthorItem, 'peer.test', 7);

    expect(author).toEqual({ account: 'alice', namespaceId: 0 });
  });

  it('logs and skips malformed wire data instead of aborting the page', async () => {
    const service = createMessagePageService();
    const logger = { error: vi.fn(), warn: vi.fn() };
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger,
      assertPeerResponseWritable: vi.fn(),
    });
    const malformed = item('1');
    malformed.originSeq = -1;
    malformed.content = JSON.stringify({
      text: 'secret-message-body-that-must-not-be-logged',
    });
    malformed.author.ref = 'attacker\nforged-log-line' as 'THREAD_ACCOUNT';
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

    await expect(
      service.apply(tx as never, 'peer.test', [malformed], {} as never),
    ).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('filtered malformed inbound message'),
    );
    const logged = String(logger.warn.mock.calls[0]?.[0]);
    expect(logged).toContain('contentSha256');
    expect(logged).toContain('contentBytes');
    expect(logged).not.toContain('secret-message-body-that-must-not-be-logged');
    expect(logged).not.toContain('attacker\nforged-log-line');
  });

  it('warns and skips a malformed reverse item without aborting the batch', async () => {
    const service = createMessagePageService();
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger: { error: vi.fn(), warn: vi.fn() },
      assertPeerResponseWritable: vi.fn(),
    });
    const malformed = item('70');
    malformed.contentType = 'SYSTEM';
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      service.apply(
        { execute } as never,
        'peer.test',
        [malformed],
        {} as never,
        {
          sequencePolicy: {
            kind: 'MAP_ORIGIN',
            beforeSeq: 100,
            throughSeq: 40,
            messageSeqOffset: 0,
          },
        },
      ),
    ).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it.each(['SYSTEM', 'STICKER'])(
    'uniformly logs and skips unknown content type %s',
    async (contentType) => {
      const service = createMessagePageService();
      const logger = { error: vi.fn(), warn: vi.fn() };
      Object.assign(service, {
        config: { domain: 'local.test' },
        logger,
        assertPeerResponseWritable: vi.fn(),
      });
      const unknown = item('1');
      unknown.contentType = contentType;
      const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

      await expect(
        service.apply(tx as never, 'peer.test', [unknown], {} as never),
      ).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown federated message content type'),
      );
    },
  );
});
