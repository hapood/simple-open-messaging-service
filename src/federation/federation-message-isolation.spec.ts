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
import { FederationInboundMessagePreparationService } from './federation-inbound-message-preparation.service.js';
import { FederationInboundMessageReceiptService } from './federation-inbound-message-receipt.service.js';
import { FederationInboundMessageStoreService } from './federation-inbound-message-store.service.js';
import { FederationInboundMessagePageService } from './federation-inbound-message-page.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { ForwardBundleService } from '../forward/forward-bundle.service.js';

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
  const validator = new FederationInboundMessageValidatorService();
  const routes = new FederationInboundMessageRouteService();
  const forwardBundles = new ForwardBundleService(
    {} as never,
    {} as never,
    {} as never,
  );
  const inboundMessageStore = {
    store: vi.fn(),
  };
  const service = new FederationInboundMessagePageService(
    { assertPeerResponseWritable: vi.fn() } as never,
    validator,
    routes,
    inboundMessageStore as never,
    forwardBundles,
  );
  const logger = { error: vi.fn(), warn: vi.fn() };
  Object.assign(service, { logger });
  return { service, logger, inboundMessageStore, routes };
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

  it.each(['SYSTEM', 'FORWARD', 'GALLERY'])(
    'filters malformed %s data in outer prepare before entering any transaction',
    (contentType) => {
      const { service, logger } = createMessagePageService();
      const bad = item('69');
      bad.contentType = contentType;
      bad.content =
        contentType === 'FORWARD' ? 'invalid-json' : '{"items":null}';
      const good: FederationMessageFeedMessage = {
        ...item('70'),
        author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
        originSeq: null,
        originCreatedAt: null,
      };

      const prepared = service.prepare(
        'peer.test',
        [bad, good],
        { namespaceId: 9, peerAssignedLocalNamespaceId: 12 } as never,
        new Map(),
      );

      expect(prepared).toHaveLength(1);
      expect(prepared[0]!.item.seq).toBe(70);
      expect(logger.warn).toHaveBeenCalledOnce();
    },
  );

  it('filters malformed FORWARD closures in outer prepare before entering any transaction', () => {
    const { service, logger } = createMessagePageService();
    const badForward: FederationMessageFeedMessage = {
      ...item('69'),
      author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
      originSeq: null,
      originCreatedAt: null,
      contentType: 'FORWARD',
      content: JSON.stringify({ bundleId: 'a'.repeat(64) }),
    };
    const closures = new Map([
      [0, { id: 'bad', messages: [], children: [], assets: [] }],
    ]);

    const prepared = service.prepare(
      'peer.test',
      [badForward],
      { namespaceId: 9, peerAssignedLocalNamespaceId: 12 } as never,
      closures,
    );

    expect(prepared).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'filtered malformed inbound message before transaction',
      ),
    );
  });

  it.each(
    [12, 13].flatMap((authorNamespaceId) =>
      [false, true].map((receipt) => ({ authorNamespaceId, receipt })),
    ),
  )(
    'skips non-home group authors in outer preparation without receipt side effects (namespace=$authorNamespaceId, receipt=$receipt)',
    async ({ authorNamespaceId, receipt }) => {
      const { service } = createMessagePageService();
      const good: FederationMessageFeedMessage = {
        ...item('70'),
        thread: { account: '!group' },
        author: { account: 'alice', namespaceId: 0 },
        originSeq: null,
        originCreatedAt: null,
      };
      const bad: FederationMessageFeedMessage = {
        ...good,
        seq: 69,
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
      const tx = {
        execute,
        query: {
          message: { findMany: vi.fn().mockResolvedValue([]) },
        },
      };
      const receipts = { process: vi.fn() };
      const preparation = new FederationInboundMessagePreparationService(
        {
          db: {
            transaction: vi.fn(async (run: (value: typeof tx) => unknown) =>
              run(tx),
            ),
          },
        } as never,
        service,
        new FederationInboundMessageRouteService(),
        receipts as never,
      );

      const result = await preparation.prepare(
        {
          threadId: 9,
          peerDomain: 'peer.test',
          peerToken: {
            domain: 'peer.test',
            namespaceId: 9,
            peerAssignedLocalNamespaceId: 12,
            rootPublicKey: 'root',
          },
          data: { messages: [bad, good], scannedThrough: 70, hasMore: false },
        },
        new Map(),
        1,
        new AbortController().signal,
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.item.seq).toBe(70);
      expect(receipts.process).not.toHaveBeenCalled();
    },
  );

  it('does not discard database failures during outer route resolution', async () => {
    const { service } = createMessagePageService();
    const preparation = new FederationInboundMessagePreparationService(
      {
        db: {
          transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
            run({
              query: { message: { findMany: vi.fn().mockResolvedValue([]) } },
            }),
          ),
        },
      } as never,
      service,
      {
        resolveMessage: vi
          .fn()
          .mockRejectedValue(new Error('database unavailable')),
      } as never,
      { process: vi.fn() } as never,
    );

    await expect(
      preparation.prepare(
        {
          threadId: 9,
          peerDomain: 'peer.test',
          peerToken: {
            domain: 'peer.test',
            namespaceId: 9,
            peerAssignedLocalNamespaceId: 12,
            rootPublicKey: 'root',
          },
          data: {
            messages: [
              {
                ...item('1'),
                author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
                originSeq: null,
                originCreatedAt: null,
              },
            ],
            scannedThrough: 1,
            hasMore: false,
          },
        },
        new Map(),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('database unavailable');
  });

  it('does not swallow storage errors inside applyPrepared', async () => {
    const { service, inboundMessageStore } = createMessagePageService();
    inboundMessageStore.store.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const tx = {
      query: {
        messageThread: {
          findFirst: vi.fn().mockResolvedValue({
            type: 'GROUP',
            authorityNamespaceId: 0,
            curSeq: 0,
          }),
        },
        message: { findMany: vi.fn().mockResolvedValue([]) },
      },
      execute: vi.fn(),
    };

    await expect(
      service.applyPrepared(
        tx as never,
        [
          {
            itemIndex: 0,
            item: {
              ...item('1'),
              author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
              originSeq: null,
              originCreatedAt: null,
            },
            author: { account: 'alice', namespaceId: 0 },
            sourceTime: new Date(),
            incomingText: { text: 'hello' },
            storedContent: JSON.stringify({ text: 'hello' }),
            wireDigest: 'a'.repeat(64),
            federationEnvelopeDigest: 'b'.repeat(64),
            creatorAccount: 'alice',
            profileNamespaceId: 0,
            recipients: [7],
            toAccount: 'bob',
          },
        ],
        {
          domain: 'peer.test',
          namespaceId: 9,
          peerAssignedLocalNamespaceId: 12,
          rootPublicKey: 'root',
        },
        {
          threadLock: { threadId: 9 } as never,
          processedInterval: { left: 0, right: 1 },
        },
      ),
    ).rejects.toThrow('database unavailable');
  });

  it('stores inbound messages as STUB without calling ThreadFeedHeadWriter', async () => {
    const service = Object.create(
      FederationInboundMessageStoreService.prototype,
    ) as FederationInboundMessageStoreService & Record<string, unknown>;
    const insertedValues = vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      returning: vi.fn().mockResolvedValue([
        {
          id: 1n,
          threadId: 9,
          seq: 77,
          originSeq: 70,
          publisherNamespaceId: 12,
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
      quota: { tickLax: vi.fn() },
    });
    vi.spyOn(DeletedMessageService, 'lockFederatedIdentity').mockResolvedValue(
      {} as never,
    );
    const publishMessage = vi
      .spyOn(ThreadFeedHeadWriter, 'advanceInTx')
      .mockResolvedValue({} as never);

    await service.store(tx as never, {
      threadLock: { threadId: 9 } as never,
      threadId: 9,
      seq: 77,
      creator: { account: 'bob', namespaceId: 12 },
      fetchedFromDomain: 'origin.test',
      namespaceId: 12,
      profileNamespaceId: 12,
      message: {
        originSeq: 70,
        profileRev: 0,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'history' }),
        ts: 1_700_000_000_000,
      },
      payloadDigest: 'a'.repeat(64),
      federationEnvelopeDigest: 'b'.repeat(64),
      incomingText: null,
      originTime: new Date(1_700_000_000_000),
    });

    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({
        seq: 77,
        localState: 'STUB',
      }),
    );
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('does not publish realtime effects for a committed historical message', async () => {
    const service = new FederationInboundMessageEffectsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
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
    const service = new FederationInboundMessageEffectsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
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
      const service = new FederationInboundMessageEffectsService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
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

  it('records a receipt against a deleted local-authority message without warning', async () => {
    const warn = vi.fn();
    const applyPendingReceiptInTx = vi.fn().mockResolvedValue(undefined);
    const lockEpoch = vi
      .spyOn(FederationThreadSyncStateService, 'lockAuthorizationEpochInTx')
      .mockResolvedValue({ threadId: 9 } as never);
    const original = {
      id: 1n,
      threadId: 9,
      seq: 1,
      publisherNamespaceId: 0,
      creatorAccount: 'bob',
      profileNamespaceId: 0,
      profileRev: 3,
      contentType: 'PURE_TEXT',
      payloadDigest: 'digest',
      createdAt: new Date(1_700_000_000_000),
      isDeleted: true,
    };
    const returning = vi.fn().mockResolvedValue([{ id: 1n }]);
    const tx = {
      query: {
        messageThread: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ type: 'GROUP', authorityNamespaceId: 9 }),
        },
        message: { findFirst: vi.fn().mockResolvedValue(original) },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      })),
    };
    const service = new FederationInboundMessageReceiptService(
      {
        db: {
          query: {
            message: { findFirst: vi.fn().mockResolvedValue(original) },
          },
          transaction: vi.fn(async (run: (value: typeof tx) => unknown) =>
            run(tx),
          ),
        },
      } as never,
      {
        resolveMessage: vi.fn().mockResolvedValue({
          threadId: 9,
          creatorAccount: 'bob',
          profileNamespaceId: 0,
          authority: 'LOCAL',
          recipients: [7],
          toAccount: '!group',
        }),
      } as never,
      { assertResourceResponseWritable: vi.fn() } as never,
      { applyPendingReceiptInTx } as never,
    );
    Object.assign(service, { logger: { warn } });

    await service.process(
      {
        threadId: 9,
        peerDomain: 'group-origin.test',
        peerToken: {
          domain: 'group-origin.test',
          namespaceId: 9,
          peerAssignedLocalNamespaceId: 12,
          rootPublicKey: 'root',
        },
        data: {},
      },
      1,
      {
        itemIndex: 0,
        item: {
          ...item('1'),
          thread: { account: '!group' },
          author: { account: 'bob', namespaceId: 0 },
        },
        author: { account: 'bob', namespaceId: 0 },
        sourceTime: new Date(1_700_000_001_000),
        incomingText: { text: 'message 1' },
        storedContent: JSON.stringify({ text: 'message 1' }),
        wireDigest: 'digest',
        federationEnvelopeDigest: 'env',
      },
      {
        threadId: 9,
        creatorAccount: 'bob',
        profileNamespaceId: 0,
        authority: 'LOCAL',
        recipients: [7],
        toAccount: '!group',
      },
      new AbortController().signal,
    );

    expect(lockEpoch).toHaveBeenCalledOnce();
    expect(applyPendingReceiptInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        namespaceId: 9,
        threadId: 9,
        peerSeq: 1,
        authority: 'GROUP_ORIGIN',
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and skips a local-authority receipt whose origin target is absent', async () => {
    const warn = vi.fn();
    const transaction = vi.fn();
    const service = new FederationInboundMessageReceiptService(
      {
        db: {
          query: {
            message: { findFirst: vi.fn().mockResolvedValue(undefined) },
          },
          transaction,
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    Object.assign(service, { logger: { warn } });

    await service.process(
      {
        threadId: 9,
        peerDomain: 'peer.test',
        peerToken: {
          domain: 'peer.test',
          namespaceId: 9,
          peerAssignedLocalNamespaceId: 12,
          rootPublicKey: 'root',
        },
        data: {},
      },
      1,
      {
        itemIndex: 0,
        item: item('7'),
        author: { account: 'bob', namespaceId: 0 },
        sourceTime: new Date(),
        incomingText: null,
        storedContent: '{}',
        wireDigest: 'digest',
        federationEnvelopeDigest: 'env',
      },
      {
        threadId: 9,
        creatorAccount: 'bob',
        profileNamespaceId: 0,
        authority: 'LOCAL',
        recipients: [7],
        toAccount: 'alice',
      },
      new AbortController().signal,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no matching published message'),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('filters remote messages carrying source coordinates in outer preparation', async () => {
    const { service } = createMessagePageService();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const preparation = new FederationInboundMessagePreparationService(
      {
        db: {
          transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
            run({
              query: { message: { findMany: vi.fn().mockResolvedValue([]) } },
            }),
          ),
        },
      } as never,
      service,
      {
        resolveMessage: vi.fn().mockResolvedValue({
          threadId: 9,
          creatorAccount: 'alice',
          profileNamespaceId: 12,
          authority: 'PEER',
          recipients: [7],
          toAccount: 'alice',
        }),
      } as never,
      { process: vi.fn() } as never,
    );
    Object.assign(preparation, { logger });

    const result = await preparation.prepare(
      {
        threadId: 9,
        peerDomain: 'peer.test',
        peerToken: {
          domain: 'peer.test',
          namespaceId: 9,
          peerAssignedLocalNamespaceId: 12,
          rootPublicKey: 'root',
        },
        data: {
          messages: [
            {
              ...item('7'),
              author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
            },
          ],
          scannedThrough: 7,
          hasMore: false,
        },
      },
      new Map(),
      1,
      new AbortController().signal,
    );

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'filtered remote message carrying source coordinates',
      ),
    );
  });

  it('warns and skips an existing remote coordinate without overwriting', async () => {
    const { service } = createMessagePageService();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const preparation = new FederationInboundMessagePreparationService(
      {
        db: {
          transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
            run({
              query: {
                message: {
                  findMany: vi.fn().mockResolvedValue([{ originSeq: 70 }]),
                },
              },
            }),
          ),
        },
      } as never,
      service,
      {
        resolveMessage: vi.fn().mockResolvedValue({
          threadId: 9,
          creatorAccount: 'bob',
          profileNamespaceId: 12,
          authority: 'PEER',
          recipients: [7],
          toAccount: 'alice',
        }),
      } as never,
      { process: vi.fn() } as never,
    );
    Object.assign(preparation, { logger });

    const result = await preparation.prepare(
      {
        threadId: 9,
        peerDomain: 'peer.test',
        peerToken: {
          domain: 'peer.test',
          namespaceId: 22,
          peerAssignedLocalNamespaceId: 12,
          rootPublicKey: 'root',
        },
        data: {
          messages: [
            {
              ...item('70'),
              author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
              originSeq: null,
              originCreatedAt: null,
            },
          ],
          scannedThrough: 70,
          hasMore: false,
        },
      },
      new Map(),
      1,
      new AbortController().signal,
    );

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ignored existing federated message coordinate'),
    );
  });

  it('propagates missing thread context from outer preparation without swallowing', async () => {
    const { service } = createMessagePageService();
    const preparation = new FederationInboundMessagePreparationService(
      {
        db: {
          transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
            run({
              query: { message: { findMany: vi.fn().mockResolvedValue([]) } },
            }),
          ),
        },
      } as never,
      service,
      {
        resolveMessage: vi
          .fn()
          .mockRejectedValue(
            new FederationMessageContextError('friend/thread is absent'),
          ),
      } as never,
      { process: vi.fn() } as never,
    );

    await expect(
      preparation.prepare(
        {
          threadId: 9,
          peerDomain: 'peer.test',
          peerToken: {
            domain: 'peer.test',
            namespaceId: 9,
            peerAssignedLocalNamespaceId: 12,
            rootPublicKey: 'root',
          },
          data: {
            messages: [
              {
                ...item('1'),
                author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
                originSeq: null,
                originCreatedAt: null,
              },
            ],
            scannedThrough: 1,
            hasMore: false,
          },
        },
        new Map(),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('friend/thread is absent');
  });

  it('keeps a publisher-local group author as the local marker', () => {
    const { service } = createMessagePageService();
    const localAuthorItem = {
      ...item('1'),
      thread: { account: '!group' },
      author: { account: 'alice', namespaceId: 0 },
    } satisfies FederationMessageFeedMessage;
    const author = (
      service as unknown as {
        federatedMessageAuthor(
          value: FederationMessageFeedMessage,
          peerAssignedLocalNamespaceId: number,
        ): { account: string; namespaceId: number };
      }
    ).federatedMessageAuthor(localAuthorItem, 7);

    expect(author).toEqual({ account: 'alice', namespaceId: 0 });
  });

  it('logs and skips malformed wire data in prepare without leaking message body', () => {
    const { service, logger } = createMessagePageService();
    const malformed = item('1');
    malformed.originSeq = -1;
    malformed.content = JSON.stringify({
      text: 'secret-message-body-that-must-not-be-logged',
    });
    malformed.author.ref = 'attacker\nforged-log-line' as 'THREAD_ACCOUNT';

    const prepared = service.prepare(
      'peer.test',
      [malformed],
      { namespaceId: 9, peerAssignedLocalNamespaceId: 12 } as never,
      new Map(),
    );

    expect(prepared).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('filtered malformed inbound message'),
    );
    const logged = String(logger.warn.mock.calls[0]?.[0]);
    expect(logged).toContain('contentSha256');
    expect(logged).toContain('contentBytes');
    expect(logged).not.toContain('secret-message-body-that-must-not-be-logged');
    expect(logged).not.toContain('attacker\nforged-log-line');
  });

  it.each(['SYSTEM', 'STICKER'])(
    'uniformly logs and skips unknown content type %s in prepare',
    (contentType) => {
      const { service, logger } = createMessagePageService();
      const unknown = item('1');
      unknown.contentType = contentType;

      const prepared = service.prepare(
        'peer.test',
        [unknown],
        { namespaceId: 9, peerAssignedLocalNamespaceId: 12 } as never,
        new Map(),
      );

      expect(prepared).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown federated message content type'),
      );
    },
  );
});
