import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { resolveAuthorizedFederationThreadInTx } from './federation-thread-query-authorization.js';

const dialect = new PgDialect();

function transactionWith(
  rows: Array<{
    threadId: number;
    messageAccessAfterSeq: number;
    groupQueryDirection: 'ORIGIN_DISTRIBUTION' | 'MIRROR_TO_ORIGIN' | null;
  }>,
) {
  const execute = vi.fn(async () => ({ rows }));
  return {
    tx: { execute } as unknown as DatabaseTransaction,
    execute,
  };
}

function executedQuery(execute: ReturnType<typeof vi.fn>) {
  const query = execute.mock.calls[0]![0] as SQL;
  return dialect.sqlToQuery(query);
}

describe('resolveAuthorizedFederationThreadInTx', () => {
  it('authorizes an effective publisher-authored P2P intent only on an active pair', async () => {
    const { tx, execute } = transactionWith([
      {
        threadId: 7,
        messageAccessAfterSeq: 3,
        groupQueryDirection: null,
      },
    ]);

    await expect(
      resolveAuthorizedFederationThreadInTx(tx, 9, {
        type: 'P2P',
        account: 'alice',
        peerAccount: 'bob',
      }),
    ).resolves.toEqual({
      threadId: 7,
      messageAccessAfterSeq: 3,
      groupQueryDirection: null,
      address: { account: 'alice', peerAccount: 'bob' },
    });

    const executed = executedQuery(execute);
    const query = executed.sql;
    expect(query).toContain('FROM "RelationshipPair" pair');
    expect(query).toContain('JOIN "RelationshipIntent" intent');
    // The selector's local account must pin the pair's local endpoint. Without
    // this predicate any active local pair with the same remote endpoint could
    // satisfy LIMIT 1 and resolve the query to another user's thread.
    expect(query).toContain('pair."endpointAAccount" = $');
    expect(executed.params).toContain('alice');
    expect(query).toContain("intent.status = 'REQUESTED'");
    expect(query).toContain('intent."expiresAt" > CURRENT_TIMESTAMP');
    expect(query).toContain('pair.active = true');
    expect(query).not.toContain('pair.established = true');
    expect(query).not.toContain('FOR SHARE');
    expect(query).not.toContain('ThreadMember');
    expect(executed.params).not.toContain(0);
  });

  it('authorizes GROUP through a group-authored intent toward a member on the signed peer', async () => {
    const { tx, execute } = transactionWith([
      {
        threadId: 11,
        messageAccessAfterSeq: 0,
        groupQueryDirection: 'ORIGIN_DISTRIBUTION',
      },
    ]);

    await expect(
      resolveAuthorizedFederationThreadInTx(tx, 9, {
        type: 'GROUP',
        account: '!group',
      }),
    ).resolves.toEqual({
      threadId: 11,
      messageAccessAfterSeq: 0,
      groupQueryDirection: 'ORIGIN_DISTRIBUTION',
      address: { account: '!group' },
    });

    const executed = executedQuery(execute);
    const query = executed.sql;
    expect(query).toContain('JOIN "RelationshipPair" pair');
    expect(query).toContain('JOIN "RelationshipIntent" intent');
    expect(query).toContain("pair.kind = 'GROUP_MEMBER'");
    expect(query).toContain("'ORIGIN_DISTRIBUTION' AS");
    expect(query).toContain('LEFT JOIN "ThreadAudience" audience');
    expect(query).not.toContain('pair.active = true');
    expect(query).toContain('pair."endpointANamespaceId" = 0');
    expect(query).toContain('pair."endpointBNamespaceId" = $');
    expect(query).toContain('group_state."namespaceId" = 0');
    expect(query).not.toContain('FOR SHARE');
    expect(executed.params).toContain(9);
  });

  it('authorizes the member-home feed through a local member projection and member-authored intent', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            threadId: 11,
            messageAccessAfterSeq: 0,
            groupQueryDirection: 'MIRROR_TO_ORIGIN',
          },
        ],
      });
    const tx = { execute } as unknown as DatabaseTransaction;

    await expect(
      resolveAuthorizedFederationThreadInTx(tx, 9, {
        type: 'GROUP',
        account: '!group',
      }),
    ).resolves.toEqual({
      threadId: 11,
      messageAccessAfterSeq: 0,
      groupQueryDirection: 'MIRROR_TO_ORIGIN',
      address: { account: '!group' },
    });

    const mirrorQuery = dialect.sqlToQuery(
      execute.mock.calls[1]![0] as SQL,
    ).sql;
    expect(mirrorQuery).toContain("'MIRROR_TO_ORIGIN' AS");
    expect(mirrorQuery).not.toContain('group_state.domain =');
    expect(mirrorQuery).toContain('group_state."namespaceId" =');
    expect(mirrorQuery).toContain('JOIN "AccountThreadState" local_state');
    expect(mirrorQuery).toContain('JOIN "RelationshipIntent" intent');
    expect(mirrorQuery).not.toContain('pair.active = true');
    expect(mirrorQuery).not.toContain('FOR SHARE');
    expect(mirrorQuery).not.toContain('ThreadAudience');
  });

  it('returns FORBIDDEN when the locked authorization fact is absent', async () => {
    const { tx } = transactionWith([]);
    await expect(
      resolveAuthorizedFederationThreadInTx(tx, 9, {
        type: 'P2P',
        account: 'alice',
        peerAccount: 'bob',
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN, status: 200 });
  });
});
