import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageDeleteType } from '../src/database/enums.js';
import {
  deletedMessage,
  federatedMessageTombstone,
  federatedPeer,
  federationDeletedCursor,
  fileSyncProgress,
  message,
  messageThread,
  pendingMedia,
  user,
} from '../src/database/schema.js';
import { DeletedMessageService } from '../src/message/deleted-message.service.js';
import { MessageService } from '../src/message/message.service.js';

describe('federated message deletion transaction ordering', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let deletions: DeletedMessageService;
  let threadId: number;
  let creatorId: number;

  const cursor = {
    peerDomain: 'peer.test',
    streamAccount: 'bob',
    streamKind: 'p2p-author',
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        DeletedMessageService,
        {
          provide: MessageService,
          useValue: {
            writeSystemMessageInTx: () => ({ message: {} }),
          },
        },
      ],
    }).compile();
    database = mod.get(DatabaseService);
    deletions = mod.get(DeletedMessageService);
  });

  afterAll(async () => mod.close());

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "User", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
    const now = new Date();
    await database.db.insert(federatedPeer).values({
      domain: 'peer.test',
      trustLevel: 'available',
    });
    const [creator] = await database.db
      .insert(user)
      .values({
        account: 'bob',
        name: 'Bob',
        domain: 'peer.test',
        updatedAt: now,
      })
      .returning({ id: user.id });
    creatorId = creator.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: now })
      .returning({ id: messageThread.id });
    threadId = thread.id;
  });

  async function apply(remoteDeletionSeq: number) {
    return deletions.applyFederated({
      threadId,
      messageSeq: 7,
      authorityDomain: 'peer.test',
      sourceDomain: 'peer.test',
      remoteDeletionSeq,
      type: MessageDeleteType.USER_RETRACTION,
      cursor,
      expectedFederationVersion: 0,
    });
  }

  /** The transaction core used by FederationService.storePulledMessage for the stable identity race.
   * Optional gates let the test prove lock ordering without timing assumptions. */
  async function insertIncoming(gates?: {
    locked: () => void;
    release: Promise<void>;
  }) {
    return database.db.transaction(async (tx) => {
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        threadId,
        'peer.test',
        7,
      );
      gates?.locked();
      if (gates) await gates.release;

      const tombstone = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(federatedMessageTombstone.threadId, threadId),
          eq(federatedMessageTombstone.sourceDomain, 'peer.test'),
          eq(federatedMessageTombstone.messageSeq, 7),
        ),
        columns: { type: true, sourceDomain: true },
      });
      const [{ curSeq: seq }] = await tx
        .update(messageThread)
        .set({ curSeq: sql`${messageThread.curSeq} + 1` })
        .where(eq(messageThread.id, threadId))
        .returning({ curSeq: messageThread.curSeq });
      const [created] = await tx
        .insert(message)
        .values({
          threadId,
          creatorAccount: 'bob',
          creatorDomain: 'peer.test',
          originSeq: 7,
          federationSourceDomain: 'peer.test',
          seq,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'federated' }),
          isDeleted: tombstone !== undefined,
          updatedAt: new Date(),
        })
        .returning({ seq: message.seq, isDeleted: message.isDeleted });
      if (tombstone) {
        await DeletedMessageService.ensureFactInTx(tx, {
          threadId,
          messageSeq: seq,
          type: tombstone.type,
          federationSourceDomain: tombstone.sourceDomain,
          updatedAt: new Date(),
        });
        await tx
          .delete(federatedMessageTombstone)
          .where(
            and(
              eq(federatedMessageTombstone.threadId, threadId),
              eq(federatedMessageTombstone.sourceDomain, 'peer.test'),
              eq(federatedMessageTombstone.messageSeq, 7),
            ),
          );
      }
      return created;
    });
  }

  async function persistedState() {
    const stored = await database.db.query.message.findFirst({
      where: and(
        eq(message.threadId, threadId),
        eq(message.creatorAccount, 'bob'),
        eq(message.creatorDomain, 'peer.test'),
        eq(message.originSeq, 7),
      ),
      columns: { seq: true, isDeleted: true },
    });
    const tombstones = await database.db
      .select()
      .from(federatedMessageTombstone)
      .where(eq(federatedMessageTombstone.threadId, threadId));
    const logs = await database.db
      .select()
      .from(deletedMessage)
      .where(eq(deletedMessage.threadId, threadId));
    const storedCursor =
      await database.db.query.federationDeletedCursor.findFirst({
        where: eq(federationDeletedCursor.threadId, threadId),
        columns: { committedThrough: true },
      });
    return { stored, tombstones, logs, cursor: storedCursor };
  }

  it('allocates deletion coordinates per thread without gaps on concurrent retries', async () => {
    const allocate = (targetMessageSeq: number) =>
      database.db.transaction((tx) =>
        DeletedMessageService.ensureFactInTx(tx, {
          threadId,
          messageSeq: targetMessageSeq,
          type: MessageDeleteType.USER_RETRACTION,
        }),
      );

    const retryResults = await Promise.all([allocate(7), allocate(7)]);
    expect(retryResults.map((result) => result.deletionSeq)).toEqual([1, 1]);
    expect(retryResults.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    await expect(allocate(9)).resolves.toEqual({
      deletionSeq: 2,
      created: true,
    });

    const [otherThread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning({ id: messageThread.id });
    await expect(
      database.db.transaction((tx) =>
        DeletedMessageService.ensureFactInTx(tx, {
          threadId: otherThread.id,
          messageSeq: 4,
          type: MessageDeleteType.MODERATION_REMOVAL,
        }),
      ),
    ).resolves.toEqual({ deletionSeq: 1, created: true });

    const [firstAllocator, secondAllocator] = await Promise.all([
      database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { deletionSeqAllocatedThrough: true },
      }),
      database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, otherThread.id),
        columns: { deletionSeqAllocatedThrough: true },
      }),
    ]);
    expect(firstAllocator?.deletionSeqAllocatedThrough).toBe(2);
    expect(secondAllocator?.deletionSeqAllocatedThrough).toBe(1);
  });

  it('keeps a later-arriving message deleted when the tombstone committed first', async () => {
    expect(await apply(10)).toBeNull();
    expect(await insertIncoming()).toMatchObject({ isDeleted: true });

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.messageSeq).toBe(state.stored?.seq);
    expect(state.logs[0]?.deletionSeq).toBe(1);
    expect(state.cursor?.committedThrough).toBe(10);
  });

  it('serializes a deletion behind an in-progress message insert and converges to deleted', async () => {
    let announceLocked!: () => void;
    let releaseInsert!: () => void;
    const locked = new Promise<void>((resolve) => (announceLocked = resolve));
    const release = new Promise<void>((resolve) => (releaseInsert = resolve));

    const inserting = insertIncoming({ locked: announceLocked, release });
    await locked;
    const deleting = apply(11);
    // The delete is now allowed to contend for the same advisory lock; releasing the holder establishes
    // the message-before-delete order without relying on a sleep or scheduler timing.
    releaseInsert();
    await expect(inserting).resolves.toMatchObject({ isDeleted: false });
    await expect(deleting).resolves.toMatchObject({
      deletionSeq: 1,
      messageSeq: 1,
    });

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.cursor?.committedThrough).toBe(11);
  });

  it('is idempotent and never regresses the remote deletion HWM', async () => {
    await insertIncoming();
    await apply(12);
    await apply(11);

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.deletionSeq).toBe(1);
    expect(state.cursor?.committedThrough).toBe(12);
  });

  it('turns a tombstoned STUB into a formal deletion and cancels its download', async () => {
    const [stub] = await database.db
      .insert(message)
      .values({
        threadId,
        seq: 1,
        creatorAccount: 'bob',
        creatorDomain: 'peer.test',
        contentType: 'IMAGE',
        content: JSON.stringify({ digest: 'a'.repeat(64) }),
        originSeq: 7,
        federationSourceDomain: 'peer.test',
        localState: 'STUB',
        updatedAt: new Date(),
      })
      .returning({ id: message.id });
    const [pending] = await database.db
      .insert(pendingMedia)
      .values({
        messageId: stub.id,
        direction: 'INBOUND',
        fileCnt: 1,
        originDomain: 'peer.test',
        expectedAuthorizationEpoch: 0,
        updatedAt: new Date(),
      })
      .returning({ batchId: pendingMedia.batchId });
    await database.db.insert(fileSyncProgress).values({
      batchId: pending.batchId,
      digest: 'a'.repeat(64),
      direction: 'INBOUND',
      kind: 'IMAGE',
      status: 'DOWNLOADING',
      bytesTotal: 100n,
      bytesReceived: 40n,
      originDomain: 'peer.test',
    });

    await apply(13);

    const retained = await database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.batchId, pending.batchId),
    });
    const progress = await database.db
      .select()
      .from(fileSyncProgress)
      .where(eq(fileSyncProgress.batchId, pending.batchId));
    expect(retained).toBeUndefined();
    expect(progress).toEqual([]);
    await expect(
      database.db.query.message.findFirst({
        where: eq(message.id, stub.id),
      }),
    ).resolves.toMatchObject({
      localState: 'STUB',
      isDeleted: true,
    });
    const facts = await database.db
      .select()
      .from(deletedMessage)
      .where(eq(deletedMessage.threadId, threadId));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ messageSeq: 1, deletionSeq: 1 });
  });
});
