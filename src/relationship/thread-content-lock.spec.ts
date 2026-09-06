import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { requireThreadContentLockInTx } from './thread-content-lock.js';

describe('content parent lock ordering', () => {
  it.each(['GROUP', 'P2P'])(
    'locks %s parents before its thread',
    async (type) => {
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const execute = vi.fn(async (query) => {
        const compiled = new PgDialect().sqlToQuery(query);
        queries.push(compiled);
        if (compiled.sql.includes('LEFT JOIN'))
          return {
            rows: [
              {
                type,
                groupId: type === 'GROUP' ? 8 : null,
                account: '!group',
                domain: 'peer.test',
              },
            ],
          };
        if (compiled.sql.includes('ORDER BY id'))
          return {
            rows: [
              {
                id: '9',
                endpointAAccount: 'z',
                endpointADomain: 'local',
                endpointBAccount: 'a',
                endpointBDomain: 'local',
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
          '["business-scope","ACCOUNT","local","a"]',
          '["business-scope","ACCOUNT","local","z"]',
        ]);
      const parentIndex = queries.findIndex((query) =>
        query.sql.includes(
          type === 'GROUP'
            ? 'SELECT id FROM "Group"'
            : 'SELECT id FROM "RelationshipPair"',
        ),
      );
      const advisoryIndex = queries.findLastIndex((query) =>
        query.sql.includes('pg_advisory_xact_lock'),
      );
      expect(parentIndex).toBeGreaterThan(advisoryIndex);
      expect(parentIndex).toBeLessThan(queries.length - 1);
    },
  );
});
