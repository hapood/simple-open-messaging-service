import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../common/locks/thread-content-lock.js', () => ({
  requireThreadContentLockInTx: vi.fn(
    async (tx, threadId, held) => held ?? { tx, threadId },
  ),
}));
import { FederationInboundMessageCommitService } from './federation-inbound-message-commit.service.js';
import { enqueueMessageFanoutsInTx } from '../message/thread-fanout-task.js';
vi.mock('../message/thread-fanout-task.js', () => ({
  enqueueMessageFanoutsInTx: vi.fn(),
}));

const dialect = new PgDialect();

afterEach(() => vi.restoreAllMocks());

describe('FederationInboundMessageCommitService', () => {
  it.each([true, false])(
    'fans out only a page advancing the visible tail (tail=%s)',
    async (tail) => {
      vi.mocked(enqueueMessageFanoutsInTx).mockClear();
      const writtenSeq = tail ? 99 : 40;
      const tx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ seq: tail ? 40 : 99 }] })
          .mockResolvedValueOnce({ rows: [{ seq: writtenSeq }] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ seq: 99, tombstoneEndSeq: 7 }] }),
      };
      const service = new FederationInboundMessageCommitService(
        {} as never,
        {
          applyPrepared: vi.fn().mockResolvedValue([
            {
              kind: 'message',
              historical: true,
              threadId: 31,
              originSeq: 70,
              recipients: [],
              toAccount: 'alice',
              author: { account: 'bob', namespaceId: 22 },
              message: { seq: writtenSeq, localState: 'STUB' },
            },
          ]),
        } as never,
        {} as never,
        {} as never,
      );
      const effects = await service.commitMessagePageInTx(tx as never, {
        threadLock: { threadId: 31 } as never,
        processedInterval: { left: 69, right: 70 },
        peerToken: { namespaceId: 22 } as never,
        messages: [{ item: { seq: 70 } }] as never,
      });
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        kind: 'message',
        message: { seq: writtenSeq, localState: 'READY' },
      });
      expect(enqueueMessageFanoutsInTx).toHaveBeenCalledTimes(tail ? 1 : 0);
      if (tail)
        expect(enqueueMessageFanoutsInTx).toHaveBeenCalledWith(
          tx,
          expect.anything(),
          {
            threadId: 31,
            messageEndSeq: 99,
            tombstoneEndSeq: 7,
          },
        );
    },
  );
  it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
    'authorizes member deletion type %s before publishing an authority fact',
    async (type) => {
      const service = Object.create(
        FederationInboundMessageCommitService.prototype,
      ) as FederationInboundMessageCommitService;
      const apply = vi
        .fn()
        .mockResolvedValue({ messageSeq: 7, deletionSeq: 1 });
      Object.assign(service, {
        threadAccess: { assertResourceResponseWritable: vi.fn() },
        routes: {
          resolveTombstone: vi.fn().mockResolvedValue({
            threadId: 11,
            recipients: [],
            authority: 'GROUP_MEMBER',
          }),
        },
        deletedMessages: { applyFederatedInTx: apply },
      });
      const result = service.applyTombstonesInTransaction(
        {} as never,
        {
          response: {
            threadId: 11,
            peerDomain: 'peer.test',
            peerToken: { namespaceId: 9 },
            data: {
              tombstones: [
                {
                  thread: { account: '!group' },
                  deletionSeq: 1,
                  messageSeq: 7,
                  deletedAt: 123,
                  type,
                },
              ],
            },
          },
          frozenTargetSeq: 1,
        } as never,
      );
      await expect(result).resolves.toMatchObject({
        deletions: [{ messageSeq: 7, deletionSeq: 1 }],
      });
      expect(apply).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          publisherNamespaceId: 9,
          messageSeq: 7,
          type,
          authority: 'GROUP_MEMBER',
        }),
      );
    },
  );

  it('finalizes materialization within the immutable publisher namespace', async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ seq: 0 }] })
        .mockResolvedValueOnce({ rows: [{ seq: 40 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ seq: 40, tombstoneEndSeq: 0 }] }),
    };
    const service = new FederationInboundMessageCommitService(
      {} as never,
      {
        applyPrepared: vi.fn().mockResolvedValue([
          {
            kind: 'message',
            historical: true,
            threadId: 9,
            originSeq: 40,
            recipients: [],
            toAccount: 'alice',
            author: { account: 'bob', namespaceId: 22 },
            message: { seq: 40, localState: 'STUB' },
          },
        ]),
      } as never,
      {} as never,
      {} as never,
    );

    await service.commitMessagePageInTx(tx as never, {
      threadLock: { threadId: 9 } as never,
      processedInterval: { left: 39, right: 40 },
      peerToken: { namespaceId: 22 } as never,
      messages: [{ item: { seq: 40 } }] as never,
    });

    const query = dialect.sqlToQuery(tx.execute.mock.calls[1]![0] as SQL);
    expect(query.sql).toContain('staged."publisherNamespaceId"');
    expect(query.params).toContain(22);
  });
});
