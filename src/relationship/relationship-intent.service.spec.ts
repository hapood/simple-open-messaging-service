import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { RelationshipIntentService } from './relationship-intent.service.js';

function transaction(pairChanged: boolean) {
  const queries: string[] = [];
  const forUpdate = vi.fn().mockResolvedValue([]);
  const execute = vi.fn(async (statement) => {
    const { sql } = new PgDialect().sqlToQuery(statement);
    queries.push(sql);
    if (sql.includes('SELECT group_profile.account'))
      return {
        rows: [
          {
            groupAccount: '!group',
            groupDomain: 'peer.test',
            groupNamespaceId: 9,
            memberAccount: 'alice',
            memberDomain: 'local',
            profileNamespaceId: 0,
          },
        ],
      };
    if (sql.includes('SELECT id FROM "MessageThread"'))
      return { rows: [{ id: 31 }] };
    if (
      sql.includes('FROM "RelationshipPair"') &&
      sql.includes('FOR NO KEY UPDATE')
    )
      return { rows: [{ id: 9n, active: !pairChanged, threadId: 31 }] };
    if (sql.includes('UPDATE "RelationshipPair"'))
      return { rowCount: pairChanged ? 1 : 0, rows: [] };
    return { rows: [] };
  });
  return {
    tx: {
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ for: forUpdate }) }),
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: async () => undefined }),
      }),
      execute,
    },
    queries,
    forUpdate,
  };
}

describe('RelationshipIntentService remote-group authorization epoch', () => {
  it.each([
    { changed: true, active: true },
    { changed: false, active: true },
    { changed: true, active: false },
  ])(
    'serializes group activation=$active changed=$changed without locking a removed Group row',
    async ({ changed, active }) => {
      const { tx, queries, forUpdate } = transaction(changed);
      await expect(
        new RelationshipIntentService().setGroupPairActiveInTx(tx as never, {
          groupId: 31,
          threadId: 31,
          memberUserId: { account: 'alice', domain: 'local', namespaceId: 0 },
          active,
        }),
      ).resolves.toEqual({
        changed,
        threadLock: expect.objectContaining({ threadId: 31 }),
      });
      expect(forUpdate).toHaveBeenCalledWith('no key update');
      expect(
        queries.filter((query) => query.includes('pg_advisory_xact_lock')),
      ).toHaveLength(1);
      expect(
        queries.filter((query) =>
          query.includes('SELECT id FROM "MessageThread"'),
        ),
      ).toHaveLength(1);
      expect(
        queries.some((query) =>
          query.includes('FOR NO KEY UPDATE OF group_profile'),
        ),
      ).toBe(false);
      expect(
        queries.some((query) => query.includes('UPDATE "MessageThread"')),
      ).toBe(changed);
      expect(
        queries.some((query) => query.includes('"authorizationEpoch" + 1')),
      ).toBe(changed && !active);
      expect(
        queries.some((query) =>
          query.includes('"federationRoundsEnabled" = true'),
        ),
      ).toBe(changed && active);
      expect(
        queries.some((query) =>
          query.includes('"federationRoundsEnabled" = false'),
        ),
      ).toBe(changed && !active);
    },
  );
});
