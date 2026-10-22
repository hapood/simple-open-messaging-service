import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  requireThreadContentLockInTx,
  requireP2PThreadContentLockUnderPairInTx,
} from './thread-content-lock.js';

describe('content parent lock ordering', () => {
  it('rejects a child thread outside the held P2P pair without issuing parent locks', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await expect(
      requireP2PThreadContentLockUnderPairInTx({ execute } as never, 9n, 7),
    ).rejects.toThrow('does not belong to the locked pair');
    expect(execute).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('FOR NO KEY UPDATE OF thread');
    expect(query.params).toEqual([7, 9n]);
  });

  it.each(['GROUP', 'P2P'])(
    'locks %s parents before its thread',
    async (type) => {
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const execute = vi.fn(async (query) => {
        const compiled = new PgDialect().sqlToQuery(query);
        queries.push(compiled);
        if (compiled.sql.includes('SELECT thread.type'))
          return {
            rows: [
              {
                type,
                groupId: type === 'GROUP' ? 8 : null,
                account: '!group',
                namespaceId: 5,
              },
            ],
          };
        if (compiled.sql.includes('FROM "RelationshipPair"'))
          return {
            rows: [
              {
                id: '9',
                endpointAAccount: 'z',
                endpointANamespaceId: 0,
                endpointBAccount: 'a',
                endpointBNamespaceId: 0,
              },
            ],
          };
        return { rows: [{ id: 7 }] };
      });
      const tx = { execute } as never;
      const held = await requireThreadContentLockInTx(tx, 7);
      const count = queries.length;
      expect(await requireThreadContentLockInTx(tx, 7, held)).toBe(held);
      expect(queries).toHaveLength(count);
      await expect(requireThreadContentLockInTx(tx, 8, held)).rejects.toThrow(
        'another transaction or thread',
      );
      await expect(
        requireThreadContentLockInTx({ execute } as never, 7, held),
      ).rejects.toThrow('another transaction or thread');
      expect(queries).toHaveLength(count);
      expect(queries.at(-1)?.sql).toContain('FROM "MessageThread"');
      const advisory = queries.filter((query) =>
        query.sql.includes('pg_advisory_xact_lock'),
      );
      expect(advisory).toHaveLength(type === 'GROUP' ? 1 : 2);
      if (type === 'P2P')
        expect(advisory.map((query) => query.params[0])).toEqual([
          '["business-scope","ACCOUNT",0,"a"]',
          '["business-scope","ACCOUNT",0,"z"]',
        ]);
      const advisoryIndex = queries.findLastIndex((query) =>
        query.sql.includes('pg_advisory_xact_lock'),
      );
      const rowLocks = queries.filter((query) =>
        query.sql.includes('FOR NO KEY UPDATE'),
      );
      expect(rowLocks).toHaveLength(type === 'GROUP' ? 1 : 2);
      expect(queries.indexOf(rowLocks[0])).toBeGreaterThan(advisoryIndex);
      if (type === 'P2P') expect(rowLocks[0].sql).toContain('RelationshipPair');
    },
  );
});
