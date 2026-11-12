import { describe, expect, it, vi } from 'vitest';
import { GroupDisbandMembershipRevocationService } from './group-disband-membership-revocation.service.js';
import { captureGroupDepartureUpdatesInTx } from '../shared/capture-group-departure-updates.js';

vi.mock('../shared/capture-group-departure-updates.js', () => ({
  captureGroupDepartureUpdatesInTx: vi.fn().mockResolvedValue([
    {
      kind: 'group-request-read',
      userId: 2,
      feedId: 90,
      threadFeedEndId: 7,
    },
  ]),
}));
vi.mock('./group-disband-membership-revocation-sql.js', () => ({
  groupDisbandMembershipRevocationIntentWrites: () => [],
  groupDisbandMembershipRevocationSql: () => ({}),
}));

describe('disband member request convergence', () => {
  it.each([false, true])(
    'publishes departed manager convergence after commit only (rollback=%s)',
    async (rollback) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({
          rows: [{ pairChanged: true, audienceChanged: true }],
        }),
      };
      let committed = false;
      const notifyFeedUpdates = vi.fn(() => {
        expect(committed).toBe(true);
      });
      const service = new GroupDisbandMembershipRevocationService({
        database: {
          db: {
            transaction: async (run: (tx: unknown) => Promise<unknown>) => {
              const result = await run(tx);
              if (rollback) throw new Error('rollback');
              committed = true;
              return result;
            },
          },
        },
        clientFeed: { notifyFeedUpdates },
      } as never);
      vi.spyOn(service as any, 'lockAndValidateInTx').mockResolvedValue({
        tx,
        localMemberId: 2,
        input: { threadId: 10, profileNamespaceId: 0 },
      });
      const result = service.execute({ threadId: 10, memberAddress: 2 });
      if (rollback) {
        await expect(result).rejects.toThrow('rollback');
        expect(notifyFeedUpdates).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toEqual({
          status: 'APPLIED',
          transitioned: true,
        });
        expect(captureGroupDepartureUpdatesInTx).toHaveBeenCalledWith(
          tx,
          10,
          2,
        );
        expect(notifyFeedUpdates).toHaveBeenCalledWith([
          expect.objectContaining({
            kind: 'group-request-read',
            threadFeedEndId: 7,
          }),
        ]);
      }
    },
  );
});
