import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withMessageDigest } from './support/message-fixture.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  fileSyncProgress,
  identityNamespace,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  pendingMedia,
} from '../src/database/schema.js';
import { FederationPendingMediaPromoter } from '../src/federation/federation-pending-media-promoter.js';
import { truncateTablesForTest } from './support/truncate.js';

describe('FederationPendingMediaPromoter', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let promoter: FederationPendingMediaPromoter;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [FederationPendingMediaPromoter],
    }).compile();
    database = mod.get(DatabaseService);
    promoter = mod.get(FederationPendingMediaPromoter);
  });

  afterAll(async () => mod.close());

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "MessageThread" RESTART IDENTITY CASCADE; ' +
        `DO $$ DECLARE dependent regclass; BEGIN
          FOR dependent IN
            SELECT conrelid::regclass FROM pg_constraint
            WHERE confrelid = '"IdentityNamespace"'::regclass AND contype = 'f'
          LOOP
            EXECUTE format('DELETE FROM %s', dependent);
          END LOOP;
        END $$;
        DELETE FROM "IdentityNamespace" WHERE id <> 0;`,
    );
  });

  it('materializes a completed STUB after the thread authorization epoch changes', async () => {
    const digest = 'a'.repeat(64);
    const now = new Date();
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        domain: 'peer.test',
        rootPublicKey: Buffer.alloc(32, 4).toString('base64'),
        identityPinnedAt: now,
      })
      .returning({ id: identityNamespace.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        authorityNamespaceId: namespace.id,
        authorizationEpoch: 1,
        curSeq: 1,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    const [stub] = await database.db
      .insert(message)
      .values(
        withMessageDigest({
          threadId: thread.id,
          seq: 1,
          originSeq: 7,
          publisherNamespaceId: namespace.id,
          creatorAccount: 'alice',

          profileNamespaceId: namespace.id,
          contentType: 'IMAGE',
          content: JSON.stringify({
            url: `/uploads/msg-assets/aa/aa/${digest}`,
            name: 'pending.png',
            w: 1,
            h: 1,
          }),
          localState: 'STUB',
          updatedAt: now,
        }),
      )
      .returning({ id: message.id });
    const [pending] = await database.db
      .insert(pendingMedia)
      .values({
        messageId: stub.id,
        direction: 'INBOUND',
        status: 'downloading',
        fileCnt: 1,
        originDomain: 'peer.test',
        publisherNamespaceId: namespace.id,
        expectedAuthorizationEpoch: 0,
        updatedAt: now,
      })
      .returning({ batchId: pendingMedia.batchId });
    await database.db.insert(mediaAsset).values({ digest, bytes: 4n });
    await database.db.insert(fileSyncProgress).values({
      batchId: pending.batchId,
      digest,
      kind: 'IMAGE',
      status: 'SUCCEEDED',
      bytesTotal: 4n,
      bytesReceived: 4n,
      originDomain: 'peer.test',
      publisherNamespaceId: namespace.id,
    });

    await expect(promoter.promote(pending.batchId)).resolves.toEqual({
      dependentBatchIds: [],
    });

    await expect(
      database.db.query.message.findFirst({
        where: eq(message.id, stub.id),
      }),
    ).resolves.toMatchObject({ localState: 'READY' });
    await expect(
      database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.batchId, pending.batchId),
      }),
    ).resolves.toMatchObject({ status: 'ready', failReason: null });
    await expect(
      database.db
        .select({ digest: messageAsset.digest })
        .from(messageAsset)
        .where(eq(messageAsset.messageId, stub.id)),
    ).resolves.toEqual([{ digest }]);
    await expect(
      database.db
        .select()
        .from(fileSyncProgress)
        .where(eq(fileSyncProgress.batchId, pending.batchId)),
    ).resolves.toEqual([]);
  });
});
