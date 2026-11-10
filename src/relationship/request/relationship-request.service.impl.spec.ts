import { describe, expect, it, vi } from 'vitest';
import { RelationshipRequestServiceImpl } from './relationship-request.service.impl.js';

describe('RelationshipRequestServiceImpl.markRead', () => {
  it.each([false, true])(
    'publishes state-feed read convergence only after commit (rollback=%s)',
    async (rollback) => {
      let committed = false;
      const notifyFeedUpdates = vi.fn(() => expect(committed).toBe(true));
      const service = new RelationshipRequestServiceImpl(
        {
          db: {
            transaction: async (run: (tx: unknown) => Promise<unknown>) => {
              const result = await run({});
              if (rollback) throw new Error('rollback');
              committed = true;
              return result;
            },
          },
        } as never,
        {
          markIncomingRequestsReadInTx: vi.fn().mockResolvedValue({
            status: 'CHANGED',
            head: {
              requestEndId: 9007199254740993n,
              requestReadId: 9007199254740993n,
            },
            effects: {
              clientUpdates: [
                {
                  userId: 1,
                  feedId: 17,
                  kind: 'personal-request-read' as const,
                },
              ],
            },
          }),
        } as never,
        { notifyFeedUpdates } as never,
      );
      const result = service.markRead(1, '9007199254740993');
      if (rollback) {
        await expect(result).rejects.toThrow('rollback');
        expect(notifyFeedUpdates).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toEqual({
          requestEndId: '9007199254740993',
          requestReadId: '9007199254740993',
        });
        expect(notifyFeedUpdates).toHaveBeenCalledExactlyOnceWith([
          { userId: 1, feedId: 17, kind: 'personal-request-read' },
        ]);
      }
    },
  );
});
