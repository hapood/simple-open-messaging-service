import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federationThreadSyncState,
  message,
  messageThread,
  pendingMedia,
} from '../src/database/schema.js';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';

describe('federation thread synchronization state', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let states: FederationThreadSyncStateService;
  let threadId: number;

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
      'TRUNCATE TABLE "MessageThread" RESTART IDENTITY CASCADE',
    );
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning({ id: messageThread.id });
    threadId = thread.id;
  });

  it('initializes both directions at the advertised tail without moving committed boundaries later', async () => {
    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.mergeMessageTargetInTx(tx, threadId, 20),
    );
    await database.db.transaction((tx) =>
      FederationThreadSyncStateService.mergeMessageTargetInTx(tx, threadId, 25),
    );

    const state = await states.require(threadId);
    expect(state).toMatchObject({
      threadId,
      messageTargetSeq: 25,
      deletionTargetSeq: 0,
      messageProcessedThroughSeq: 0,
      deletionProcessedThroughSeq: 0,
      reverseNextBeforeSeq: 20,
      reverseClosureOriginSeq: null,
      historyBoundaryReached: false,
    });
  });

  it('rejects a missing state instead of fabricating a zero cursor', async () => {
    await expect(states.require(threadId)).rejects.toThrow(
      `federated mirror thread ${threadId} has no synchronization state`,
    );
  });

  it('derives a complete reusable reverse batch from distinct message and inbound pending coordinates', async () => {
    const now = new Date();
    await database.db.insert(message).values([
      {
        threadId,
        seq: 1,
        originSeq: 9,
        federationSourceDomain: 'upstream.test',
        creatorAccount: 'alice',
        creatorDomain: 'upstream.test',
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'nine' }),
        updatedAt: now,
      },
      {
        threadId,
        seq: 2,
        originSeq: 8,
        federationSourceDomain: 'upstream.test',
        creatorAccount: 'alice',
        creatorDomain: 'upstream.test',
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'eight' }),
        updatedAt: now,
      },
    ]);
    await database.db.insert(pendingMedia).values([
      {
        threadId,
        originSeq: 8,
        federationSourceDomain: 'upstream.test',
        originDomain: 'upstream.test',
        creatorAccount: 'alice',
        creatorDomain: 'upstream.test',
        contentType: 'IMAGE',
        content: '[]',
        direction: 'INBOUND',
        updatedAt: now,
      },
      {
        threadId,
        originSeq: 7,
        federationSourceDomain: 'upstream.test',
        originDomain: 'upstream.test',
        creatorAccount: 'bob',
        creatorDomain: 'upstream.test',
        contentType: 'IMAGE',
        content: '[]',
        direction: 'INBOUND',
        updatedAt: now,
      },
      {
        threadId,
        originSeq: 6,
        federationSourceDomain: 'upstream.test',
        creatorAccount: 'alice',
        creatorDomain: 'upstream.test',
        contentType: 'IMAGE',
        content: '[]',
        direction: 'OUTBOUND',
        updatedAt: now,
      },
    ]);

    await database.db.insert(federationThreadSyncState).values({
      threadId,
      messageTargetSeq: 10,
      deletionTargetSeq: 0,
      reverseNextBeforeSeq: 10,
      reverseClosureOriginSeq: null,
    });

    await expect(
      states.deriveReusableReverseBatch({
        threadId,
        beforeSeq: 10,
        closureOriginSeq: null,
        take: 3,
      }),
    ).resolves.toEqual({
      sourceSeqs: [9, 8, 7],
      batchOldestSeq: 7,
      reachedClosureTarget: false,
      canSkipMessageQuery: true,
    });

    await expect(
      states.deriveReusableReverseBatch({
        threadId,
        beforeSeq: 9,
        closureOriginSeq: null,
        take: 3,
      }),
    ).resolves.toEqual({
      sourceSeqs: [8, 7],
      batchOldestSeq: null,
      reachedClosureTarget: false,
      canSkipMessageQuery: false,
    });

    const [stored] = await database.db
      .select()
      .from(federationThreadSyncState)
      .where(eq(federationThreadSyncState.threadId, threadId));
    expect(stored.reverseNextBeforeSeq).toBe(10);
  });
});
