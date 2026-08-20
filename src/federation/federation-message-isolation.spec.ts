import { describe, expect, it, vi } from 'vitest';
import {
  FederationService,
  FederationMessageContextError,
} from './federation.service.js';
import type { FederationMessageFeedPage } from './federation-message-feed.service.js';

const item = (
  sequence: string,
): FederationMessageFeedPage['messages'][number] => ({
  thread: {
    type: 'P2P',
    participants: [
      { account: 'alice', domain: 'local.test' },
      { account: 'bob', domain: 'peer.test' },
    ],
  },
  author: { account: 'alice', domain: 'local.test' },
  seq: Number(sequence),
  originSeq: Number(sequence),
  contentType: 'PURE_TEXT',
  content: JSON.stringify({ text: `message ${sequence}` }),
  createdAt: 1_700_000_001_000,
  originCreatedAt: 1_700_000_000_000,
  clientMessageId: null,
  assets: [],
});

describe('federation message context isolation', () => {
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
      service.applyMissedPageInTransaction(
        tx as never,
        'group-origin.test',
        {
          items: [],
          scannedThrough: '1',
          messageFeedEndId: '1',
          hasMore: false,
          messages: [item('1')],
        },
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
    const page: FederationMessageFeedPage = {
      items: [],
      scannedThrough: '2',
      messageFeedEndId: '2',
      hasMore: false,
      messages: [item('1'), item('2')],
    };

    await expect(
      service.applyMissedPageInTransaction(
        tx as never,
        'peer.test',
        page,
        {} as never,
      ),
    ).rejects.toThrow('friend/thread is absent');
    expect(resolve).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
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
    malformed.author.account = 'attacker\nforged-log-line';
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

    await expect(
      service.applyMissedPageInTransaction(
        tx as never,
        'peer.test',
        {
          items: [],
          scannedThrough: '1',
          messageFeedEndId: '1',
          hasMore: false,
          messages: [malformed],
        },
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
        service.applyMissedPageInTransaction(
          tx as never,
          'peer.test',
          {
            items: [],
            scannedThrough: '1',
            messageFeedEndId: '1',
            hasMore: false,
            messages: [unknown],
          },
          {} as never,
        ),
      ).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('unknown federated message content type'),
      );
    },
  );
});
