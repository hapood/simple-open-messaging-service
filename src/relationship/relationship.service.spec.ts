import {
  applyFederatedPendingProfileSnapshot,
  RelationshipService,
} from './relationship.service.js';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { messageThread, accountThreadState } from '../database/schema.js';

describe('applyFederatedPendingProfileSnapshot', () => {
  const profile = {
    name: '!remote-group',
    avatar: 'stored-avatar',
  };

  it('applies the same pending-card snapshot fields for users and groups', () => {
    expect(
      applyFederatedPendingProfileSnapshot(profile, {
        displayName: 'Remote Group',
        avatar: 'snapshot-avatar',
      }),
    ).toEqual({
      name: 'Remote Group',
      avatar: 'snapshot-avatar',
    });
  });

  it('retains identity-backed presentation only when no snapshot is supplied', () => {
    expect(applyFederatedPendingProfileSnapshot(profile)).toEqual(profile);
  });
});

describe('RelationshipService P2P shell GC', () => {
  it('cleans an unused shell without a separate endpoint projection table', async () => {
    const deletedTables: unknown[] = [];
    const tx = {
      query: {
        account: { findFirst: vi.fn().mockResolvedValue({ account: 'alice' }) },
      },
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ threadId: 7 }] })
        .mockResolvedValueOnce({ rows: [] }),
      delete: vi.fn((table: unknown) => {
        deletedTables.push(table);
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    };
    const service = new RelationshipService(
      {
        db: {
          transaction: vi.fn(
            async (run: (transaction: unknown) => Promise<unknown>) => run(tx),
          ),
        },
      } as never,
      {} as never,
      {} as never,
    );

    await expect(service.cleanupExpiredRelationshipShells()).resolves.toBe(1);
    expect(deletedTables).toEqual([accountThreadState, messageThread]);
  });
});

describe('RelationshipService conversation notification capture', () => {
  function setup(threadId: number | null) {
    const recipients = [
      { id: 1, account: 'alice', namespaceId: 0, availability: 'AVAILABLE' },
      { id: 2, account: 'bob', namespaceId: 0, availability: 'REMOVED' },
    ];
    const updates = [{ userId: 1, feedId: 10, threadFeedEndId: 14 }];
    const captureWhere = vi.fn().mockResolvedValue(updates);
    const recipientWhere = vi.fn((_where: SQL) => ({
      orderBy: vi.fn().mockResolvedValue(recipients),
    }));
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({ innerJoin: () => ({ where: recipientWhere }) }),
        })
        .mockReturnValueOnce({ from: () => ({ where: captureWhere }) }),
    };
    const readP2PRelationshipInTx = vi.fn().mockResolvedValue({
      pair: { threadId },
    });
    const publishRequestHeadInTx = vi.fn();
    const service = new RelationshipService(
      {} as never,
      { publishRequestHeadInTx } as never,
      { readP2PRelationshipInTx } as never,
    );
    return {
      service,
      tx,
      captureWhere,
      recipientWhere,
      updates,
      readP2PRelationshipInTx,
      publishRequestHeadInTx,
    };
  }

  it('captures existing thread heads only for available local recipients', async () => {
    const fixture = setup(7);
    const first = { account: 'alice', namespaceId: 0 };
    const second = { account: 'bob', namespaceId: 0 };
    await expect(
      fixture.service.writeRelationshipRequestClientStateInTx(
        fixture.tx as never,
        first,
        second,
      ),
    ).resolves.toEqual(fixture.updates);
    expect(fixture.readP2PRelationshipInTx).toHaveBeenCalledWith(
      fixture.tx,
      first,
      second,
    );
    expect(
      new PgDialect().sqlToQuery(fixture.captureWhere.mock.calls[0][0]).params,
    ).toEqual([1]);
    expect(fixture.publishRequestHeadInTx).not.toHaveBeenCalled();
  });

  it('does not capture conversation heads for a threadless pending relationship', async () => {
    const fixture = setup(null);
    await expect(
      fixture.service.writeRelationshipRequestClientStateInTx(
        fixture.tx as never,
        { account: 'alice', namespaceId: 0 },
        { account: 'bob', namespaceId: 7 },
      ),
    ).resolves.toEqual([]);
    expect(fixture.tx.select).not.toHaveBeenCalled();
    expect(fixture.publishRequestHeadInTx).not.toHaveBeenCalled();
  });

  it('does not treat a remote endpoint as a local notification recipient', async () => {
    const fixture = setup(7);
    await fixture.service.writeRelationshipRequestClientStateInTx(
      fixture.tx as never,
      { account: 'alice', namespaceId: 0 },
      { account: 'bob', namespaceId: 7 },
    );
    expect(
      new PgDialect().sqlToQuery(fixture.recipientWhere.mock.calls[0][0])
        .params,
    ).toEqual(['alice']);
  });
});
