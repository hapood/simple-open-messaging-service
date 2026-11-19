import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service.js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FederationPendingMediaPromoter } from './federation-pending-media-promoter.js';
import * as tables from '../database/schema.js';

async function fixture(outstanding = false, lockAvailable = true) {
  const batch = {
    id: 1n,
    batchId: 'batch',
    direction: 'INBOUND',
    status: 'pending',
    messageId: 2n,
    threadId: null,
    creatorAccount: null,
    contentType: null,
    content: null,
    clientMessageId: null,
    originDomain: 'peer.test',
    publisherNamespaceId: 3,
    expectedAuthorizationEpoch: 0,
  };
  const message = {
    id: 2n,
    threadId: 1,
    originSeq: 4,
    publisherNamespaceId: 3,
    creatorAccount: 'alice',
    localState: 'STUB',
    content: JSON.stringify({ text: 'ready' }),
  };
  const update = vi.fn((_table: unknown) => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  }));
  const remove = vi.fn((table: unknown) => {
    if (table !== tables.pendingMedia)
      throw new Error('materialization must retain tasks');
    return { where: vi.fn().mockResolvedValue(undefined) };
  });
  const execute = vi.fn(async (query: SQL) => {
    const { sql } = new PgDialect().sqlToQuery(query);
    if (sql.includes('FROM "FileSyncProgress"')) {
      return { rows: outstanding ? [{ exists: 1 }] : [] };
    }
    if (sql.includes('FROM "MessageThread" thread')) {
      return {
        rows: [
          { type: 'P2P', groupId: null, account: null, namespaceId: null },
        ],
      };
    }
    // An unbound P2P shell has no relationship parent to lock.
    if (sql.includes('FROM "RelationshipPair" pair')) return { rows: [] };
    if (
      sql.includes('FROM "MessageThread"') &&
      sql.includes('FOR NO KEY UPDATE')
    ) {
      return { rows: lockAvailable ? [{ id: message.threadId }] : [] };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  });
  const tx = {
    query: {
      pendingMedia: { findFirst: vi.fn().mockResolvedValue(batch) },
      message: { findFirst: vi.fn().mockResolvedValue(message) },
      fileSyncProgress: {
        findFirst: vi.fn().mockResolvedValue(undefined),
        findMany: vi.fn().mockResolvedValue([]),
      },
      federatedMessageTombstone: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
    execute,
    select: () => ({
      from: () => ({
        where: () => ({ for: () => ({ limit: async () => [message] }) }),
      }),
    }),
    update,
    delete: remove,
  };
  const database = {
    db: {
      transaction: async (work: (value: typeof tx) => Promise<unknown>) =>
        work(tx),
      select: () => ({
        from: () => ({ innerJoin: () => ({ where: async () => [] }) }),
      }),
    },
  };
  const module = await Test.createTestingModule({
    providers: [
      FederationPendingMediaPromoter,
      { provide: DatabaseService, useValue: database },
    ],
  }).compile();
  onTestFinished(() => module.close());
  return {
    subject: module.get(FederationPendingMediaPromoter),
    batch,
    message,
    tx,
    update,
    remove,
    execute,
  };
}

describe('inbound message materialization retains transfer outcomes', () => {
  it('materializes a message without deleting or rewriting completed file tasks', async () => {
    const { subject, remove, update, execute } = await fixture();
    await expect(subject.promote('batch')).resolves.toBe(true);
    expect(remove).toHaveBeenCalledExactlyOnceWith(tables.pendingMedia);
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0],
    );
    expect(update.mock.calls.map(([table]) => table)).not.toContain(
      tables.fileSyncProgress,
    );
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain("status <> 'COMPLETED'");
    expect(query.params).toEqual(['batch']);
    const queries = execute.mock.calls.map(([statement]) =>
      new PgDialect().sqlToQuery(statement),
    );
    const threadLock = queries.findIndex(
      (statement) =>
        statement.sql.includes('FROM "MessageThread"') &&
        statement.sql.includes('FOR NO KEY UPDATE'),
    );
    const identityLock = queries.findIndex((statement) =>
      statement.sql.includes('pg_advisory_xact_lock'),
    );
    expect(threadLock).toBeGreaterThan(-1);
    expect(identityLock).toBeGreaterThan(threadLock);
    expect(queries[identityLock].params).toEqual(['1:peer.test:3:4']);
    expect(execute.mock.invocationCallOrder[identityLock]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
  });

  it('does not materialize when the real lock acquisition cannot lock the thread', async () => {
    const { subject, update, remove, execute } = await fixture(false, false);
    await expect(subject.promote('batch')).rejects.toThrow(
      'thread 1 does not exist',
    );
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(
      execute.mock.calls.some(([statement]) =>
        new PgDialect()
          .sqlToQuery(statement)
          .sql.includes('pg_advisory_xact_lock'),
      ),
    ).toBe(false);
  });

  it('rechecks task outcomes after acquiring the message lock', async () => {
    const { subject, tx, update, remove, execute } = await fixture();
    tx.select = () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: async () => {
              // The first completion check passed, but retry reset a task while this lock waited.
              execute.mockResolvedValueOnce({ rows: [{ exists: 1 }] } as never);
              return [{ id: 2n, localState: 'STUB' }] as never;
            },
          }),
        }),
      }),
    });
    await expect(subject.promote('batch')).resolves.toBe(false);
    const checks = execute.mock.calls.filter(([statement]) =>
      new PgDialect()
        .sqlToQuery(statement)
        .sql.includes('FROM "FileSyncProgress"'),
    );
    expect(checks).toHaveLength(2);
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects a completed task owned by another message without changing coordination', async () => {
    const { subject, tx, update, remove } = await fixture();
    tx.query.fileSyncProgress.findFirst.mockResolvedValue({ id: 7n });
    await expect(subject.promote('batch')).rejects.toThrow(
      'contains a task owned by another message',
    );
    const query = new PgDialect().sqlToQuery(
      tx.query.fileSyncProgress.findFirst.mock.calls[0][0].where,
    );
    expect(query.sql).toContain('"messageId" <>');
    expect(query.params).toEqual(['batch', 2n]);
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'retains coordination when attachment tasks are missing (partial: %s)',
    async (partial) => {
      const { subject, message, tx, update, remove } = await fixture();
      const first = 'a'.repeat(64);
      const second = 'b'.repeat(64);
      message.content = JSON.stringify([
        { url: `/uploads/msg-assets/aa/aa/${first}` },
        { url: `/uploads/msg-assets/bb/bb/${second}` },
      ]);
      tx.query.fileSyncProgress.findMany.mockResolvedValue(
        partial ? [{ digest: first }] : [],
      );
      await expect(subject.promote('batch')).resolves.toBe(false);
      expect(tx.query.fileSyncProgress.findMany).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it('does not materialize while a file task is pending or failed', async () => {
    const { subject, update, remove } = await fixture(true);
    await expect(subject.promote('batch')).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not mutate tasks when the batch was already materialized', async () => {
    const { subject, tx, update, execute, remove } = await fixture();
    tx.query.pendingMedia.findFirst.mockResolvedValue(undefined as never);
    await expect(subject.promote('batch')).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
