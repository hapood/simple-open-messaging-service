import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { GroupRole } from '../database/enums.js';
import { FederationThreadMetaRoundExecutorService } from './federation-thread-meta-round-executor.service.js';

describe('federation Group Meta round profile behavior', () => {
  it('schedules only Meta progress, without revision comparison or a profile pull', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            groupAccount: '!group',
            metaEndId: 1,
            metaTargetId: 2,
            metaProcessedThroughId: 1,
            metaRecoveryThroughId: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            groupAccount: '!group',
            metaEndId: 2,
            metaTargetId: 2,
            metaProcessedThroughId: 2,
            metaRecoveryThroughId: null,
          },
        ],
      });
    const round = new FederationThreadMetaRoundExecutorService(
      { db: { execute } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(
      round as unknown as {
        runDeltaPages: (...args: unknown[]) => Promise<boolean>;
      },
      'runDeltaPages',
    ).mockResolvedValue(false);
    expect(await round.run(7, 'origin.example', 9)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [statement] of execute.mock.calls) {
      const query = new PgDialect().sqlToQuery(statement as SQL).sql;
      expect(query).not.toContain('feed."profileRev"');
      expect(query).toContain('"federationRoundsEnabled" = true');
    }
  });

  it('rejects a malformed group-meta member namespace', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          groupAccount: '!group',
          metaEndId: 2,
          metaTargetId: 2,
          metaProcessedThroughId: 1,
          metaRecoveryThroughId: null,
        },
      ],
    });
    const transaction = vi.fn((callback: (tx: unknown) => unknown) =>
      callback({ execute }),
    );
    const fetchPage = vi.fn().mockResolvedValue({
      account: '!group',
      mode: 'delta',
      items: [
        {
          feedId: 2,
          account: 'alice',
          domain: 'local',
          operation: 'MEMBER_UPSERT',
          body: {
            role: GroupRole.MEMBER,
            namespaceId: -1,
            profileRev: 1,
          },
        },
      ],
      scannedThrough: 2,
      groupMetaFeedEndId: 2,
      hasMore: false,
    });
    const client = { fetchPage };
    const profileResolutions = { resolveDemand: vi.fn() };
    const events = { emit: vi.fn() };
    const round = new FederationThreadMetaRoundExecutorService(
      { db: { execute, transaction } } as never,
      client as never,
      {} as never,
      { resolveDemand: vi.fn(), profileDemand: vi.fn() } as never,
      events as never,
    );

    await expect(round.run(7, 'origin.example', 9)).rejects.toThrow(
      'invalid group-meta member body',
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});
