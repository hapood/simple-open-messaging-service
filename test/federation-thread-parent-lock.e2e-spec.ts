import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { group, messageThread } from '../src/database/schema.js';
import { sql } from 'drizzle-orm';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';
import { FederationStateFeedConsumerService } from '../src/federation/federation-state-feed-consumer.service.js';

describe('thread epoch lock and parent foreign-key checks', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });
  afterAll(async () => {
    await mod?.close();
  });

  it.each(['epoch gate', 'state feed'] as const)(
    'the production %s waits for the group before touching the thread',
    async (entry) => {
      const [parent] = await database.db
        .insert(group)
        .values({
          account: `!parent-${entry.replace(' ', '-')}`,
          domain: 'local',
          namespaceId: 0,
          name: 'Epoch parent',
          updatedAt: new Date(),
        })
        .returning();
      const [thread] = await database.db
        .insert(messageThread)
        .values({ type: 'GROUP', groupId: parent.id, updatedAt: new Date() })
        .returning();
      const membership = await database.pool.connect();
      let result: Promise<unknown> | undefined;
      try {
        await membership.query('BEGIN');
        const {
          rows: [session],
        } = await membership.query('SELECT pg_backend_pid() AS pid');
        await membership.query(
          'SELECT id FROM "Group" WHERE id=$1 FOR UPDATE',
          [parent.id],
        );
        result = database.db
          .transaction(async (tx) => {
            if (entry === 'epoch gate') {
              await FederationThreadSyncStateService.lockAuthorizationEpochInTx(
                tx,
                thread.id,
                0,
              );
            } else {
              // Isolate routing only; execute the real state-feed consumer and head merger.
              const consumer = Object.create(
                FederationStateFeedConsumerService.prototype,
              ) as FederationStateFeedConsumerService;
              Object.assign(consumer, {
                resolveStateFeedTargetInTransaction: async () => ({
                  threadId: thread.id,
                  reverseEnabled: false,
                }),
              });
              await consumer.applyPageInTx(tx, 'peer.test', 0, {
                items: [
                  {
                    account: parent.account,
                    eventType: 'THREAD_CONTENT_HEAD',
                    feedId: '1',
                    body: { messageEndSeq: 1, tombstoneEndSeq: 0 },
                  },
                ],
                scannedThrough: '1',
                stateFeedEndId: '1',
                hasMore: false,
              });
            }
            for (let i = 0; i < 2; i++)
              await tx.execute(
                sql`UPDATE "MessageThread" SET "curSeq" = "curSeq" + 1 WHERE id=${thread.id}`,
              );
            return 'committed';
          })
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        const deadline = Date.now() + 5000;
        for (;;) {
          const { rows } = await database.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
            [session.pid],
          );
          if (rows.length) break;
          if (Date.now() > deadline)
            throw new Error('epoch gate did not wait for group');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await membership.query(
          'SELECT id FROM "MessageThread" WHERE id=$1 FOR UPDATE NOWAIT',
          [thread.id],
        );
        await membership.query('COMMIT');
        expect(await result).toEqual({ value: 'committed' });
      } finally {
        await membership.query('ROLLBACK');
        membership.release();
        await result;
      }
    },
  );

  it.each([
    'UPDATE',
    'ROW_LOCK',
    'REPEATED_ALLOCATION',
    'PARENT_NO_KEY_UPDATE',
  ] as const)(
    '%s before allocation while the parent group is locked',
    async (mode) => {
      const [parent] = await database.db
        .insert(group)
        .values({
          account: `!p-${mode.toLowerCase()}`,
          domain: 'local',
          namespaceId: 0,
          name: 'Parent lock probe',
          updatedAt: new Date(),
        })
        .returning();
      const [thread] = await database.db
        .insert(messageThread)
        .values({
          type: 'GROUP',
          groupId: parent.id,
          updatedAt: new Date(),
        })
        .returning();
      const content = await database.pool.connect();
      const membership = await database.pool.connect();
      try {
        await content.query('BEGIN');
        await content.query("SET LOCAL lock_timeout = '500ms'");
        await content.query(
          mode === 'UPDATE' || mode === 'PARENT_NO_KEY_UPDATE'
            ? 'UPDATE "MessageThread" SET "authorizationEpoch" = "authorizationEpoch" WHERE id = $1 RETURNING id'
            : 'SELECT id FROM "MessageThread" WHERE id = $1 FOR NO KEY UPDATE',
          [thread.id],
        );
        if (mode === 'REPEATED_ALLOCATION')
          await content.query(
            'UPDATE "MessageThread" SET "curSeq" = "curSeq" + 1 WHERE id = $1',
            [thread.id],
          );
        await membership.query('BEGIN');
        await membership.query(
          mode === 'PARENT_NO_KEY_UPDATE'
            ? 'SELECT id FROM "Group" WHERE id = $1 FOR NO KEY UPDATE'
            : 'SELECT id FROM "Group" WHERE id = $1 FOR UPDATE',
          [parent.id],
        );
        const allocation = content.query(
          'UPDATE "MessageThread" SET "curSeq" = "curSeq" + 1 WHERE id = $1 RETURNING "curSeq"',
          [thread.id],
        );
        if (mode === 'UPDATE' || mode === 'REPEATED_ALLOCATION') {
          await expect(allocation).rejects.toMatchObject({ code: '55P03' });
        } else {
          await expect(allocation).resolves.toMatchObject({
            rows: [{ curSeq: 1 }],
          });
        }
      } finally {
        await content.query('ROLLBACK');
        await membership.query('ROLLBACK');
        content.release();
        membership.release();
      }
    },
  );
});
