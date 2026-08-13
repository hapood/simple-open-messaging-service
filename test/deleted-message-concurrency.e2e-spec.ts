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
      providers: [DeletedMessageService],
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
        isForeigner: true,
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

  async function apply(remoteDeletedId: bigint) {
    return deletions.applyFederated({
      threadId,
      creatorId,
      originSeq: 7,
      authorityDomain: 'peer.test',
      sourceDomain: 'peer.test',
      remoteDeletedId,
      type: MessageDeleteType.WITHDRAW,
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
        creatorId,
        7,
      );
      gates?.locked();
      if (gates) await gates.release;

      const tombstone = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(federatedMessageTombstone.threadId, threadId),
          eq(federatedMessageTombstone.creatorId, creatorId),
          eq(federatedMessageTombstone.originSeq, 7),
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
          creator: creatorId,
          originSeq: 7,
          seq,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'federated' }),
          isDeleted: tombstone !== undefined,
          updatedAt: new Date(),
        })
        .returning({ seq: message.seq, isDeleted: message.isDeleted });
      if (tombstone) {
        await tx
          .insert(deletedMessage)
          .values({
            threadId,
            seq,
            type: tombstone.type,
            federationSourceDomain: tombstone.sourceDomain,
            updatedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [deletedMessage.threadId, deletedMessage.seq],
          });
        await tx
          .delete(federatedMessageTombstone)
          .where(
            and(
              eq(federatedMessageTombstone.threadId, threadId),
              eq(federatedMessageTombstone.creatorId, creatorId),
              eq(federatedMessageTombstone.originSeq, 7),
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
        eq(message.creator, creatorId),
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
        columns: { deletedHwm: true },
      });
    return { stored, tombstones, logs, cursor: storedCursor };
  }

  it('keeps a later-arriving message deleted when the tombstone committed first', async () => {
    expect(await apply(10n)).toBeNull();
    expect(await insertIncoming()).toMatchObject({ isDeleted: true });

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.seq).toBe(state.stored?.seq);
    expect(state.cursor?.deletedHwm).toBe(10n);
  });

  it('serializes a deletion behind an in-progress message insert and converges to deleted', async () => {
    let announceLocked!: () => void;
    let releaseInsert!: () => void;
    const locked = new Promise<void>((resolve) => (announceLocked = resolve));
    const release = new Promise<void>((resolve) => (releaseInsert = resolve));

    const inserting = insertIncoming({ locked: announceLocked, release });
    await locked;
    const deleting = apply(11n);
    // The delete is now allowed to contend for the same advisory lock; releasing the holder establishes
    // the message-before-delete order without relying on a sleep or scheduler timing.
    releaseInsert();
    await expect(inserting).resolves.toMatchObject({ isDeleted: false });
    await expect(deleting).resolves.toMatchObject({ seq: 0 });

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.cursor?.deletedHwm).toBe(11n);
  });

  it('is idempotent and never regresses the remote deletion HWM', async () => {
    await insertIncoming();
    await apply(12n);
    await apply(11n);

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.cursor?.deletedHwm).toBe(12n);
  });

  it('terminates but retains an inbound pending download and its resumable progress', async () => {
    const [pending] = await database.db
      .insert(pendingMedia)
      .values({
        threadId,
        creatorId,
        contentType: 'IMAGE',
        content: JSON.stringify({ digest: 'a'.repeat(64) }),
        originSeq: 7,
        direction: 'INBOUND',
        fileCnt: 1,
        originDomain: 'peer.test',
        expectedFederationVersion: 0,
        status: 'pending',
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

    await apply(13n);

    const retained = await database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.batchId, pending.batchId),
    });
    const [progress] = await database.db
      .select()
      .from(fileSyncProgress)
      .where(eq(fileSyncProgress.batchId, pending.batchId));
    expect(retained).toMatchObject({
      status: 'tombstoned',
      anyFailed: true,
      failReason: 'SOURCE_MESSAGE_DELETED',
    });
    expect(progress).toMatchObject({
      status: 'TOMBSTONED',
      errorKind: 'SOURCE_MESSAGE_DELETED',
      bytesReceived: 40n,
    });
  });
});
