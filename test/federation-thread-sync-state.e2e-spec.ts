import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  federationThreadHistoryGap,
  federationThreadSyncState,
  identityNamespace,
  message,
  messageThread,
} from '../src/database/schema.js';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';

describe('federation thread synchronization state', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let states: FederationThreadSyncStateService;
  let threadId: number;
  let namespaceId: number;
  const peerDomain = 'peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [FederationThreadSyncStateService],
    }).compile();
    database = mod.get(DatabaseService);
    states = mod.get(FederationThreadSyncStateService);
  });

  afterAll(async () => mod.close());

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "MessageThread", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
    const [existingNamespace] = await database.db
      .select({ id: identityNamespace.id })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.domain, peerDomain),
          isNull(identityNamespace.retiredAt),
        ),
      )
      .limit(1);
    namespaceId =
      existingNamespace?.id ??
      (
        await database.db
          .insert(identityNamespace)
          .values({
            domain: peerDomain,
            rootKeyFingerprint: 'sha256:thread-sync-test',
            rootPublicKey: Buffer.alloc(32, 2).toString('base64'),
            identityPinnedAt: new Date(),
          })
          .returning({ id: identityNamespace.id })
      )[0].id;
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      activeNamespaceId: namespaceId,
      trustLevel: 'available',
    });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        authorityNamespaceId: namespaceId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
  });

  async function initializeTail(messageTargetSeq: number): Promise<void> {
    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.reconcileThreadHeadInTx(tx, {
        threadId,
        namespaceId,
        messageTargetSeq,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      }),
    );
  }

  it('keeps the newest advertised message forward and creates an inclusive older gap', async () => {
    await initializeTail(100);

    await expect(states.require(threadId, namespaceId)).resolves.toMatchObject({
      messageTargetSeq: 100,
      messageProcessedThroughSeq: 99,
      deletionTargetSeq: 0,
      deletionProcessedThroughSeq: 0,
      authorizationEpoch: 0,
      historyBoundaryReached: false,
    });
    const [gap] = await database.db
      .select()
      .from(federationThreadHistoryGap)
      .where(eq(federationThreadHistoryGap.threadId, threadId));
    expect(gap).toMatchObject({ startSeq: 1, endSeq: 99, recoverable: true });
  });

  it('commits STUB insertion and reverse gap shrink in one transaction', async () => {
    await initializeTail(100);
    const state = await states.require(threadId, namespaceId);
    const applyDependencies = vi.fn();

    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
        threadId,
        namespaceId,
        authorizationEpoch: 0,
        gapId: state.activeGapId!,
        beforeSeq: 100,
        scannedThrough: 50,
        throughSeq: 1,
        closesGap: false,
        applyDependencies: async () => {
          await tx.insert(message).values({
            threadId,
            seq: 99,
            originSeq: 99,
            sourceNamespaceId: namespaceId,
            creatorAccount: 'bob',
            creatorDomain: peerDomain,
            creatorNamespaceId: namespaceId,
            contentType: 'IMAGE',
            content: JSON.stringify({ digest: 'a'.repeat(64) }),
            localState: 'STUB',
            updatedAt: new Date(),
          });
          await applyDependencies();
        },
      }),
    );

    const [gap] = await database.db
      .select()
      .from(federationThreadHistoryGap)
      .where(eq(federationThreadHistoryGap.id, state.activeGapId!));
    expect(gap).toMatchObject({ startSeq: 1, endSeq: 49 });
    await expect(
      database.db.query.message.findFirst({
        where: eq(message.threadId, threadId),
      }),
    ).resolves.toMatchObject({ seq: 99, localState: 'STUB' });
    expect(applyDependencies).toHaveBeenCalledOnce();
  });

  it('rolls back an old-epoch reverse commit before applying its buffered facts', async () => {
    await initializeTail(100);
    const state = await states.require(threadId, namespaceId);
    await database.db
      .update(messageThread)
      .set({ authorizationEpoch: 1 })
      .where(eq(messageThread.id, threadId));
    const applyDependencies = vi.fn();

    await expect(
      database.db.transaction((tx) =>
        FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
          threadId,
          namespaceId,
          authorizationEpoch: 0,
          gapId: state.activeGapId!,
          beforeSeq: 100,
          scannedThrough: 50,
          throughSeq: 1,
          closesGap: false,
          applyDependencies,
        }),
      ),
    ).rejects.toThrow('federation round authorization epoch changed');

    expect(applyDependencies).not.toHaveBeenCalled();
    const [gap] = await database.db
      .select()
      .from(federationThreadHistoryGap)
      .where(eq(federationThreadHistoryGap.id, state.activeGapId!));
    expect(gap).toMatchObject({ startSeq: 1, endSeq: 99 });
  });

  it('deletes the final gap only after switching synchronization state to terminal', async () => {
    await initializeTail(2);
    const state = await states.require(threadId, namespaceId);

    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
        threadId,
        namespaceId,
        authorizationEpoch: 0,
        gapId: state.activeGapId!,
        beforeSeq: 2,
        scannedThrough: 1,
        throughSeq: 1,
        closesGap: true,
      }),
    );

    await expect(states.require(threadId, namespaceId)).resolves.toMatchObject({
      activeGapId: null,
      historyBoundaryReached: true,
    });
    const gaps = await database.db
      .select()
      .from(federationThreadHistoryGap)
      .where(eq(federationThreadHistoryGap.threadId, threadId));
    expect(gaps).toEqual([]);
  });

  it('rejects a missing state instead of fabricating zero cursors', async () => {
    await expect(states.require(threadId, namespaceId)).rejects.toThrow(
      `federated thread ${threadId} has no synchronization state`,
    );
  });

  it('keeps equal sequence numbers from two publishers of one thread independent', async () => {
    const [other] = await database.db
      .insert(identityNamespace)
      .values({
        domain: `other-${Date.now()}.test`,
        rootKeyFingerprint: 'sha256:other-thread-sync-test',
        rootPublicKey: Buffer.alloc(32, 7).toString('base64'),
        identityPinnedAt: new Date(),
      })
      .returning({ id: identityNamespace.id });
    for (const sourceNamespaceId of [namespaceId, other.id]) {
      await database.db.transaction((tx) =>
        FederationThreadSyncStateService.reconcileThreadHeadInTx(tx, {
          threadId,
          namespaceId: sourceNamespaceId,
          messageTargetSeq: 10,
          deletionTargetSeq: 2,
          reverseEnabled: false,
        }),
      );
      if (sourceNamespaceId === namespaceId)
        await database.db.transaction((tx) =>
          FederationThreadSyncStateService.advanceMessageProcessedThroughInTx(
            tx,
            threadId,
            10,
            10,
            sourceNamespaceId,
          ),
        );
    }
    expect(await states.require(threadId, namespaceId)).toMatchObject({
      messageProcessedThroughSeq: 10,
    });
    expect(await states.require(threadId, other.id)).toMatchObject({
      messageProcessedThroughSeq: 0,
      deletionProcessedThroughSeq: 0,
    });
    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.advanceDeletionProcessedThroughInTx(
        tx,
        threadId,
        2,
        2,
        namespaceId,
      ),
    );
    expect(await states.require(threadId, other.id)).toMatchObject({
      deletionProcessedThroughSeq: 0,
    });
    const restarted = new FederationThreadSyncStateService(database);
    expect(await restarted.require(threadId, namespaceId)).toMatchObject({
      messageProcessedThroughSeq: 10,
      deletionProcessedThroughSeq: 2,
    });
    expect(await restarted.require(threadId, other.id)).toMatchObject({
      messageProcessedThroughSeq: 0,
      deletionProcessedThroughSeq: 0,
    });
  });

  it.each(['commit', 'unavailable'])(
    'isolates reverse gaps when one publisher completes via %s',
    async (mode) => {
      const [other] = await database.db
        .insert(identityNamespace)
        .values({
          domain: `gap-${Date.now()}.test`,
          rootKeyFingerprint: 'sha256:gap-source',
          rootPublicKey: Buffer.alloc(32, 8).toString('base64'),
          identityPinnedAt: new Date(),
        })
        .returning({ id: identityNamespace.id });
      for (const sourceNamespaceId of [namespaceId, other.id])
        await database.db.transaction((tx) =>
          FederationThreadSyncStateService.reconcileThreadHeadInTx(tx, {
            threadId,
            namespaceId: sourceNamespaceId,
            messageTargetSeq: 10,
            deletionTargetSeq: 0,
            reverseEnabled: true,
          }),
        );
      const first = await states.require(threadId, namespaceId);
      const second = await states.require(threadId, other.id);
      expect(first.activeGapId).not.toBe(second.activeGapId);
      await expect(
        database.db
          .update(federationThreadSyncState)
          .set({ activeGapId: second.activeGapId })
          .where(
            and(
              eq(federationThreadSyncState.threadId, threadId),
              eq(federationThreadSyncState.namespaceId, namespaceId),
            ),
          ),
      ).rejects.toMatchObject({ cause: { code: '23503' } });
      await database.db.transaction((tx) =>
        mode === 'commit'
          ? FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
              threadId,
              namespaceId,
              authorizationEpoch: 0,
              gapId: first.activeGapId!,
              beforeSeq: 10,
              scannedThrough: 1,
              throughSeq: 1,
              closesGap: true,
            })
          : FederationThreadSyncStateService.markReverseGapUnavailableInTx(tx, {
              threadId,
              namespaceId,
              authorizationEpoch: 0,
              gapId: first.activeGapId!,
            }),
      );
      expect(await states.require(threadId, namespaceId)).toMatchObject({
        activeGapId: null,
        historyBoundaryReached: true,
      });
      expect(
        await states.resolveReverseWindow(threadId, other.id),
      ).toMatchObject({
        gapId: second.activeGapId,
        beforeSeq: 10,
        throughSeq: 1,
      });
    },
  );

  it('preserves an unambiguous mirror cursor and rebuilds mixed authority cursors during migration', async () => {
    await initializeTail(10);
    const migration = await readFile(
      new URL(
        '../database/migrations/0001_source_scoped_thread_sync.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const rollback = new Error('rollback migration fixture');
    await expect(
      database.db.transaction(async (tx) => {
        // Reconstruct the preceding schema inside a rollback-only isolated transaction.
        await tx.execute(
          sql.raw(`
        ALTER TABLE "FederationThreadSyncState" DROP CONSTRAINT "FederationThreadSyncState_activeGap_fkey";
        ALTER TABLE "FederationThreadSyncState" DROP CONSTRAINT "FederationThreadSyncState_namespaceId_fkey";
        ALTER TABLE "FederationThreadHistoryGap" DROP CONSTRAINT "FederationThreadHistoryGap_namespaceId_fkey";
        ALTER TABLE "FederationThreadSyncState" DROP CONSTRAINT "FederationThreadSyncState_pkey";
        ALTER TABLE "FederationThreadHistoryGap" DROP CONSTRAINT "FederationThreadHistoryGap_threadId_id_key";
        DROP INDEX "FederationThreadHistoryGap_interval_key";
        DROP INDEX "FederationThreadHistoryGap_recoverable_idx";
        ALTER TABLE "FederationThreadSyncState" DROP COLUMN "namespaceId";
        ALTER TABLE "FederationThreadHistoryGap" DROP COLUMN "namespaceId";
        ALTER TABLE "FederationThreadSyncState" ADD CONSTRAINT "FederationThreadSyncState_pkey" PRIMARY KEY ("threadId");
        ALTER TABLE "FederationThreadHistoryGap" ADD CONSTRAINT "FederationThreadHistoryGap_threadId_id_key" UNIQUE ("threadId", id);
        CREATE UNIQUE INDEX "FederationThreadHistoryGap_interval_key" ON "FederationThreadHistoryGap" ("threadId", "startSeq", "endSeq");
        CREATE INDEX "FederationThreadHistoryGap_recoverable_idx" ON "FederationThreadHistoryGap" ("threadId", "endSeq") WHERE recoverable = true;
        ALTER TABLE "FederationThreadSyncState" ADD CONSTRAINT "FederationThreadSyncState_activeGap_fkey" FOREIGN KEY ("threadId", "activeGapId") REFERENCES "FederationThreadHistoryGap"("threadId", id) ON DELETE RESTRICT;
      `),
        );
        const local = await tx.execute<{ id: number }>(sql`
          WITH created_group AS (
            INSERT INTO "GroupAccount" (account, "updatedAt")
            VALUES ('!migration-authority', CURRENT_TIMESTAMP)
            RETURNING id
          )
          INSERT INTO "MessageThread" (type, "groupAccountId", "groupAccount", "groupDomain", "curSeq", "authorityNamespaceId", "updatedAt")
          SELECT 'GROUP', id, '!migration-authority', 'local', 1, 0, CURRENT_TIMESTAMP FROM created_group RETURNING id
      `);
        const localId = local.rows[0].id;
        await tx.execute(
          sql`INSERT INTO "FederationThreadSyncState" ("threadId", "messageTargetSeq", "messageProcessedThroughSeq") VALUES (${localId}, 10, 10)`,
        );
        await tx.execute(
          sql`INSERT INTO "ThreadAudience" ("threadId", "targetNamespaceId", "targetDomain") VALUES (${localId}, ${namespaceId}, ${peerDomain})`,
        );
        await tx.execute(
          sql`INSERT INTO "PeerStateFeedPullCursor" ("peerDomain", "namespaceId", initialized, "committedThrough") VALUES (${peerDomain}, ${namespaceId}, true, 50)`,
        );
        await tx.execute(
          sql`INSERT INTO "Message" ("threadId", seq, "contentType", content, "updatedAt") VALUES (${localId}, 1, 'SYSTEM', '{}', CURRENT_TIMESTAMP)`,
        );
        await tx.execute(sql.raw(migration));
        const mirror = await tx.query.federationThreadSyncState.findFirst({
          where: eq(federationThreadSyncState.threadId, threadId),
        });
        expect(mirror).toMatchObject({
          namespaceId,
          messageTargetSeq: 10,
          messageProcessedThroughSeq: 9,
        });
        expect(mirror?.activeGapId).not.toBeNull();
        expect(
          await tx.query.federationThreadSyncState.findFirst({
            where: eq(federationThreadSyncState.threadId, localId),
          }),
        ).toBeUndefined();
        const cursor = await tx.execute<{ committedThrough: string }>(
          sql`SELECT "committedThrough" FROM "PeerStateFeedPullCursor" WHERE "namespaceId" = ${namespaceId}`,
        );
        expect(String(cursor.rows[0].committedThrough)).toBe('0');
        expect(
          await tx.query.message.findFirst({
            where: eq(message.threadId, localId),
          }),
        ).toBeDefined();
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
