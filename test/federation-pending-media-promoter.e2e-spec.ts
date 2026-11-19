import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import { FederationInboundMediaBatchService } from '../src/federation/federation-inbound-media-batch.service.js';
import { MediaCatalogService } from '../src/media/media-catalog.service.js';
import { truncateTablesForTest } from './support/truncate.js';

describe('FederationPendingMediaPromoter', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let promoter: FederationPendingMediaPromoter;
  let catalog: MediaCatalogService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [FederationPendingMediaPromoter, MediaCatalogService],
    }).compile();
    database = mod.get(DatabaseService);
    promoter = mod.get(FederationPendingMediaPromoter);
    catalog = mod.get(MediaCatalogService);
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

  it.each([false, true])(
    'settles task-owned failures without coordination and rechecks after the message lock (reset: %s)',
    async (reset) => {
      const [thread] = await database.db
        .insert(messageThread)
        .values({
          type: 'P2P',
          authorityNamespaceId: 0,
          curSeq: 1,
        })
        .returning({ id: messageThread.id });
      const [stub] = await database.db
        .insert(message)
        .values(
          withMessageDigest({
            threadId: thread.id,
            seq: 1,
            originSeq: 7,
            publisherNamespaceId: 0,
            profileNamespaceId: 0,
            creatorAccount: 'alice',
            contentType: 'FILE',
            content: JSON.stringify({
              url: `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`,
              name: 'file',
              size: 4,
            }),
            localState: 'STUB',
          }),
        )
        .returning({ id: message.id });
      const batchId = '77777777-7777-4777-8777-777777777777';
      await database.db.insert(fileSyncProgress).values({
        batchId,
        messageId: stub.id,
        digest: 'a'.repeat(64),
        kind: 'FILE',
        status: 'FAILED',
        errorKind: 'REMOTE_IO',
        bytesTotal: 4n,
        originDomain: 'peer.test',
        publisherNamespaceId: 0,
      });
      const sync = {
        runBatch: async (
          _id: string,
          _fetch: unknown,
          _promote: unknown,
          fail: (id: string) => Promise<void>,
        ) => fail(batchId),
      };
      const sse = {
        hasMediaMessageProgressSubscriber: () => false,
        completeMediaMessageDownloadProgress: vi.fn(),
      };
      const batches = new FederationInboundMediaBatchService(
        database,
        sync as never,
        promoter,
        {} as never,
        sse as never,
      );
      const connection = await database.pool.connect();
      let releaseLock!: () => void;
      const acquiringLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const transaction = database.db.transaction.bind(database.db);
      const spy = vi
        .spyOn(database.db, 'transaction')
        .mockImplementation((work) =>
          transaction(async (tx) => {
            const execute = tx.execute.bind(tx);
            tx.execute = ((query) => {
              releaseLock();
              return execute(query);
            }) as typeof tx.execute;
            return work(tx);
          }),
        );
      let execution: Promise<void> | undefined;
      try {
        await connection.query('BEGIN');
        await connection.query(
          'SELECT id FROM "Message" WHERE id = $1 FOR NO KEY UPDATE',
          [stub.id],
        );
        execution = batches.runFileSyncBatch(batchId, vi.fn());
        await acquiringLock;
        if (reset) {
          await connection.query(
            'UPDATE "FileSyncProgress" SET status = $1, "errorKind" = NULL WHERE "batchId" = $2',
            ['PENDING', batchId],
          );
        }
        await connection.query('COMMIT');
        await execution;
        expect(
          await database.db.query.message.findFirst({
            where: eq(message.id, stub.id),
          }),
        ).toMatchObject({ localState: reset ? 'STUB' : 'FAILED' });
        expect(
          await database.db.query.fileSyncProgress.findFirst({
            where: eq(fileSyncProgress.batchId, batchId),
          }),
        ).toMatchObject({
          status: reset ? 'PENDING' : 'FAILED',
          messageId: stub.id,
        });
        expect(await database.db.query.pendingMedia.findMany()).toEqual([]);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        try {
          await execution;
        } finally {
          spy.mockRestore();
        }
      }
    },
  );

  it('materializes a completed STUB after the thread authorization epoch changes', async () => {
    const digest = 'a'.repeat(64);
    const now = new Date();
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        signingKeyCreatedAt: 1700000000000,
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
      messageId: stub.id,
      digest,
      kind: 'IMAGE',
      status: 'COMPLETED',
      bytesTotal: 4n,
      bytesReceived: 4n,
      originDomain: 'peer.test',
      publisherNamespaceId: namespace.id,
    });

    // Transfer completion does not wait for message materialization or mirror its status.
    await expect(catalog.batches({ status: 'ready' })).resolves.toMatchObject({
      total: 1,
      list: [
        expect.objectContaining({
          batchId: pending.batchId,
          status: 'ready',
          totalFiles: 1,
          completedFiles: 1,
          bytesTotal: '4',
          bytesReceived: '4',
        }),
      ],
    });
    await expect(
      catalog.batches({ status: 'downloading' }),
    ).resolves.toMatchObject({ total: 0, list: [] });

    // A completed task for unrelated bytes cannot stand in for the message attachment.
    await database.db
      .update(fileSyncProgress)
      .set({ digest: 'b'.repeat(64) })
      .where(eq(fileSyncProgress.batchId, pending.batchId));
    await expect(promoter.promote(pending.batchId)).resolves.toBe(false);
    expect(
      await database.db.query.message.findFirst({
        where: eq(message.id, stub.id),
      }),
    ).toMatchObject({ localState: 'STUB' });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.batchId, pending.batchId),
      }),
    ).toBeDefined();
    expect(
      await database.db.query.messageAsset.findMany({
        where: eq(messageAsset.messageId, stub.id),
      }),
    ).toEqual([]);
    await database.db
      .update(fileSyncProgress)
      .set({ digest })
      .where(eq(fileSyncProgress.batchId, pending.batchId));

    const [otherMessage] = await database.db
      .insert(message)
      .values(
        withMessageDigest({
          threadId: thread.id,
          seq: 2,
          originSeq: 8,
          publisherNamespaceId: namespace.id,
          creatorAccount: 'alice',
          profileNamespaceId: namespace.id,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'another message' }),
          localState: 'READY',
        }),
      )
      .returning({ id: message.id });
    await database.db
      .update(fileSyncProgress)
      .set({ messageId: otherMessage.id })
      .where(eq(fileSyncProgress.batchId, pending.batchId));
    await expect(promoter.promote(pending.batchId)).rejects.toThrow(
      'contains a task owned by another message',
    );
    expect(
      await database.db.query.message.findFirst({
        where: eq(message.id, stub.id),
      }),
    ).toMatchObject({ localState: 'STUB' });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.batchId, pending.batchId),
      }),
    ).toBeDefined();
    await database.db
      .update(fileSyncProgress)
      .set({ messageId: stub.id })
      .where(eq(fileSyncProgress.batchId, pending.batchId));

    // A retry commits after the optimistic completion read but before promotion locks
    // the message. The locked recheck must observe the new durable task outcome.
    const transaction = database.db.transaction.bind(database.db);
    const retryRace = vi
      .spyOn(database.db, 'transaction')
      .mockImplementationOnce((work) =>
        transaction(async (tx) => {
          const execute = tx.execute.bind(tx);
          let firstRead = true;
          tx.execute = (async (...args: Parameters<typeof execute>) => {
            const result = await execute(...args);
            if (firstRead) {
              firstRead = false;
              await transaction(async (retryTx) => {
                await retryTx
                  .select()
                  .from(message)
                  .where(eq(message.id, stub.id))
                  .for('no key update');
                await retryTx
                  .update(fileSyncProgress)
                  .set({ status: 'PENDING' })
                  .where(eq(fileSyncProgress.batchId, pending.batchId));
              });
            }
            return result;
          }) as typeof tx.execute;
          return work(tx);
        }),
      );
    try {
      await expect(promoter.promote(pending.batchId)).resolves.toBe(false);
    } finally {
      retryRace.mockRestore();
    }
    expect(
      await database.db.query.message.findFirst({
        where: eq(message.id, stub.id),
      }),
    ).toMatchObject({ localState: 'STUB' });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.batchId, pending.batchId),
      }),
    ).toBeDefined();
    await database.db
      .update(fileSyncProgress)
      .set({ status: 'COMPLETED' })
      .where(eq(fileSyncProgress.batchId, pending.batchId));

    // Failure to remove coordination rolls back message and asset writes too.
    const deletionFailure = new Error('coordinator deletion failed');
    const transactionSpy = vi
      .spyOn(database.db, 'transaction')
      .mockImplementationOnce((work) =>
        transaction(async (tx) => {
          const remove = tx.delete.bind(tx);
          tx.delete = ((table: Parameters<typeof remove>[0]) => {
            if (table === pendingMedia) throw deletionFailure;
            return remove(table);
          }) as typeof tx.delete;
          return work(tx);
        }),
      );
    try {
      await expect(promoter.promote(pending.batchId)).rejects.toBe(
        deletionFailure,
      );
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      await database.db.query.message.findFirst({
        where: eq(message.id, stub.id),
      }),
    ).toMatchObject({ localState: 'STUB' });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.batchId, pending.batchId),
      }),
    ).toBeDefined();
    expect(
      await database.db.query.messageAsset.findMany({
        where: eq(messageAsset.messageId, stub.id),
      }),
    ).toEqual([]);
    expect(
      await database.db.query.fileSyncProgress.findFirst({
        where: eq(fileSyncProgress.batchId, pending.batchId),
      }),
    ).toMatchObject({ status: 'COMPLETED', messageId: stub.id });

    const promotions = await Promise.all([
      promoter.promote(pending.batchId),
      promoter.promote(pending.batchId),
    ]);
    expect(promotions.filter(Boolean)).toEqual([true]);
    expect(promotions.filter((effect) => effect === false)).toHaveLength(1);

    await expect(
      database.db.query.message.findFirst({
        where: eq(message.id, stub.id),
      }),
    ).resolves.toMatchObject({ localState: 'READY' });
    await expect(
      database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.batchId, pending.batchId),
      }),
    ).resolves.toBeUndefined();
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
    ).resolves.toEqual([
      expect.objectContaining({
        batchId: pending.batchId,
        digest,
        status: 'COMPLETED',
        bytesTotal: 4n,
        bytesReceived: 4n,
      }),
    ]);
    // Repeated message materialization neither recreates nor deletes the retained task.
    await expect(promoter.promote(pending.batchId)).resolves.toBe(false);
    const retained = await database.db.query.fileSyncProgress.findMany({
      where: eq(fileSyncProgress.batchId, pending.batchId),
    });
    expect(retained).toHaveLength(1);
    expect(retained[0].status).toBe('COMPLETED');

    // Simulate independent task outcomes after coordination has been removed.
    // Catalog status/filtering must depend only on retained tasks, not a batch marker.
    for (const outcome of [
      { status: 'PENDING', errorKind: null, display: 'pending' },
      { status: 'FAILED', errorKind: 'REMOTE_IO', display: 'failed' },
      { status: 'FAILED', errorKind: 'USER_STOPPED', display: 'stopped' },
    ] satisfies Array<{
      status: 'PENDING' | 'FAILED';
      errorKind: string | null;
      display: string;
    }>) {
      await database.db
        .update(fileSyncProgress)
        .set({ status: outcome.status, errorKind: outcome.errorKind })
        .where(eq(fileSyncProgress.batchId, pending.batchId));
      await expect(
        catalog.batches({ status: outcome.display }),
      ).resolves.toMatchObject({
        total: 1,
        list: [
          expect.objectContaining({
            status: outcome.display,
            totalFiles: 1,
            completedFiles: 0,
            files: [
              expect.objectContaining({
                status: outcome.status,
                errorKind: outcome.errorKind,
              }),
            ],
          }),
        ],
      });
      await expect(catalog.batches({ status: 'ready' })).resolves.toMatchObject(
        { total: 0, list: [] },
      );
    }
  });
});
