import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
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
  message,
  messageThread,
} from '../src/database/schema.js';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';

describe('federation thread synchronization state', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let states: FederationThreadSyncStateService;
  let threadId: number;
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
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'available',
    });
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning({ id: messageThread.id });
    threadId = thread.id;
  });

  async function initializeTail(messageTargetSeq: number): Promise<void> {
    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.reconcileThreadHeadInTx(tx, {
        threadId,
        peerDomain,
        messageTargetSeq,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      }),
    );
  }

  it('keeps the newest advertised message forward and creates an inclusive older gap', async () => {
    await initializeTail(100);

    await expect(states.require(threadId, peerDomain)).resolves.toMatchObject({
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
    const state = await states.require(threadId, peerDomain);
    const applyDependencies = vi.fn();

    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
        threadId,
        peerDomain,
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
            federationSourceDomain: peerDomain,
            creatorAccount: 'bob',
            creatorDomain: peerDomain,
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
    const state = await states.require(threadId, peerDomain);
    await database.db
      .update(messageThread)
      .set({ authorizationEpoch: 1 })
      .where(eq(messageThread.id, threadId));
    const applyDependencies = vi.fn();

    await expect(
      database.db.transaction((tx) =>
        FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
          threadId,
          peerDomain,
          authorizationEpoch: 0,
          gapId: state.activeGapId!,
          beforeSeq: 100,
          scannedThrough: 50,
          throughSeq: 1,
          closesGap: false,
          applyDependencies,
        }),
      ),
    ).rejects.toThrow('reverse round authorization epoch changed');

    expect(applyDependencies).not.toHaveBeenCalled();
    const [gap] = await database.db
      .select()
      .from(federationThreadHistoryGap)
      .where(eq(federationThreadHistoryGap.id, state.activeGapId!));
    expect(gap).toMatchObject({ startSeq: 1, endSeq: 99 });
  });

  it('deletes the final gap only after switching synchronization state to terminal', async () => {
    await initializeTail(2);
    const state = await states.require(threadId, peerDomain);

    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
        threadId,
        peerDomain,
        authorizationEpoch: 0,
        gapId: state.activeGapId!,
        beforeSeq: 2,
        scannedThrough: 1,
        throughSeq: 1,
        closesGap: true,
      }),
    );

    await expect(states.require(threadId, peerDomain)).resolves.toMatchObject({
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
    await expect(states.require(threadId, peerDomain)).rejects.toThrow(
      `federated thread ${threadId} has no synchronization state for ${peerDomain}`,
    );
  });
});
