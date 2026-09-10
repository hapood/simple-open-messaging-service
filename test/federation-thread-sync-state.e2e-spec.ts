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
  account,
  accountThreadState,
  federatedPeer,
  groupAccount,
  federationThreadHistoryGap,
  federationThreadSyncState,
  identityNamespace,
  message,
  messageThread,
  relationshipPair,
  threadAudience,
} from '../src/database/schema.js';
import { setLockedP2PPairActiveInTx } from '../src/relationship/p2p-pair-state.js';
import { lockBusinessAccountsInTx } from '../src/relationship/business-scope-lock.js';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';
import { FederationThreadSourceService } from '../src/federation/federation-thread-source.service.js';
import { FederationRelationshipMutationService } from '../src/federation/federation-relationship-mutation.service.js';
import { requireThreadContentLockInTx } from '../src/relationship/thread-content-lock.js';

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
      'TRUNCATE TABLE "Account", "MessageThread", "FederatedPeer" RESTART IDENTITY CASCADE',
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

  it('does not create synchronization state from an unsolicited content head', async () => {
    await database.db.transaction(async (tx) => {
      const threadLock = await requireThreadContentLockInTx(tx, threadId);
      expect(
        await FederationThreadSyncStateService.updateThreadHeadInTx(tx, {
          threadId,
          namespaceId,
          messageTargetSeq: 3,
          deletionTargetSeq: 1,
          threadLock,
        }),
      ).toBe(false);
    });
    expect(
      await database.db.select().from(federationThreadSyncState),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(federationThreadHistoryGap),
    ).toHaveLength(0);
  });

  it.each([true, false])(
    'serializes authority audience removal with round commits (removal first: %s)',
    async (removalFirst) => {
      const [group] = await database.db
        .insert(groupAccount)
        .values({ account: '!authority' })
        .onConflictDoUpdate({
          target: groupAccount.account,
          set: { updatedAt: new Date() },
        })
        .returning({ id: groupAccount.id });
      await database.db
        .update(messageThread)
        .set({
          type: 'GROUP',
          groupAccount: '!authority',
          groupDomain: 'local',
          groupAccountId: group.id,
          authorityNamespaceId: 0,
        })
        .where(eq(messageThread.id, threadId));
      await database.db.insert(threadAudience).values({
        threadId,
        targetDomain: peerDomain,
        targetNamespaceId: namespaceId,
        localUserId: null,
      });
      const source = {
        kind: 'GROUP' as const,
        localGroupAuthority: true,
        threadId,
        peerDomain,
        namespaceId,
        selector: { account: '!authority' },
      };
      let ready!: () => void;
      let release!: () => void;
      const locked = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = (remove: boolean, first: boolean) =>
        database.db.transaction(async (tx) => {
          const lock = await requireThreadContentLockInTx(tx, threadId);
          if (first) {
            ready();
            await released;
          }
          if (remove) {
            await tx
              .delete(threadAudience)
              .where(eq(threadAudience.threadId, threadId));
          } else {
            await FederationThreadSourceService.assertAudienceInTx(
              lock,
              source,
            );
            await tx
              .update(messageThread)
              .set({ curSeq: 1 })
              .where(eq(messageThread.id, threadId));
          }
        });
      const first = run(removalFirst, true);
      await locked;
      const second = run(!removalFirst, false);
      const result = Promise.allSettled([first, second]);
      release();
      const outcomes = await result;
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1].status).toBe(removalFirst ? 'rejected' : 'fulfilled');
      if (outcomes[1].status === 'rejected')
        expect(outcomes[1].reason.message).toContain(
          'no longer has an audience',
        );
      const thread = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
      });
      expect(thread?.curSeq).toBe(removalFirst ? 0 : 1);
      expect(thread?.authorizationEpoch).toBe(0);
    },
  );

  it.each(['REQUESTED', 'ACCEPTED'] as const)(
    'does not create relationships or projections for a dissolved mirror (%s)',
    async (status) => {
      await database.db
        .update(messageThread)
        .set({
          type: 'GROUP',
          groupAccount: '!dissolved',
          groupDomain: peerDomain,
          groupDissolvedAt: new Date(),
        })
        .where(eq(messageThread.id, threadId));
      const mutations = new FederationRelationshipMutationService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const updates: Array<{ userId: number; feedId: number }> = [];
      await database.db.transaction(async (tx) => {
        expect(
          await mutations.writeMemberRelationshipIntentInTx(
            tx,
            threadId,
            99,
            status,
            updates,
          ),
        ).toEqual(new Map());
        expect(
          await mutations.writeGroupRelationshipIntentInTx(
            tx,
            threadId,
            99,
            '',
            status,
            updates,
          ),
        ).toEqual(new Map());
      });
      expect(updates).toEqual([]);
      expect(
        await database.db.query.relationshipPair.findMany({
          where: eq(relationshipPair.threadId, threadId),
        }),
      ).toEqual([]);
      expect(
        await database.db.query.accountThreadState.findMany({
          where: eq(accountThreadState.threadId, threadId),
        }),
      ).toEqual([]);
    },
  );

  async function initializeTail(messageTargetSeq: number): Promise<void> {
    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
        tx,
        {
          threadId,
          namespaceId,
          messageTargetSeq,
          deletionTargetSeq: 0,
          reverseEnabled: true,
        },
      ),
    );
  }

  async function createReader() {
    const [reader] = await database.db
      .insert(account)
      .values({ account: 'window-reader' })
      .returning();
    await database.db.insert(relationshipPair).values({
      kind: 'P2P',
      active: true,
      threadId,
      endpointAType: 'USER',
      endpointAAccount: 'window-reader',
      endpointADomain: 'local',
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: 'remote',
      endpointBDomain: peerDomain,
      endpointBNamespaceId: namespaceId,
      updatedAt: new Date(),
    });
    const [state] = await database.db
      .insert(accountThreadState)
      .values({ accountId: reader.id, threadId })
      .returning();
    return state;
  }

  it('sets read from the reserved local window start, not subsequent forward targets', async () => {
    const reader = await createReader();
    expect(reader).toMatchObject({
      lastReadSeq: 0,
      unreadCount: 0,
      previewSeqs: [],
    });
    await database.db
      .update(messageThread)
      .set({ curSeq: 10 })
      .where(eq(messageThread.id, threadId));
    await initializeTail(100);
    const read = () =>
      database.db.query.accountThreadState.findFirst({
        where: eq(accountThreadState.id, reader.id),
      });
    expect(await read()).toMatchObject({ lastReadSeq: 109, unreadCount: 0 });
    await initializeTail(200);
    expect(await read()).toMatchObject({ lastReadSeq: 109 });
    await database.db
      .update(messageThread)
      .set({ authorizationEpoch: 1, curSeq: 110 })
      .where(eq(messageThread.id, threadId));
    await initializeTail(200);
    expect(await read()).toMatchObject({ lastReadSeq: 210 });
  });

  it('rolls back read initialization with gap reservation and the source cursor', async () => {
    const reader = await createReader();
    const rollback = new Error('rollback window');
    await expect(
      database.db.transaction(async (tx) => {
        await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
          tx,
          {
            threadId,
            namespaceId,
            messageTargetSeq: 100,
            deletionTargetSeq: 0,
            reverseEnabled: true,
          },
        );
        expect(
          await tx.query.accountThreadState.findFirst({
            where: eq(accountThreadState.id, reader.id),
          }),
        ).toMatchObject({ lastReadSeq: 99 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: eq(accountThreadState.id, reader.id),
      }),
    ).toMatchObject({ lastReadSeq: 0, unreadCount: 0, previewSeqs: [] });
    expect(
      await database.db.query.federationThreadSyncState.findFirst({
        where: eq(federationThreadSyncState.threadId, threadId),
      }),
    ).toBeUndefined();
    expect(
      await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
      }),
    ).toMatchObject({ curSeq: 0 });
  });

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

  it('invalidates buffered facts on P2P deactivation without advancing the epoch on retries', async () => {
    await initializeTail(100);
    const state = await states.require(threadId, namespaceId);
    const [pair] = await database.db
      .insert(relationshipPair)
      .values({
        kind: 'P2P',
        endpointAType: 'USER',
        endpointAAccount: 'alice',
        endpointADomain: 'local',
        endpointANamespaceId: namespaceId,
        endpointBType: 'USER',
        endpointBAccount: 'bob',
        endpointBDomain: peerDomain,
        endpointBNamespaceId: namespaceId,
        threadId,
        active: true,
      })
      .returning();
    const change = (active: boolean, rollback = false) =>
      database.db.transaction(async (tx) => {
        await lockBusinessAccountsInTx(tx, [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: peerDomain },
        ]);
        await tx.execute(
          sql`SELECT id FROM "RelationshipPair" WHERE id = ${pair.id} FOR UPDATE`,
        );
        const changed = await setLockedP2PPairActiveInTx(tx, pair.id, active);
        if (rollback) throw new Error('abort deactivation');
        return changed;
      });
    await expect(change(false, true)).rejects.toThrow('abort deactivation');
    expect(
      (
        await database.db.query.messageThread.findFirst({
          where: eq(messageThread.id, threadId),
        })
      )?.authorizationEpoch,
    ).toBe(0);
    expect(
      (
        await database.db.query.relationshipPair.findFirst({
          where: eq(relationshipPair.id, pair.id),
        })
      )?.active,
    ).toBe(true);
    expect(await change(true)).toBe(false);
    expect(await change(false)).toBe(true);
    expect(await change(false)).toBe(false);
    expect(
      (
        await database.db.query.messageThread.findFirst({
          where: eq(messageThread.id, threadId),
        })
      )?.authorizationEpoch,
    ).toBe(1);
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
    expect(
      await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
      }),
    ).toMatchObject({ federationRoundsEnabled: false, authorizationEpoch: 1 });
    expect(await change(true)).toBe(true);
    expect(
      await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
      }),
    ).toMatchObject({ federationRoundsEnabled: true, authorizationEpoch: 1 });
    await expect(change(false, true)).rejects.toThrow('abort deactivation');
    expect(
      await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
      }),
    ).toMatchObject({ federationRoundsEnabled: true, authorizationEpoch: 1 });
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
        FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
          tx,
          {
            threadId,
            namespaceId: sourceNamespaceId,
            messageTargetSeq: 10,
            deletionTargetSeq: 2,
            reverseEnabled: false,
          },
        ),
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
          FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
            tx,
            {
              threadId,
              namespaceId: sourceNamespaceId,
              messageTargetSeq: 10,
              deletionTargetSeq: 0,
              reverseEnabled: true,
            },
          ),
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
