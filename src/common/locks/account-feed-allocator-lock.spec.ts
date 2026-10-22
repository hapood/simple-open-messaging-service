import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { lockAccountFeedAllocatorsInTx } from './account-feed-allocator-lock.js';

describe('account feed allocator locking', () => {
  it('deduplicates and locks account allocators in canonical ID order', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await lockAccountFeedAllocatorsInTx({ execute } as never, [9, 3, 9, 5]);

    expect(execute).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('ORDER BY id');
    expect(query.sql).toContain('FOR NO KEY UPDATE');
    expect(query.params).toEqual([[3, 5, 9]]);
  });

  it('does not query for an empty allocator set', async () => {
    const execute = vi.fn();
    await lockAccountFeedAllocatorsInTx({ execute } as never, []);
    expect(execute).not.toHaveBeenCalled();
  });
});
