import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import type {
  FederationThreadForwardMessageRoundDriver,
  FederationThreadForwardTombstoneRoundDriver,
} from './federation-thread-forward-round.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

afterEach(() => vi.restoreAllMocks());

function response(data: object) {
  return {
    data,
    threadId: 31,
    peerDomain: 'origin.test',
    federationVersion: 2,
    peerToken: {
      domain: 'origin.test',
      namespaceId: 1,
      rootKeyFingerprint: 'fingerprint',
    },
  };
}

function harness(localGroupAuthority = false) {
  const publishMessage = vi.fn().mockResolvedValue(undefined);
  const publishTombstone = vi.fn().mockResolvedValue(undefined);
  const federation = {
    applyForwardMessagePageInTransaction: vi.fn().mockResolvedValue({
      publish: publishMessage,
    }),
    applyForwardTombstonePageInTransaction: vi.fn().mockResolvedValue({
      publish: publishTombstone,
    }),
  };
  const threadResources = { fetch: vi.fn() };
  const rounds = {
    runMessages: vi.fn(
      async (
        threadId: number,
        peerDomain: string,
        _namespaceId: number,
        driver: FederationThreadForwardMessageRoundDriver,
        take: number,
      ) => {
        await driver.process({
          threadId,
          peerDomain,
          after: 10,
          through: 100,
          take,
        });
        await driver.complete({
          threadId,
          peerDomain,
          authorizationEpoch: 4,
          targetSeq: 100,
        });
        return { targetSeq: 100, processed: true };
      },
    ),
    runTombstones: vi.fn(
      async (
        threadId: number,
        peerDomain: string,
        _namespaceId: number,
        driver: FederationThreadForwardTombstoneRoundDriver,
        take: number,
      ) => {
        const targetSeq = 9;
        const maxMessageSeq = 42;
        await driver.process({
          threadId,
          peerDomain,
          after: 4,
          through: targetSeq,
          maxMessageSeq,
          take,
        });
        await driver.complete({
          threadId,
          peerDomain,
          authorizationEpoch: 4,
          targetSeq,
        });
        // maxMessageSeq is optional in the real round result; the fake keeps
        // the optional form so the "omits maxMessageSeq" test can drop it.
        return { targetSeq, maxMessageSeq, processed: true } as {
          targetSeq: number;
          maxMessageSeq?: number;
          processed: boolean;
        };
      },
    ),
  };
  const tx = { execute: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
  const database = {
    db: {
      transaction: vi.fn((callback: (tx: object) => Promise<void>) =>
        callback(tx),
      ),
    },
  };
  const messageAdvance = vi
    .spyOn(
      FederationThreadSyncStateService,
      'advanceMessageProcessedThroughInTx',
    )
    .mockResolvedValue(undefined);
  const deletionAdvance = vi
    .spyOn(
      FederationThreadSyncStateService,
      'advanceDeletionProcessedThroughInTx',
    )
    .mockResolvedValue(undefined);
  const epochLock = vi
    .spyOn(FederationThreadSyncStateService, 'lockAuthorizationEpochInTx')
    .mockResolvedValue({ threadId: 31, tx } as never);
  const executor = new FederationThreadForwardRoundExecutorService(
    rounds as never,
    threadResources as never,
    federation as never,
    {
      resolve: vi.fn().mockResolvedValue({
        kind: 'GROUP',
        localGroupAuthority,
        threadId: 31,
        namespaceId: 7,
        peerDomain: 'origin.test',
        selector: { account: '!group' },
      }),
    } as never,
    database as never,
  );
  return {
    executor,
    rounds,
    federation,
    threadResources,
    database,
    publishMessage,
    publishTombstone,
    messageAdvance,
    deletionAdvance,
    epochLock,
    tx,
  };
}

describe('FederationThreadForwardRoundExecutorService', () => {
  it.each(['message', 'tombstone'] as const)(
    'rejects a buffered %s page without writing facts or progress after audience removal',
    async (kind) => {
      const h = harness(true);
      h.tx.execute.mockResolvedValue({ rows: [] });
      h.threadResources.fetch.mockResolvedValueOnce(
        response(
          kind === 'message'
            ? { messages: [], scannedThrough: 100, hasMore: false }
            : { tombstones: [], scannedThrough: 9, hasMore: false },
        ),
      );
      const run =
        kind === 'message'
          ? h.executor.runMessages(31, 'origin.test', 7, 50)
          : h.executor.runTombstones(31, 'origin.test', 7, 50);
      await expect(run).rejects.toThrow('no longer has an audience');
      expect(h.epochLock.mock.invocationCallOrder[0]).toBeLessThan(
        h.tx.execute.mock.invocationCallOrder[0],
      );
      expect(
        h.federation.applyForwardMessagePageInTransaction,
      ).not.toHaveBeenCalled();
      expect(
        h.federation.applyForwardTombstonePageInTransaction,
      ).not.toHaveBeenCalled();
      expect(h.messageAdvance).not.toHaveBeenCalled();
      expect(h.deletionAdvance).not.toHaveBeenCalled();
      expect(h.publishMessage).not.toHaveBeenCalled();
      expect(h.publishTombstone).not.toHaveBeenCalled();
    },
  );
  it('skips an unexpected mirror author before closure fetch and still commits the following message and cursor', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const h = harness(true);
    const bad = {
      thread: { account: '!group' },
      seq: 11,
      author: { account: 'third', domain: 'third.test' },
      contentType: 'FORWARD',
      content: 'invalid closure',
    };
    const good = {
      thread: { account: '!group' },
      seq: 12,
      author: { account: 'member', domain: 'origin.test' },
      contentType: 'GALLERY',
    };
    h.threadResources.fetch.mockResolvedValueOnce(
      response({ messages: [bad, good], scannedThrough: 100, hasMore: false }),
    );
    await h.executor.runMessages(31, 'origin.test', 7, 50);
    expect(h.threadResources.fetch).toHaveBeenCalledTimes(1);
    expect(
      h.federation.applyForwardMessagePageInTransaction,
    ).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        threadLock: await h.epochLock.mock.results[0].value,
        response: expect.objectContaining({
          data: expect.objectContaining({ messages: [good] }),
        }),
      }),
    );
    expect(h.messageAdvance).toHaveBeenCalledWith(h.tx, 31, 100, 100, 7);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('FEDERATION_MALFORMED'),
    );
  });
  it('includes mirror receipts alongside submissions when the local group is authoritative', async () => {
    const h = harness(true);
    h.threadResources.fetch.mockResolvedValueOnce(
      response({ messages: [], scannedThrough: 100, hasMore: false }),
    );
    await h.executor.runMessages(31, 'origin.test', 7, 50);
    expect(h.threadResources.fetch).toHaveBeenCalledWith(
      31,
      '/s2s/v1/messages?account=%21group&after=10&through=100&take=50&includeSelf=true',
      'origin.test',
      16 * 1024 * 1024,
    );
    expect(h.messageAdvance).toHaveBeenCalledWith(h.tx, 31, 100, 100, 7);
  });
  it('commits a message page and its cursor independently', async () => {
    const h = harness();
    h.threadResources.fetch.mockResolvedValueOnce(
      response({ messages: [], scannedThrough: 60, hasMore: true }),
    );

    await h.executor.runMessages(31, 'origin.test', 7, 50);

    expect(h.threadResources.fetch).toHaveBeenCalledWith(
      31,
      '/s2s/v1/messages?account=%21group&after=10&through=100&take=50&includeSelf=true',
      'origin.test',
      16 * 1024 * 1024,
    );
    expect(h.messageAdvance).toHaveBeenCalledWith(h.tx, 31, 60, 100, 7);
    expect(h.deletionAdvance).not.toHaveBeenCalled();
    expect(h.epochLock).toHaveBeenCalledWith(h.tx, 31, 4);
    expect(h.publishMessage).toHaveBeenCalledOnce();
    expect(h.publishTombstone).not.toHaveBeenCalled();
  });

  it('commits an independently bounded tombstone page with its frozen cutoff', async () => {
    const h = harness();
    h.threadResources.fetch.mockResolvedValueOnce(
      response({ tombstones: [], scannedThrough: 9, hasMore: false }),
    );

    await h.executor.runTombstones(31, 'origin.test', 7, 50);

    expect(h.threadResources.fetch).toHaveBeenCalledWith(
      31,
      '/s2s/v1/message-tombstones?account=%21group&after=4&through=9&take=50&includeSelf=true&maxMessageSeq=42',
      'origin.test',
      4 * 1024 * 1024,
    );
    expect(h.deletionAdvance).toHaveBeenCalledWith(h.tx, 31, 9, 9, 7);
    expect(h.messageAdvance).not.toHaveBeenCalled();
    expect(h.epochLock).toHaveBeenCalledWith(h.tx, 31, 4);
    expect(h.publishTombstone).toHaveBeenCalledOnce();
    expect(h.publishMessage).not.toHaveBeenCalled();
  });

  it('omits maxMessageSeq after the recovery drain is complete', async () => {
    const h = harness();
    h.rounds.runTombstones.mockImplementationOnce(
      // The real 5th parameter is optional (requestedTake?) — a mock that
      // requires it would not be assignable under strictFunctionTypes.
      async (
        threadId: number,
        peerDomain: string,
        _namespaceId: number,
        driver: FederationThreadForwardTombstoneRoundDriver,
        take?: number,
      ) => {
        await driver.process({
          threadId,
          peerDomain,
          after: 9,
          through: 12,
          take: take!,
        });
        return { targetSeq: 12, processed: true };
      },
    );
    h.threadResources.fetch.mockResolvedValueOnce(
      response({ tombstones: [], scannedThrough: 12, hasMore: false }),
    );

    await h.executor.runTombstones(31, 'origin.test', 7, 50);

    expect(h.threadResources.fetch).toHaveBeenCalledWith(
      31,
      '/s2s/v1/message-tombstones?account=%21group&after=9&through=12&take=50&includeSelf=true',
      'origin.test',
      4 * 1024 * 1024,
    );
  });

  it('rejects a tombstone above the frozen recovery cutoff', async () => {
    const h = harness();
    h.threadResources.fetch.mockResolvedValueOnce(
      response({
        tombstones: [
          {
            deletionSeq: 5,
            thread: { account: '!group' },
            messageSeq: 43,
            type: 'USER_RETRACTION',
            deletedAt: 1,
          },
        ],
        scannedThrough: 9,
        hasMore: false,
      }),
    );

    await expect(
      h.executor.runTombstones(31, 'origin.test', 7, 50),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    expect(h.deletionAdvance).not.toHaveBeenCalled();
  });
});
