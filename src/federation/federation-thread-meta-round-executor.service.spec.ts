import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { GroupRole } from '../database/enums.js';
import {
  FederationThreadMetaRoundExecutorService,
  validateOriginGroupMetaItem,
} from './federation-thread-meta-round-executor.service.js';
import type { GroupMetaFeedItem } from '../group/meta/group-meta-page.js';

describe('origin Group Meta copy times', () => {
  const member = {
    account: 'alice',
    namespaceId: 0,
    role: 'MEMBER',
    profileRev: 0,
  };
  it.each([
    ['MEMBER_UPSERT', member],
    ['MEMBER_DEPART', member],
    ['GROUP_PROFILE', { account: '!team', namespaceId: 0, profileRev: 0 }],
    ['GROUP_ANNOUNCEMENT', { text: null }],
  ] as const)('requires both timestamp fields on %s', (operation, body) => {
    const item = {
      feedId: 1,
      createdAt: 0,
      originCreatedAt: null,
      operation,
      body,
    } as GroupMetaFeedItem;
    expect(validateOriginGroupMetaItem(item, 'delta')).toMatchObject({
      createdAt: 0,
      originCreatedAt: null,
    });
    for (const field of ['createdAt', 'originCreatedAt']) {
      const missing: Record<string, unknown> = { ...item };
      delete missing[field];
      expect(() =>
        validateOriginGroupMetaItem(
          missing as unknown as GroupMetaFeedItem,
          'delta',
        ),
      ).toThrow();
    }
    for (const createdAt of [
      undefined,
      null,
      -1,
      0.5,
      '0',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        validateOriginGroupMetaItem(
          { ...item, createdAt } as GroupMetaFeedItem,
          'delta',
        ),
      ).toThrow();
    }
    for (const originCreatedAt of [undefined, 0, '0', false]) {
      expect(() =>
        validateOriginGroupMetaItem(
          { ...item, originCreatedAt } as GroupMetaFeedItem,
          'delta',
        ),
      ).toThrow();
    }
  });
});

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
          createdAt: 0,
          originCreatedAt: null,
          operation: 'MEMBER_UPSERT',
          body: {
            account: 'alice',
            namespaceId: -1,
            role: GroupRole.MEMBER,
            profileRev: 1,
          },
        },
      ],
      scannedThrough: 2,
      groupMetaFeedEndId: 2,
      hasMore: false,
    });
    const client = { fetchPage };
    const _profileResolutions = { resolveDemand: vi.fn() };
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
