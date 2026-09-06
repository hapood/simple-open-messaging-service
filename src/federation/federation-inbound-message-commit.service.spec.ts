import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../relationship/thread-content-lock.js', () => ({
  requireThreadContentLockInTx: vi.fn(
    async (tx, threadId, held) => held ?? { tx, threadId },
  ),
}));
import { ClientThreadContentHeadWriter } from '../message/client-message-feed.service.js';
import { FederationInboundMessageCommitService } from './federation-inbound-message-commit.service.js';

const dialect = new PgDialect();

afterEach(() => vi.restoreAllMocks());

describe('FederationInboundMessageCommitService', () => {
  it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
    'authorizes member deletion type %s before publishing an authority fact',
    async (type) => {
      const service = Object.create(
        FederationInboundMessageCommitService.prototype,
      ) as FederationInboundMessageCommitService;
      const apply = vi.fn().mockResolvedValue({ deletionSeq: 1 });
      Object.assign(service, {
        threadAccess: { assertResourceResponseWritable: vi.fn() },
        routes: {
          resolveTombstone: vi.fn().mockResolvedValue({
            threadId: 11,
            federationVersion: 4,
            recipients: [],
            groupOriginDomain: 'local.test',
            memberSubmission: true,
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
      if (type === 'MODERATION_REMOVAL') {
        await expect(result).rejects.toThrow();
        expect(apply).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toMatchObject({ relayDeletion: true });
        expect(apply).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            sourceNamespaceId: 9,
            messageSeq: 7,
            allowPending: false,
            publishAsAuthority: true,
          }),
        );
      }
    },
  );

  it('matches reverse tombstones by immutable source namespace', async () => {
    const service = Object.create(
      FederationInboundMessageCommitService.prototype,
    ) as FederationInboundMessageCommitService;
    const findTombstone = vi.fn().mockResolvedValue(undefined);
    const tx = {
      query: {
        message: {
          findMany: vi.fn().mockResolvedValue([
            {
              seq: 80,
              originSeq: 70,
              creatorAccount: 'alice',
              creatorDomain: 'peer.test',
              isDeleted: true,
            },
          ]),
        },
        federatedMessageTombstone: { findFirst: findTombstone },
        deletedMessage: {
          findFirst: vi.fn().mockResolvedValue({ deletionSeq: 5 }),
        },
      },
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
    };
    vi.spyOn(
      ClientThreadContentHeadWriter,
      'publishTombstone',
    ).mockResolvedValue(undefined);

    await service.finalizeReverseWindowInTransaction(tx as never, {
      threadId: 9,
      namespaceId: 22,
      beforeSeq: 100,
      throughSeq: 40,
    });

    const query = dialect.sqlToQuery(
      findTombstone.mock.calls[0]![0].where as SQL,
    );
    expect(query.sql).toContain(
      '"FederatedMessageTombstone"."sourceNamespaceId"',
    );
    expect(query.params).toContain(22);
  });
});
