import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientMessageFeedWriter } from '../message/client-message-feed.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import {
  FederationService,
  FederationMessageContextError,
} from './federation.service.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';

const item = (sequence: string): FederationMessageFeedMessage => ({
  thread: {
    account: 'alice',
    peerAccount: 'bob',
  },
  authorRef: 'THREAD_PEER_ACCOUNT',
  seq: Number(sequence),
  originSeq: Number(sequence),
  contentType: 'PURE_TEXT',
  content: JSON.stringify({ text: `message ${sequence}` }),
  createdAt: 1_700_000_001_000,
  originCreatedAt: 1_700_000_000_000,
  assets: [],
});

afterEach(() => vi.restoreAllMocks());

describe('federation message context isolation', () => {
  it('does not advance ClientMessageFeed when committing reverse history', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const insertedValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: 1n,
          threadId: 9,
          seq: 70,
          originSeq: 70,
          federationSourceDomain: 'origin.test',
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
    };
    Object.assign(service, {
      config: { domain: 'local.example' },
      assertThreadResponseWritable: vi.fn(),
      assertPreservedMessageSeqAvailable: vi.fn(),
      quota: { tickLax: vi.fn() },
    });
    vi.spyOn(DeletedMessageService, 'lockFederatedIdentity').mockResolvedValue(
      {} as never,
    );
    const publishMessage = vi
      .spyOn(ClientMessageFeedWriter, 'publishMessage')
      .mockResolvedValue(undefined);

    await (
      service as unknown as {
        storePulledMessageInTransaction(
          tx: object,
          params: object,
        ): Promise<unknown>;
      }
    ).storePulledMessageInTransaction(tx, {
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
        kind: 'PRESERVE_ORIGIN',
        beforeSeq: 100,
        throughSeq: 40,
      },
    });

    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 70, localState: 'STUB' }),
    );
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('does not publish realtime effects for a committed historical message', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const onNewMessage = vi.fn();
    const onDeletedMessageUpdated = vi.fn();
    const signalOutbound = vi.fn();
    const signalDeletionOutbound = vi.fn();
    Object.assign(service, {
      sse: { onNewMessage, onDeletedMessageUpdated },
      forwardBundles: { rebuildLinkCards: vi.fn() },
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

    expect(onNewMessage).not.toHaveBeenCalled();
    expect(onDeletedMessageUpdated).not.toHaveBeenCalled();
    expect(signalOutbound).not.toHaveBeenCalled();
    expect(signalDeletionOutbound).not.toHaveBeenCalled();
  });

  it('records a self-authored feed item as a delivery receipt without inserting a duplicate', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
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
      service.applyMessageQueryItemsInTransaction(
        tx as never,
        'group-origin.test',
        [item('1')],
        {} as never,
      ),
    ).resolves.toEqual([]);

    expect(update).not.toHaveBeenCalled();
    expect(receiptValues).toHaveBeenCalledWith({
      peerDomain: 'group-origin.test',
      threadId: 9,
      peerSeq: 1,
      messageId: 1n,
    });
  });

  it('backfills the publisher coordinate for a self-authored reverse item', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
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
            originSeq: null,
            federationSourceDomain: null,
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
      service.applyMessageQueryItemsInTransaction(
        tx as never,
        'group-origin.test',
        [reverseItem],
        {} as never,
        {
          sequencePolicy: {
            kind: 'PRESERVE_ORIGIN',
            beforeSeq: 100,
            throughSeq: 40,
          },
        },
      ),
    ).resolves.toEqual([]);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        originSeq: 70,
        federationSourceDomain: 'group-origin.test',
        updatedAt: expect.any(Date),
      }),
    );
    expect(receiptValues).toHaveBeenCalledWith({
      peerDomain: 'group-origin.test',
      threadId: 9,
      peerSeq: 70,
      messageId: 1n,
    });
  });

  it('rejects a reverse page item below its persisted closure target before applying it', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    Object.assign(service, {
      assertPeerResponseWritable: vi.fn(),
    });
    const tx = { execute: vi.fn() };

    await expect(
      service.applyMessageQueryItemsInTransaction(
        tx as never,
        'group-origin.test',
        [item('39')],
        {} as never,
        {
          sequencePolicy: {
            kind: 'PRESERVE_ORIGIN',
            beforeSeq: 100,
            throughSeq: 40,
          },
        },
      ),
    ).rejects.toThrow(
      'federated message origin seq must not precede the reverse through cursor',
    );
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('rolls back a page that references an unknown thread', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
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
      service.applyMessageQueryItemsInTransaction(
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
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
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
      service.applyMessageQueryItemsInTransaction(
        tx as never,
        'peer.test',
        [item('1')],
        {} as never,
        { isolateMissingContext: true },
      ),
    ).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unresolved context after state recovery'),
    );
  });

  it('maps a group author local domain to the authenticated peer domain', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
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
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
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
      service.applyMessageQueryItemsInTransaction(
        tx as never,
        'peer.test',
        [localAuthorItem],
        {} as never,
      ),
    ).resolves.toEqual([]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('authenticated peer domain'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unknown federated message content type'),
    );
  });

  it('logs and skips malformed wire data instead of aborting the page', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const logger = { error: vi.fn() };
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
      service.applyMessageQueryItemsInTransaction(
        tx as never,
        'peer.test',
        [malformed],
        {} as never,
      ),
    ).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ignored invalid federated message'),
    );
    const logged = String(logger.error.mock.calls[0]?.[0]);
    expect(logged).toContain('contentSha256');
    expect(logged).toContain('contentBytes');
    expect(logged).not.toContain('secret-message-body-that-must-not-be-logged');
    expect(logged).not.toContain('attacker\nforged-log-line');
  });

  it('aborts a reverse batch when one item cannot be staged', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger: { error: vi.fn() },
      assertPeerResponseWritable: vi.fn(),
    });
    const malformed = item('70');
    malformed.contentType = 'SYSTEM';
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      service.applyMessageQueryItemsInTransaction(
        { execute } as never,
        'peer.test',
        [malformed],
        {} as never,
        {
          sequencePolicy: {
            kind: 'PRESERVE_ORIGIN',
            beforeSeq: 100,
            throughSeq: 40,
          },
        },
      ),
    ).rejects.toThrow('unknown federated message content type');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each(['SYSTEM', 'STICKER'])(
    'uniformly logs and skips unknown content type %s',
    async (contentType) => {
      const service = Object.create(
        FederationService.prototype,
      ) as FederationService & Record<string, unknown>;
      const logger = { error: vi.fn() };
      Object.assign(service, {
        config: { domain: 'local.test' },
        logger,
        assertPeerResponseWritable: vi.fn(),
      });
      const unknown = item('1');
      unknown.contentType = contentType;
      const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

      await expect(
        service.applyMessageQueryItemsInTransaction(
          tx as never,
          'peer.test',
          [unknown],
          {} as never,
        ),
      ).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('unknown federated message content type'),
      );
    },
  );
});
