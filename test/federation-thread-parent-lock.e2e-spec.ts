import { businessAccountScopeKey } from '../src/common/locks/account-business-lock.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  federationThreadSyncState,
  groupAccount,
  messageThread,
} from '../src/database/schema.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { sql } from 'drizzle-orm';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';
import { FederationStateFeedConsumerService } from '../src/federation/federation-state-feed-consumer.service.js';

describe('group business scope and content lock ordering', () => {
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

  it('reacquires an existing group pair without upgrading against a key-share holder', async () => {
    const [parent] = await database.db
      .insert(groupAccount)
      .values({ account: '!pair-lock', updatedAt: new Date() })
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: parent.account,
        groupDomain: 'local',
        groupAccountId: parent.id,
        updatedAt: new Date(),
      })
      .returning();
    const [member] = await database.db
      .insert(account)
      .values({ account: 'pair-lock-member' })
      .returning();
    const service = new RelationshipIntentService();
    const params = {
      groupId: thread.id,
      threadId: thread.id,
      memberUserId: member.id,
    };
    const pair = await database.db.transaction((tx) =>
      service.lockGroupMutationInTx(tx, params),
    );
    const reader = await database.pool.connect();
    try {
      await reader.query('BEGIN');
      await reader.query(
        'SELECT id FROM "RelationshipPair" WHERE id = $1 FOR KEY SHARE',
        [pair.id.toString()],
      );
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
        const locked = await service.lockGroupMutationInTx(tx, params);
        expect(locked.id).toBe(pair.id);
      });
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
  });

  it.each(['epoch gate', 'state feed'] as const)(
    'the production %s waits for the group before touching the thread',
    async (entry) => {
      const [parent] = await database.db
        .insert(groupAccount)
        .values({
          account: `!parent-${entry.replace(' ', '-')}`,
          updatedAt: new Date(),
        })
        .returning();
      const [thread] = await database.db
        .insert(messageThread)
        .values({
          type: 'GROUP',
          groupAccount: parent.account,
          groupDomain: 'local',
          groupAccountId: parent.id,
          updatedAt: new Date(),
        })
        .returning();
      await database.db.insert(federationThreadSyncState).values({
        threadId: thread.id,
        namespaceId: 0,
        authorizationEpoch: thread.authorizationEpoch,
      });
      const membership = await database.pool.connect();
      let result: Promise<unknown> | undefined;
      try {
        await membership.query('BEGIN');
        const {
          rows: [session],
        } = await membership.query('SELECT pg_backend_pid() AS pid');
        await membership.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [
            businessAccountScopeKey({
              account: parent.account,
              profileNamespaceId: 0,
            }),
          ],
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
                profileNamespaceFeedEndId: '0',
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

  it('updating group controls does not require an additional parent row lock before content allocation', async () => {
    const [parent] = await database.db
      .insert(groupAccount)
      .values({ account: '!control-lock' })
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: parent.account,
        groupDomain: 'local',
        groupAccountId: parent.id,
        updatedAt: new Date(),
      })
      .returning();
    const content = await database.pool.connect();
    const controls = await database.pool.connect();
    try {
      await content.query('BEGIN');
      await content.query("SET LOCAL lock_timeout = '500ms'");
      await content.query(
        'UPDATE "MessageThread" SET "curSeq" = "curSeq" + 1 WHERE id = $1',
        [thread.id],
      );
      await controls.query('BEGIN');
      await controls.query(
        'UPDATE "GroupAccount" SET "defaultProfileRev" = 1 WHERE id = $1',
        [parent.id],
      );
      await expect(
        content.query(
          'UPDATE "MessageThread" SET "curSeq" = "curSeq" + 1 WHERE id = $1 RETURNING "curSeq"',
          [thread.id],
        ),
      ).resolves.toMatchObject({ rows: [{ curSeq: 2 }] });
    } finally {
      await content.query('ROLLBACK');
      await controls.query('ROLLBACK');
      content.release();
      controls.release();
    }
  });
});
