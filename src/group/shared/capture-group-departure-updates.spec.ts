import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { captureGroupDepartureUpdatesInTx } from './capture-group-departure-updates.js';

vi.mock(
  '../../client-state-feed/capture-thread-state-updates.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../client-state-feed/capture-thread-state-updates.js')
    >()),
    captureThreadStateUpdatesInTx: vi
      .fn()
      .mockImplementation(async (_tx, _ids, kind = 'thread-feed') => [
        { kind, userId: 2, feedId: 90, threadFeedEndId: 7 },
      ]),
  }),
);

describe('captureGroupDepartureUpdatesInTx', () => {
  it.each([false, true])(
    'marks only former manager departures for convergence (manager=%s)',
    async (manager) => {
      const where = vi.fn(
        (_predicate: import('drizzle-orm').SQL | undefined) => ({
          limit: () => Promise.resolve(manager ? [{ id: 3 }] : []),
        }),
      );
      const tx = { select: () => ({ from: () => ({ where }) }) };
      const updates = await captureGroupDepartureUpdatesInTx(
        tx as never,
        10,
        2,
      );
      expect(updates).toEqual([
        manager
          ? {
              kind: 'group-request-read',
              userId: 2,
              feedId: 90,
              threadFeedEndId: 7,
            }
          : {
              kind: 'thread-feed',
              userId: 2,
              feedId: 90,
              threadFeedEndId: 7,
            },
      ]);
      const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]!);
      expect(query.sql).toContain('"role" in');
      expect(query.params).toEqual([10, 2, 'OWNER', 'ADMIN']);
      expect(query.sql).not.toContain('unreadCount');
      expect(query.sql).not.toContain('messageVisibleThroughSeq');
    },
  );
});
