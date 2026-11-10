import { describe, expect, it } from 'vitest';
import { syncPushState } from './push-state-sync';
import type { AccountState } from '../../../../shared/account-state';

describe('personal request notification deltas', () => {
  it('marks partial read convergence existing-only and only alerts a new arrival', async () => {
    let state = {
      stateFeedId: 1,
      stateFeedFullThrough: null,
      intentRequestEndId: '100',
      intentRequestReadId: '0',
      intentRequestOptimisticReadId: null,
    } as AccountState;
    const storage = {
      readAccountState: async () => ({ ...state }),
      applyStateFeedPage: async (_items: unknown[], cursor: number) => {
        state = {
          ...state,
          stateFeedId: cursor,
          intentRequestReadId: '50',
          ...(cursor === 3 ? { intentRequestEndId: '101' } : {}),
        };
      },
    };
    const request = async (query: { through: number }) => ({
      code: 0,
      data: {
        mode: 'delta' as const,
        items: [],
        scannedThrough: query.through,
        stateFeedEndId: query.through,
        hasMore: false,
      },
    });
    const preferences = {
      get: async <T>(): Promise<T | undefined> => undefined,
    };
    const read = await syncPushState(storage, 2, request, preferences, 'en');
    expect(read.notifications[0]).toMatchObject({
      count: 1,
      silent: true,
      updateExistingOnly: true,
    });
    const arrival = await syncPushState(storage, 3, request, preferences, 'en');
    expect(arrival.notifications[0]).toMatchObject({
      count: 1,
      silent: false,
      updateExistingOnly: false,
    });
  });
});
