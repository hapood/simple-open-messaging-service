import { describe, expect, it, vi } from 'vitest';
import {
  FederationService,
  FederationMessageContextError,
} from './federation.service.js';
import type { FederationMessageFeedPage } from './federation-message-feed.service.js';

const item = (
  changeId: string,
): FederationMessageFeedPage['messages'][number] => ({
  changeId,
  thread: {
    type: 'P2P',
    participants: [
      { account: 'alice', domain: 'local.test' },
      { account: 'bob', domain: 'peer.test' },
    ],
  },
  author: { account: 'alice', domain: 'local.test' },
  seq: Number(changeId),
  originSeq: Number(changeId),
  contentType: 'PURE_TEXT',
  content: JSON.stringify({ text: `message ${changeId}` }),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isDeleted: false,
  clientMessageId: null,
  assets: [],
});

describe('federation message context isolation', () => {
  it('records a self-authored feed item as a delivery receipt without inserting a duplicate', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));
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
      query: {
        message: {
          findFirst: vi.fn().mockResolvedValue({
            id: 1n,
            originSeq: null,
            originServerTime: null,
          }),
        },
      },
      update,
    };

    await expect(
      service.applyMissedPageInTransaction(
        tx as never,
        'group-origin.test',
        {
          scannedThrough: '1',
          allocatedThrough: '1',
          hasMore: false,
          messages: [item('1')],
        },
        {} as never,
      ),
    ).resolves.toEqual([]);

    expect(update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({
      originSeq: 1,
      originServerTime: expect.any(Date),
    });
  });

  it('logs and skips a missing relationship while continuing the same page', async () => {
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
      scannedThrough: '2',
      allocatedThrough: '2',
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
    ).resolves.toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('friend/thread is absent'),
    );
  });

  it('still rejects malformed wire data instead of acknowledging it', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    Object.assign(service, {
      config: { domain: 'local.test' },
      logger: { error: vi.fn() },
      assertPeerResponseWritable: vi.fn(),
    });
    const malformed = item('1');
    malformed.originSeq = -1;

    await expect(
      service.applyMissedPageInTransaction(
        {} as never,
        'peer.test',
        {
          scannedThrough: '1',
          allocatedThrough: '1',
          hasMore: false,
          messages: [malformed],
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ bizCode: expect.any(Number) });
  });
});
