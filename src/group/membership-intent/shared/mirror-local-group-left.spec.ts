import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { acquireThreadContentLockInTx } from '../../../common/locks/thread-content-lock.js';
import { writeMirrorLocalGroupLeftInTx } from './mirror-local-group-left.js';

describe('writeMirrorLocalGroupLeftInTx', () => {
  it('writes a complete local profile address in the departure notice', async () => {
    const execute = vi.fn(async (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement);
      if (query.sql.includes('FROM "RelationshipIntent" intent')) {
        return { rows: [{ profileNamespaceId: 0, profileRev: 4 }] };
      }
      return {
        rows: [
          { type: 'GROUP', groupId: 7, account: '!group', id: 7, seq: 12 },
        ],
      };
    });
    const tx = {
      execute,
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue({ defaultProfileRev: 4 }),
        },
        identityNamespace: {
          findFirst: vi.fn().mockResolvedValue({ domain: 'local' }),
        },
      },
    };

    const threadLock = await acquireThreadContentLockInTx(tx as never, 7);
    expect(threadLock).toBeDefined();
    await expect(
      writeMirrorLocalGroupLeftInTx(tx as never, {
        threadId: 7,
        localMemberId: 3,
        memberAccount: 'alice',
        authorityNamespaceId: 7,
        threadLock: threadLock!,
      }),
    ).resolves.toBe(12);

    const query = new PgDialect().sqlToQuery(
      execute.mock.calls.at(-1)![0] as never,
    );
    expect(query.params).toContain(
      JSON.stringify({
        type: 'GROUP_LEFT',
        member: {
          account: 'alice',
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          profileRev: 4,
        },
      }),
    );
    const queries = execute.mock.calls.map(([statement]) =>
      new PgDialect().sqlToQuery(statement),
    );
    const declaration = queries.find((query) =>
      query.sql.includes('FROM "RelationshipIntent" intent'),
    )!;
    expect(declaration.sql).toContain('"RelationshipIntent"');
    expect(declaration.sql).not.toContain('"GroupMetaMemberFeed"');
  });
});
