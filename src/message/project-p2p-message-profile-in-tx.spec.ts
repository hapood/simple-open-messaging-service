import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { projectP2PMessageProfileInTx } from './project-p2p-message-profile-in-tx.js';

describe('projectP2PMessageProfileInTx', () => {
  it('projects only fenced exact P2P message profile coordinates', async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ accountId: 3 }] })
        .mockResolvedValueOnce({ rows: [{ id: 3 }] })
        .mockResolvedValueOnce({
          rows: [{ accountId: 3, threadFeedId: 12 }],
        }),
    };

    const changed = await projectP2PMessageProfileInTx(tx as never, {
      threadLock: { tx, threadId: 9 } as never,
      account: 'alice',
      publisherNamespaceId: 7,
      namespaceId: 7,
      messageSeq: 6,
      profileRev: 4,
    });

    expect(changed).toEqual([{ accountId: 3, threadFeedId: 12 }]);
    expect(tx.execute).toHaveBeenCalledTimes(3);
    const dialect = new PgDialect();
    const firstQueryText = dialect.sqlToQuery(
      tx.execute.mock.calls[0]![0] as never,
    ).sql;
    const updateQueryText = dialect.sqlToQuery(
      tx.execute.mock.calls[2]![0] as never,
    ).sql;
    expect(firstQueryText).toContain('pair.active');
    expect(firstQueryText).not.toContain('pair.established');
    expect(updateQueryText).toContain('profile."publisherNamespaceId"');
    expect(updateQueryText).toContain('pair.active');
    expect(updateQueryText).not.toContain('pair.established');
    expect(tx.execute.mock.calls[2]![0]).toHaveProperty('queryChunks');
  });
});
