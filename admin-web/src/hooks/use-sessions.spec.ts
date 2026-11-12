import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateSessionViews } from './use-sessions';

describe('invalidateSessionViews', () => {
  it('invalidates all credential projections without invalidating unrelated admin views', async () => {
    const client = new QueryClient();
    const affected = [
      ['admin', 'sessions', { userId: 42 }],
      ['admin', 'users', 42, 'sessions'],
      ['admin', 'users', 42, 'detail'],
      ['admin', 'users', 13, 'detail'],
      ['admin', 'connections'],
      ['admin', 'dashboard'],
    ];
    const unaffected = [
      ['admin', 'users'],
      ['admin', 'admin-sessions'],
      ['admin', 'users', 42, 'quota'],
    ];
    for (const key of [...affected, ...unaffected])
      client.setQueryData(key, {});
    await invalidateSessionViews(client);
    for (const key of affected)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of unaffected)
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    client.clear();
  });
});
