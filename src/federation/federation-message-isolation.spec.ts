import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../relationship/thread-content-lock.js', () => ({
  lockThreadContentInTx: vi.fn().mockResolvedValue(true),
  requireThreadContentLockInTx: vi.fn(
    async (tx, threadId, held) => held ?? { tx, threadId },
  ),
  acquireThreadContentLockInTx: vi.fn(async (tx, threadId) => ({
    tx,
    threadId,
  })),
}));
import { ClientThreadContentHeadWriter } from '../message/client-message-feed.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import {
  FederationService,
  FederationMessageContextError,
} from './federation.service.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';
import { FederationInboundMessageStoreService } from './federation-inbound-message-store.service.js';
import { FederationInboundMessagePageService } from './federation-inbound-message-page.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';

const item = (sequence: string): FederationMessageFeedMessage => ({
  thread: {
    account: 'alice',
    peerAccount: 'bob',
  },
  authorRef: 'THREAD_PEER_ACCOUNT',
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
    routes,
    inboundMessageStore: { store: vi.fn() },
  });
  return service;
}

describe('federation message context isolation', () => {
  it.each([{ seq: 0 }, { seq: 8 }, { originSeq: 8 }])(
    'accepts a single quote coordinate %j at the envelope boundary',
    (quoteTarget) => {
      const validator = new FederationInboundMessageValidatorService();
      expect(() =>
        validator.assertEnvelope({ ...item('10'), quoteTarget }),
      ).not.toThrow();
    },
  );

  it.each([
    null,
    {},
    { seq: 8, originSeq: 8 },
    { targetSeq: 8 },
    { seq: Number.MAX_SAFE_INTEGER },
  ])(
    'rejects invalid quote shape %j at the envelope boundary',
    (quoteTarget) => {
      const validator = new FederationInboundMessageValidatorService();
      expect(() =>
        validator.assertEnvelope({ ...item('10'), quoteTarget } as never),
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
        creatorDomain: 'peer.test',
      });
      Object.assign(service, { resolveMissedThreadInTransaction: resolve });
      const bad = item(reverse ? '71' : '69');
      bad.contentType = contentType;
      bad.content =
        contentType === 'FORWARD' ? 'invalid-json' : '{"items":null}';
      const good = { ...item('70'), authorRef: 'THREAD_ACCOUNT' as const };
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
      expect(resolve).toHaveBeenCalledTimes(contentType === 'SYSTEM' ? 1 : 2);
      expect(tx.query.message.findFirst).toHaveBeenCalledTimes(1);
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
  it('does not publish THREAD_CONTENT_HEAD when committing reverse history', async () => {
    const service = Object.create(
      FederationInboundMessageStoreService.prototype,
    ) as FederationInboundMessageStoreService & Record<string, unknown>;
    const insertedValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: 1n,
          threadId: 9,
          seq: 70,
          originSeq: 70,
          sourceNamespaceId: 4,
          creatorAccount: 'bob',
          creatorDomain: 'origin.test',
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
      execute: vi.fn().mockResolvedValue({ rowCount: 0 }),
    };
    Object.assign(service, {
      config: { domain: 'local.example' },
      threadAccess: { assertResponseWritable: vi.fn() },
      assertMappedMessageSeqAvailable: vi.fn(),
      quota: { tickLax: vi.fn() },
    });
    vi.spyOn(DeletedMessageService, 'lockFederatedIdentity').mockResolvedValue(
      {} as never,
    );
    const publishMessage = vi
      .spyOn(ClientThreadContentHeadWriter, 'publishMessage')
      .mockResolvedValue(undefined);

    await service.store(tx as never, {
      threadId: 9,
      creator: { account: 'bob', domain: 'origin.test' },
      fetchedFromDomain: 'origin.test',
      namespaceId: 12,
      message: {
        originSeq: 70,
        clientMessageId: null,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'history' }),
        ts: 1_700_000_000_000,
      },
      expectedFederationVersion: 4,
      incomingText: null,
      originTime: new Date(1_700_000_000_000),
      sequencePolicy: {
        kind: 'MAP_ORIGIN',
        beforeSeq: 100,
        throughSeq: 40,
        messageSeqOffset: 7,
      },
    });

    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 77, localState: 'STUB' }),
    );
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('does not publish realtime effects for a committed historical message', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const signalOutbound = vi.fn();
    const signalDeletionOutbound = vi.fn();
    const notifyFeedUpdates = vi.fn();
    Object.assign(service, {
      config: { forwardedResourcePolicy: 'trust' },
      clientStateFeed: {
        readEndId: vi.fn(),
        notifyFeedUpdates,
      },
      forwardBundles: { rebuildUntrustedCards: vi.fn() },
      signalOutbound,
      signalDeletionOutbound,
      unblockedRecipients: vi.fn(),
    });

    await service.publishMessageQueryEffects('origin.test', [
      {
        kind: 'message',
        historical: true,
        threadId: 9,
        originSeq: 70,
        recipients: [7],
        toAccount: 'alice',
        author: { account: 'bob', domain: 'origin.test' },
        message: {
          seq: 70,
          creatorAccount: 'bob',
          creatorDomain: 'origin.test',
          createdAt: new Date(),
          isDeleted: false,
        },
      },
    ] as never);

    expect(signalOutbound).not.toHaveBeenCalled();
    expect(signalDeletionOutbound).not.toHaveBeenCalled();
    expect(notifyFeedUpdates).not.toHaveBeenCalled();
  });

  it.each([
    ['trust', 0],
    ['rebuild', 1],
  ] as const)(
    'applies the %s forwarded-resource policy after bundle import',
    async (policy, expectedCalls) => {
      const service = Object.create(
        FederationService.prototype,
      ) as FederationService & Record<string, unknown>;
      const rebuildUntrustedCards = vi.fn().mockResolvedValue(undefined);
      Object.assign(service, {
        config: { forwardedResourcePolicy: policy },
        clientStateFeed: { readEndId: vi.fn(), notifyFeedUpdates: vi.fn() },
        forwardBundles: { rebuildUntrustedCards },
        linkPreview: { buildCardContent: vi.fn() },
      });

      await service.publishMessageQueryEffects('origin.test', [
        {
          kind: 'message',
          historical: true,
          threadId: 9,
          originSeq: 70,
          recipients: [],
          toAccount: 'alice',
          author: { account: 'bob', domain: 'origin.test' },
          localForwardBundleId: 'bundle',
          message: {
            seq: 70,
            profileRev: 0,
            creatorAccount: 'bob',
            creatorDomain: 'origin.test',
            createdAt: new Date(),
            isDeleted: false,
          },
        },
      ] as never);

      expect(rebuildUntrustedCards).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it('publishes a committed live message through the client state-feed throttler', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const readEndId = vi
      .fn()
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(17);
    const notifyFeedUpdates = vi.fn();
    Object.assign(service, {
      config: { forwardedResourcePolicy: 'trust' },
      clientStateFeed: { readEndId, notifyFeedUpdates },
      forwardBundles: { rebuildUntrustedCards: vi.fn() },
      linkPreview: { buildCardContent: vi.fn() },
      signalOutbound: vi.fn().mockResolvedValue(undefined),
      signalDeletionOutbound: vi.fn().mockResolvedValue(undefined),
    });

    await service.publishMessageQueryEffects('origin.test', [
      {
        kind: 'message',
        historical: false,
        threadId: 9,
        originSeq: 70,
        recipients: [8, 7, 8],
        toAccount: 'alice',
        author: { account: 'bob', domain: 'origin.test' },
        message: {
          seq: 12,
          profileRev: 0,
          creatorAccount: 'bob',
          creatorDomain: 'origin.test',
          createdAt: new Date(),
          isDeleted: false,
        },
      },
    ] as never);

    expect(readEndId.mock.calls).toEqual([[8], [7]]);
    expect(notifyFeedUpdates).toHaveBeenCalledWith([
      { userId: 8, feedId: 11 },
      { userId: 7, feedId: 17 },
    ]);
  });

  it('publishes a committed tombstone through the client state-feed throttler', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const readEndId = vi
      .fn()
      .mockResolvedValueOnce(23)
      .mockResolvedValueOnce(29);
    const notifyFeedUpdates = vi.fn();
    const publishSatisfiedQuoteDependencies = vi
      .fn()
      .mockResolvedValue(undefined);
    Object.assign(service, {
      clientStateFeed: { readEndId, notifyFeedUpdates },
      inboundMessageCommits: {
        applyTombstonesInTransaction: vi.fn().mockResolvedValue({
          quoteDependencies: [],
          recipientUserIds: [4, 6],
        }),
        publishSatisfiedQuoteDependencies,
      },
    });

    const publication = await service.applyForwardTombstonePageInTransaction(
      {} as never,
      {} as never,
    );
    expect(notifyFeedUpdates).not.toHaveBeenCalled();
    await publication.publish();

    expect(readEndId.mock.calls).toEqual([[4], [6]]);
    expect(notifyFeedUpdates).toHaveBeenCalledWith([
      { userId: 4, feedId: 23 },
      { userId: 6, feedId: 29 },
    ]);
    expect(publishSatisfiedQuoteDependencies).toHaveBeenCalledWith([]);
  });

  it('records a self-authored feed item as a delivery receipt without inserting a duplicate', async () => {
    const service = createMessagePageService();
    const update = vi.fn();
    const receiptValues = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger: { error: vi.fn() },
      assertPeerResponseWritable: vi.fn(),
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorId: 7,
        federationVersion: 0,
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
          }),
        },
        federationMessageReceipt: {
          findFirst: vi.fn().mockResolvedValue(undefined),
        },
      },
      insert: vi.fn().mockReturnValue({ values: receiptValues }),
      update,
    };

    await expect(
      service.apply(tx as never, 'group-origin.test', [item('1')], {
        namespaceId: 9,
      } as never),
    ).resolves.toEqual([]);

    expect(update).not.toHaveBeenCalled();
    expect(receiptValues).toHaveBeenCalledWith({
      namespaceId: 9,
      threadId: 9,
      peerSeq: 1,
      messageId: 1n,
    });
  });

  it('records a reverse receipt without rewriting the local message source', async () => {
    const service = createMessagePageService();
    const update = vi.fn();
    const receiptValues = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger: { error: vi.fn() },
      assertPeerResponseWritable: vi.fn(),
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorId: 7,
        federationVersion: 0,
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
        federationMessageReceipt: {
          findFirst: vi.fn().mockResolvedValue(undefined),
        },
      },
      insert: vi.fn().mockReturnValue({ values: receiptValues }),
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
    expect(receiptValues).toHaveBeenCalledWith({
      namespaceId: 9,
      threadId: 9,
      peerSeq: 70,
      messageId: 1n,
    });
  });

  it('deduplicates inbound messages by immutable source namespace', async () => {
    const service = createMessagePageService();
    const findFirst = vi.fn().mockResolvedValue({
      id: 1n,
      originServerTime: new Date(1_700_000_001_000),
    });
    Object.assign(service, {
      resolveMissedThreadInTransaction: vi.fn().mockResolvedValue({
        threadId: 9,
        creatorId: 7,
        creatorAccount: 'bob',
        creatorDomain: 'peer.test',
        federationVersion: 0,
        recipients: [7],
        toAccount: 'alice',
      }),
    });
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: { message: { findFirst } },
    };

    const incoming = item('70');
    incoming.createdAt = 1_700_000_001_000;
    incoming.authorRef = 'THREAD_ACCOUNT';
    await expect(
      service.apply(tx as never, 'peer.test', [incoming], {
        namespaceId: 22,
      } as never),
    ).resolves.toEqual([]);

    const query = dialect.sqlToQuery(findFirst.mock.calls[0]![0].where as SQL);
    expect(query.sql).toContain('"Message"."sourceNamespaceId"');
    expect(query.params).toContain(22);
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
        federationVersion: 0,
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

  it('maps a group author local domain to the authenticated peer domain', async () => {
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
      author: { account: 'alice', domain: 'local' },
    } as FederationMessageFeedMessage;
    delete (localAuthorItem as { authorRef?: unknown }).authorRef;
    const author = (
      service as unknown as {
        federatedMessageAuthor(
          value: FederationMessageFeedMessage,
          peerDomain: string,
        ): { account: string; domain: string };
      }
    ).federatedMessageAuthor(localAuthorItem, 'peer.test');

    expect(author).toEqual({ account: 'alice', domain: 'peer.test' });
  });

  it('warns when applying a group author local-domain compatibility item', async () => {
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
      author: { account: 'alice', domain: 'local' },
      contentType: 'STICKER',
    } as unknown as FederationMessageFeedMessage;
    delete (localAuthorItem as { authorRef?: unknown }).authorRef;
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

    await expect(
      service.apply(tx as never, 'peer.test', [localAuthorItem], {} as never),
    ).resolves.toEqual([]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('authenticated peer domain'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown federated message content type'),
    );
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
    malformed.authorRef = 'attacker\nforged-log-line' as 'THREAD_ACCOUNT';
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

    await expect(
      service.apply(tx as never, 'peer.test', [malformed], {} as never),
    ).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ignored invalid federated message'),
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
    expect(execute).toHaveBeenCalledTimes(3);
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
