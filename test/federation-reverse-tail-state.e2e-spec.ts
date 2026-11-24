import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federationThreadSyncState,
  message,
  messageThread,
} from '../src/database/schema.js';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { seedFederatedPeerNamespace, seedUser } from './seed.js';
import { createTestApp } from './support/app.js';
import { withMessageDigest } from './support/message-fixture.js';

describe('reverse tail reservations and commit fencing', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });

  it('reserves the newest slot, fences advertisements before writes and preserves the accepted prefix', async () => {
    await seedUser(app, 'reverse-tail-author');
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      'reverse-tail.test',
    );
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 3, updatedAt: new Date() })
      .returning();
    const service = new FederationThreadSyncStateService(database);
    await database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, thread.id);
      await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
        tx,
        {
          threadId: thread.id,
          namespaceId,
          messageTargetSeq: 5,
          deletionTargetSeq: 0,
          reverseEnabled: true,
        },
      );
    });
    const first = await service.resolveReverseWindow(thread.id, namespaceId);
    expect(first).toMatchObject({
      beforeSeq: 6,
      throughSeq: 1,
      messageSeqOffset: 3,
    });
    expect(await service.readCurrentMessageSeq(thread.id, namespaceId)).toBe(0);
    await database.db.transaction(async (tx) => {
      const threadLock = await requireThreadContentLockInTx(tx, thread.id);
      await FederationThreadSyncStateService.updateThreadHeadInTx(tx, {
        threadId: thread.id,
        namespaceId,
        messageTargetSeq: 7,
        deletionTargetSeq: 0,
        threadLock,
      });
    });
    const writeMessages = vi.fn();
    const stale = () =>
      database.db.transaction(async (tx) => {
        await requireThreadContentLockInTx(tx, thread.id);
        return FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
          threadId: thread.id,
          namespaceId,
          authorizationEpoch: first!.authorizationEpoch,
          gapId: first!.gapId,
          beforeSeq: 6,
          throughSeq: 1,
          scannedThrough: 1,
          closesGap: true,
          writeMessages,
        });
      });
    await service.reserveReverseTail(thread.id, namespaceId);
    await expect(stale()).rejects.toThrow(
      'requested reverse gap boundary changed',
    );
    expect(writeMessages).not.toHaveBeenCalled();
    const current = await service.resolveReverseWindow(thread.id, namespaceId);
    expect(current).toMatchObject({
      beforeSeq: 8,
      throughSeq: 1,
      messageSeqOffset: 3,
    });
    await database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, thread.id);
      await FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
        threadId: thread.id,
        namespaceId,
        authorizationEpoch: current!.authorizationEpoch,
        gapId: current!.gapId,
        beforeSeq: 8,
        throughSeq: 1,
        scannedThrough: 7,
        closesGap: false,
        writeMessages: async () => {
          await tx.insert(message).values(
            withMessageDigest({
              threadId: thread.id,
              seq: 10,
              originSeq: 7,
              publisherNamespaceId: namespaceId,
              creatorAccount: 'reverse-tail-author',
              contentType: 'PURE_TEXT',
              content: '{"text":"tail"}',
              originServerTime: new Date(),
              updatedAt: new Date(),
            }),
          );
        },
      });
    });
    expect(
      await service.resolveReverseWindow(thread.id, namespaceId),
    ).toMatchObject({ beforeSeq: 7 });
    expect(await service.readCurrentMessageSeq(thread.id, namespaceId)).toBe(7);
    const reserved = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, thread.id),
    });
    expect(reserved?.curSeq).toBe(10);
    const state = await database.db.query.federationThreadSyncState.findFirst({
      where: eq(federationThreadSyncState.threadId, thread.id),
    });
    expect(state?.messageProcessedThroughSeq).toBe(0);
  });
});
