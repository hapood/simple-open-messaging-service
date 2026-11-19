import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { truncateTablesForTest } from './support/truncate.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  fileSyncProgress,
  identityNamespace,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  pendingMedia,
  uploadSession,
} from '../src/database/schema.js';
import { MediaCatalogService } from '../src/media/media-catalog.service.js';
import { MediaMaintenanceService } from '../src/media/media-maintenance.service.js';
import { UploadService } from '../src/upload/upload.service.js';
import {
  publishMediaAsset,
  MediaAssetService,
} from '../src/upload/media-asset.service.js';
import { MediaMetadataService } from '../src/upload/media-metadata.service.js';
import { FederationInboundFileSync } from '../src/federation/federation-inbound-file-sync.js';
import { createHash } from 'node:crypto';
import { ResumableUploadService } from '../src/upload/resumable-upload.service.js';
import { UploadActivityService } from '../src/upload/upload-activity.service.js';
import { MessageService } from '../src/message/message.service.js';
import { UserQuotaService } from '../src/quota/user-quota.service.js';
import { FederationDownloadScheduler } from '../src/federation/federation-download-scheduler.js';
import { FederationMediaTransferService } from '../src/federation/federation-media-transfer.service.js';
import { FederationInboundMediaBatchService } from '../src/federation/federation-inbound-media-batch.service.js';
import { withMessageDigest } from './support/message-fixture.js';
import { DashboardService } from '../src/admin/dashboard.service.js';
import { restageInboundMedia } from '../src/federation/media/restage-inbound-media.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

describe('Privacy-safe media administration', () => {
  let module: TestingModule;
  let database: DatabaseService;
  let catalog: MediaCatalogService;
  let maintenance: MediaMaintenanceService;
  let upload: UploadService;
  let root: string;
  let userId: number;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = module.get(DatabaseService);
    catalog = new MediaCatalogService(database);
    root = await mkdtemp(join(tmpdir(), 'soms-media-admin-'));
    upload = new UploadService({} as never, {} as never);
    Object.defineProperties(upload, {
      casDir: { value: join(root, 'cas') },
      casTmpDir: { value: join(root, 'tmp') },
    });
    maintenance = new MediaMaintenanceService(
      database,
      upload,
      new FederationDownloadScheduler(database),
    );
  });
  afterAll(async () => {
    await module?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE "MessageThread", "UploadSession", "FileSyncProgress", "MediaAsset", "Account" RESTART IDENTITY CASCADE',
    );
    await rm(root, { recursive: true, force: true });
    await mkdir(upload.casTmpDir, { recursive: true });
    const [user] = await database.db
      .insert(account)
      .values({ account: 'alice' })
      .returning({ id: account.id });
    userId = user.id;
  });

  async function authoredAsset(digest: string) {
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P' })
      .returning({ id: messageThread.id });
    const [row] = await database.db
      .insert(message)
      .values(
        withMessageDigest({
          threadId: thread.id,
          seq: 1,
          contentType: 'FILE',
          creatorAccount: 'alice',
          content: JSON.stringify({
            url: `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
            name: 'private-contract.pdf',
            size: 32,
          }),
        }),
      )
      .returning({ id: message.id });
    await database.db
      .insert(messageAsset)
      .values({ messageId: row.id, threadId: thread.id, digest });
    return row;
  }

  it('records confirmed integrity cleanup and retries the same download from zero', async () => {
    const bytes = Buffer.from('verified download');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const owner = await authoredAsset(digest);
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        domain: 'integrity-peer.test',
        signingKeyCreatedAt: 1,
        rootPublicKey: Buffer.alloc(32, 6).toString('base64'),
        identityPinnedAt: new Date(),
      })
      .returning({ id: identityNamespace.id });
    const batchId = '33333333-3333-4333-8333-333333333333';
    const [task] = await database.db
      .insert(fileSyncProgress)
      .values({
        messageId: owner.id,
        batchId,
        digest,
        kind: 'FILE',
        bytesTotal: BigInt(bytes.length),
        publisherNamespaceId: namespace.id,
        originDomain: 'peer.test',
      })
      .returning();
    const storage = new UploadService(
      new MediaAssetService(database),
      new MediaMetadataService(),
    );
    Object.defineProperties(storage, {
      casDir: { value: upload.casDir },
      casTmpDir: { value: upload.casTmpDir },
      thumbnailDir: { value: join(root, 'thumbnails') },
    });
    const quota = {
      assertFileSize: async () => 1024,
      claimFile: async () => {},
      isExhausted: async () => false,
    };
    const scheduler = new FederationDownloadScheduler(database);
    const transfers = new FederationMediaTransferService(
      database,
      quota as never,
      storage,
      scheduler,
    );
    const sync = new FederationInboundFileSync(
      database,
      quota as never,
      transfers,
      {
        hasMediaFileProgressSubscriber: () => false,
        hasMediaMessageProgressSubscriber: () => false,
      } as never,
    );
    const run = (content: Buffer, offsets: number[]) =>
      sync.runBatch(
        batchId,
        async function* (_digest, offset) {
          offsets.push(offset);
          yield content.subarray(offset);
        },
        async () => {},
        async () => {},
      );
    await expect(run(Buffer.alloc(bytes.length), [])).rejects.toThrow(
      'CAS digest mismatch',
    );
    expect(
      await database.db.query.fileSyncProgress.findFirst({
        where: eq(fileSyncProgress.id, task.id),
      }),
    ).toMatchObject({
      status: 'FAILED',
      errorKind: expect.stringContaining('CAS digest mismatch'),
      bytesReceived: BigInt(bytes.length),
    });
    await expect(
      readFile(join(storage.casTmpDir, `${digest}.part`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // Retry reconstructs coordination without replacing the task. The absent
    // disk checkpoint, not the historical byte count, selects offset zero.
    const [failedMessage] = await database.db
      .update(message)
      .set({
        localState: 'FAILED',
        publisherNamespaceId: namespace.id,
        originSeq: 1,
        content: JSON.stringify({
          url: `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
          name: 'download.txt',
          size: bytes.length,
        }),
      })
      .where(eq(message.id, owner.id))
      .returning();
    expect(
      await restageInboundMedia(database, failedMessage, {
        peerDomain: 'peer.test',
        fromAccount: 'alice',
        fromDomain: 'peer.test',
        toAccount: 'bob',
        sourceSeq: 1,
      }),
    ).toMatchObject({ batchId, resetFiles: 1 });
    const offsets: number[] = [];
    await run(bytes, offsets);
    expect(offsets).toEqual([0]);
    expect(
      await database.db.query.fileSyncProgress.findFirst({
        where: eq(fileSyncProgress.id, task.id),
      }),
    ).toMatchObject({
      status: 'COMPLETED',
      bytesReceived: BigInt(bytes.length),
    });
    expect(
      await readFile(
        join(storage.casDir, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(bytes);
    await sync.beforeApplicationShutdown();
  });

  it('starts from zero when shared artifacts are absent despite historical progress', async () => {
    const owner = await authoredAsset(digestA);
    await database.db.insert(fileSyncProgress).values({
      messageId: owner.id,
      batchId: '33333333-3333-4333-8333-333333333333',
      digest: digestA,
      kind: 'FILE',
      status: 'FAILED',
      bytesTotal: 32n,
      bytesReceived: 8n,
      errorKind: 'USER_STOPPED',
    });
    const scheduler = new FederationDownloadScheduler(database);
    const transfers = new FederationMediaTransferService(
      database,
      {
        assertFileSize: async () => 32,
        claimFile: async () => {},
      } as never,
      upload,
      scheduler,
    );
    let fetched = false;
    await expect(
      transfers.receive({
        namespaceId: 0,
        peerDomain: 'peer.test',
        digest: digestA,
        declaredBytes: 32,
        signal: new AbortController().signal,
        chunks: async function* (offset) {
          fetched = true;
          expect(offset).toBe(0);
          yield Buffer.alloc(8);
          throw new Error('transport disconnected');
        },
      }),
    ).rejects.toThrow('transport disconnected');
    expect(fetched).toBe(true);
    expect(await readFile(join(upload.casTmpDir, `${digestA}.part`))).toEqual(
      Buffer.alloc(8),
    );
    expect(
      (await database.db.query.fileSyncProgress.findFirst())?.bytesReceived,
    ).toBe(8n);
  });

  it('stops a task-owned download without temporary coordination and preserves completed siblings', async () => {
    await database.db
      .insert(mediaAsset)
      .values({ digest: digestA, bytes: 32n });
    const owner = await authoredAsset(digestA);
    await database.db
      .update(message)
      .set({ localState: 'STUB' })
      .where(eq(message.id, owner.id));
    const batchId = '33333333-3333-4333-8333-333333333333';
    await database.db.insert(fileSyncProgress).values([
      {
        batchId,
        messageId: owner.id,
        digest: digestA,
        kind: 'FILE',
        status: 'PENDING',
        bytesTotal: 32n,
        bytesReceived: 8n,
      },
      {
        batchId,
        messageId: owner.id,
        digest: digestB,
        kind: 'FILE',
        status: 'COMPLETED',
        bytesTotal: 32n,
        bytesReceived: 32n,
      },
    ]);
    const batches = new FederationInboundMediaBatchService(
      database,
      {
        stopBatch: async (_id: string, persist: () => Promise<void>) =>
          persist(),
      } as never,
      {} as never,
      {} as never,
      {
        hasMediaMessageProgressSubscriber: () => false,
        completeMediaMessageDownloadProgress: () => {},
      } as never,
    );
    await batches.stopInboundBatch(batchId);
    expect(await database.db.query.pendingMedia.findMany()).toEqual([]);
    expect(
      await database.db.query.message.findFirst({
        where: eq(message.id, owner.id),
      }),
    ).toMatchObject({ localState: 'FAILED' });
    const tasks = await database.db.query.fileSyncProgress.findMany();
    expect(tasks.find((task) => task.digest === digestA)).toMatchObject({
      status: 'FAILED',
      errorKind: 'USER_STOPPED',
      bytesReceived: 8n,
    });
    expect(tasks.find((task) => task.digest === digestB)).toMatchObject({
      status: 'COMPLETED',
      errorKind: null,
      bytesReceived: 32n,
    });
  });

  it.each(['PENDING', 'FAILED'] as const)(
    'retains shared checkpoints for a %s owner and recovers cleanup from completed task history',
    async (status) => {
      await database.db
        .insert(mediaAsset)
        .values({ digest: digestA, bytes: 32n });
      const first = await authoredAsset(digestA);
      const second = await authoredAsset(digestA);
      await database.db.insert(fileSyncProgress).values([
        {
          batchId: '11111111-1111-4111-8111-111111111111',
          messageId: first.id,
          digest: digestA,
          kind: 'FILE',
          status: 'COMPLETED',
          bytesTotal: 32n,
          bytesReceived: 32n,
        },
        {
          batchId: '22222222-2222-4222-8222-222222222222',
          messageId: second.id,
          digest: digestA,
          kind: 'FILE',
          status,
          bytesTotal: 32n,
        },
      ]);
      const transfers = new FederationMediaTransferService(
        database,
        {} as never,
        upload,
        new FederationDownloadScheduler(database),
      );
      const part = join(upload.casTmpDir, `${digestA}.part`);
      const checkpoint = join(upload.casTmpDir, `${digestA}.resume.json`);
      await writeFile(part, 'retained');
      await writeFile(checkpoint, '{}');
      const published = upload.casTarget(digestA).abs;
      await mkdir(join(root, 'cas', 'aa', 'aa'), { recursive: true });
      await writeFile(published, Buffer.alloc(32));
      await transfers.cleanupCompletedDownload(digestA);
      expect(await readFile(part, 'utf8')).toBe('retained');
      await database.db
        .update(fileSyncProgress)
        .set({ status: 'COMPLETED', errorKind: null, bytesReceived: 32n })
        .where(eq(fileSyncProgress.messageId, second.id));
      expect(await database.db.query.pendingMedia.findMany()).toEqual([]);
      await transfers.recoverCompletedDownloads(new AbortController().signal);
      await expect(readFile(part)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(checkpoint)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const tasks = await database.db.query.fileSyncProgress.findMany();
      expect(tasks).toHaveLength(2);
      expect(tasks.every((row) => row.status === 'COMPLETED')).toBe(true);
    },
  );

  it('paginates unique CAS files, filters user associations, and never projects content metadata', async () => {
    await database.db.insert(mediaAsset).values([
      { digest: digestA, bytes: 32n },
      { digest: digestB, bytes: 64n, isDeleted: true },
    ]);
    await authoredAsset(digestA);
    await authoredAsset(digestA);
    const page = await catalog.files({ take: 1 });
    expect(page.total).toBe(2);
    expect(page.bytes).toBe('96');
    expect(page.list).toHaveLength(1);
    expect(page.list[0]).toEqual({
      digest: digestA,
      bytes: '32',
      status: 'available',
      users: [{ account: 'alice', namespaceId: 0 }],
      userCount: 1,
    });
    expect(JSON.stringify(page)).not.toContain('private-contract');
    expect(
      await catalog.annotateRuntime([{ digest: digestA, status: 'active' }]),
    ).toEqual([
      {
        digest: digestA,
        status: 'active',
        users: [{ account: 'alice', namespaceId: 0 }],
        userCount: 1,
      },
    ]);
    const filtered = await catalog.files({ userId });
    expect(filtered.total).toBe(1);
    expect(filtered.bytes).toBe('32');
    expect((await catalog.files({ skip: 99 })).list).toEqual([]);
    expect((await catalog.files({ status: 'reclaimed' })).list[0].digest).toBe(
      digestB,
    );
  });

  it.each(['PENDING', 'COMPLETED', 'FAILED'] as const)(
    'requires a retained message owner for %s download tasks',
    async (status) => {
      const owner = await authoredAsset(digestA);
      const batchId = '00000000-0000-4000-8000-000000000001';
      // Exercise the migrated database directly, bypassing TypeScript's required field.
      await expect(
        database.pool.query(
          'INSERT INTO "FileSyncProgress" ("batchId", digest, kind, status) VALUES ($1, $2, $3, $4)',
          [batchId, digestA, 'FILE', status],
        ),
      ).rejects.toMatchObject({ code: '23502', column: 'messageId' });
      const [task] = await database.db
        .insert(fileSyncProgress)
        .values({
          batchId,
          messageId: owner.id,
          digest: digestA,
          kind: 'FILE',
          status,
        })
        .returning({ id: fileSyncProgress.id });
      await expect(
        database.pool.query(
          'UPDATE "FileSyncProgress" SET "messageId" = NULL WHERE id = $1',
          [task.id.toString()],
        ),
      ).rejects.toMatchObject({ code: '23502', column: 'messageId' });
      // Isolate the task FK from the independently restrictive asset-usage FK.
      await database.db
        .delete(messageAsset)
        .where(eq(messageAsset.messageId, owner.id));
      await expect(
        database.pool.query('DELETE FROM "Message" WHERE id = $1', [
          owner.id.toString(),
        ]),
      ).rejects.toMatchObject({
        code: '23001',
        constraint: 'FileSyncProgress_messageId_fkey',
      });
      await database.db
        .update(message)
        .set({ isDeleted: true })
        .where(eq(message.id, owner.id));
      expect(
        await database.db.query.fileSyncProgress.findFirst({
          where: eq(fileSyncProgress.id, task.id),
        }),
      ).toMatchObject({ messageId: owner.id, status });
    },
  );

  it('authorizes file progress from direct task ownership without temporary coordination', async () => {
    const owner = await authoredAsset(digestA);
    const other = await authoredAsset(digestA);
    await database.db
      .delete(messageAsset)
      .where(eq(messageAsset.messageId, owner.id));
    await database.db
      .delete(messageAsset)
      .where(eq(messageAsset.messageId, other.id));
    const ownerMessage = (await database.db.query.message.findFirst({
      where: eq(message.id, owner.id),
    }))!;
    const otherMessage = (await database.db.query.message.findFirst({
      where: eq(message.id, other.id),
    }))!;
    await database.db.insert(fileSyncProgress).values({
      messageId: owner.id,
      batchId: '00000000-0000-4000-8000-000000000001',
      digest: digestA,
      kind: 'FILE',
      status: 'FAILED',
      errorKind: 'USER_STOPPED',
    });
    const messages = new MessageService(database, {} as never, {} as never);
    await expect(
      messages.hasMessageMediaDigest(
        ownerMessage.threadId,
        ownerMessage.seq,
        digestA,
      ),
    ).resolves.toBe(true);
    await expect(
      messages.hasMessageMediaDigest(
        otherMessage.threadId,
        otherMessage.seq,
        digestA,
      ),
    ).resolves.toBe(false);
    await expect(
      messages.hasMessageMediaDigest(
        ownerMessage.threadId,
        ownerMessage.seq,
        digestB,
      ),
    ).resolves.toBe(false);
    await database.db
      .update(message)
      .set({ isDeleted: true })
      .where(eq(message.id, owner.id));
    await expect(
      messages.hasMessageMediaDigest(
        ownerMessage.threadId,
        ownerMessage.seq,
        digestA,
      ),
    ).resolves.toBe(false);
  });

  it('counts download batches from task outcomes without temporary coordination', async () => {
    const owner = await authoredAsset(digestA);
    const dashboard = new DashboardService(
      database,
      { snapshot: async () => ({ total: 0, uniqueUsers: 0 }) } as never,
      { resolve: async () => new Map() } as never,
    );
    expect((await dashboard.summary()).transfers).toMatchObject({
      activeDownloads: 0,
      failedTransfers: 0,
    });
    const batches = [
      ['PENDING', 'PENDING', 'COMPLETED'],
      ['FAILED', 'PENDING', 'FAILED'],
      ['COMPLETED', 'COMPLETED'],
    ] as const;
    for (const [index, statuses] of batches.entries()) {
      await database.db.insert(fileSyncProgress).values(
        statuses.map((status, position) => ({
          messageId: owner.id,
          batchId: `00000000-0000-4000-8000-00000000000${index + 1}`,
          digest: position === 0 ? digestA : digestB,
          kind: 'FILE' as const,
          status,
          errorKind: status === 'FAILED' ? 'USER_STOPPED' : null,
        })),
      );
    }
    expect((await dashboard.summary()).transfers).toMatchObject({
      activeDownloads: 1,
      failedTransfers: 1,
    });
    // A stale coordinator is not another download and cannot override task outcomes.
    await database.db.insert(pendingMedia).values({
      direction: 'INBOUND',
      messageId: owner.id,
      batchId: '00000000-0000-4000-8000-000000000009',
      status: 'failed',
      fileCnt: 99,
      originDomain: 'peer.test',
      publisherNamespaceId: 0,
      expectedAuthorizationEpoch: 0,
    });
    expect((await dashboard.summary()).transfers).toMatchObject({
      activeDownloads: 1,
      failedTransfers: 1,
    });
  });

  it('derives completed history from tasks after their temporary stage is deleted', async () => {
    const row = await authoredAsset(digestA);
    const batchId = '00000000-0000-4000-8000-000000000001';
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        direction: 'INBOUND',
        messageId: row.id,
        batchId,
        status: 'pending',
        fileCnt: 3,
        originDomain: 'peer.test',
        publisherNamespaceId: 0,
        expectedAuthorizationEpoch: 0,
      })
      .returning({ id: pendingMedia.id });
    // A coordination row alone is not transfer history.
    expect((await catalog.batches({ userId })).total).toBe(0);
    await database.db.insert(fileSyncProgress).values(
      [digestA, digestB].map((digest) => ({
        batchId,
        messageId: row.id,
        digest,
        kind: 'FILE' as const,
        status: 'COMPLETED' as const,
        bytesTotal: 32n,
        bytesReceived: 32n,
      })),
    );
    await database.db.delete(pendingMedia).where(eq(pendingMedia.id, stage.id));
    const page = await catalog.batches({ userId, take: 1 });
    expect(page.total).toBe(1);
    expect(page.list[0]).toMatchObject({
      status: 'ready',
      completedFiles: 2,
      totalFiles: 2,
      bytesTotal: '64',
      bytesReceived: '64',
      files: [digestA, digestB].map((digest) => ({
        digest,
        status: 'COMPLETED',
        bytesTotal: '32',
        bytesReceived: '32',
      })),
    });
    expect(JSON.stringify(page)).not.toContain('private-contract');
  });

  it('reconstructs failed execution from the message even after temporary task rows were deleted', async () => {
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        domain: 'retry-peer.test',
        signingKeyCreatedAt: 1,
        rootPublicKey: Buffer.alloc(32, 5).toString('base64'),
        identityPinnedAt: new Date(),
      })
      .returning({ id: identityNamespace.id });
    const row = await authoredAsset(digestA);
    await database.db
      .update(message)
      .set({
        publisherNamespaceId: namespace.id,
        originSeq: 7,
        localState: 'FAILED',
      })
      .where(eq(message.id, row.id));
    const msg = (await database.db.query.message.findFirst({
      where: eq(message.id, row.id),
    }))!;
    const route = {
      peerDomain: 'retry-peer.test',
      fromAccount: 'alice',
      fromDomain: 'retry-peer.test',
      toAccount: 'bob',
      sourceSeq: 7,
    };
    const first = await restageInboundMedia(database, msg, route);
    expect(first?.resetFiles).toBe(1);
    expect(
      (await database.db.query.fileSyncProgress.findMany())[0],
    ).toMatchObject({
      digest: digestA,
      bytesTotal: 32n,
      status: 'PENDING',
      payload: {
        fromAccount: 'alice',
        fromDomain: 'retry-peer.test',
        toAccount: 'bob',
      },
    });
    await database.db
      .update(message)
      .set({ localState: 'FAILED' })
      .where(eq(message.id, row.id));
    await database.db
      .update(pendingMedia)
      .set({ status: 'failed' })
      .where(eq(pendingMedia.batchId, first!.batchId));
    await database.db
      .update(fileSyncProgress)
      .set({ status: 'FAILED', bytesReceived: 8n })
      .where(eq(fileSyncProgress.batchId, first!.batchId));
    // Losing coordination must not create a new batch or abandon retained task progress.
    await database.db
      .delete(pendingMedia)
      .where(eq(pendingMedia.batchId, first!.batchId));
    const retainedTasks = await database.db.query.fileSyncProgress.findMany();
    const retried = await restageInboundMedia(database, msg, route);
    expect(retried?.batchId).toBe(first!.batchId);
    const afterRetry = await database.db.query.fileSyncProgress.findMany();
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]).toMatchObject({
      id: retainedTasks[0].id,
      bytesReceived: 8n,
      status: 'PENDING',
    });
    await database.db
      .delete(fileSyncProgress)
      .where(eq(fileSyncProgress.batchId, first!.batchId));
    await database.db
      .delete(pendingMedia)
      .where(eq(pendingMedia.batchId, first!.batchId));
    await database.db
      .update(message)
      .set({ localState: 'FAILED' })
      .where(eq(message.id, row.id));
    const rebuilt = await restageInboundMedia(database, msg, route);
    expect(rebuilt?.batchId).not.toBe(first?.batchId);
    expect(
      (await database.db.query.fileSyncProgress.findMany())[0].digest,
    ).toBe(digestA);
  });

  it('refuses to reclaim a shared referenced asset without modifying references or bytes', async () => {
    await database.db
      .insert(mediaAsset)
      .values({ digest: digestA, bytes: 32n });
    await authoredAsset(digestA);
    const path = upload.casPath(digestA)!;
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'retained');
    await expect(maintenance.reclaim(digestA)).rejects.toThrow('references');
    expect(await readFile(path, 'utf8')).toBe('retained');
    expect(
      (
        await database.db.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digestA),
        })
      )?.isDeleted,
    ).toBe(false);
  });

  it('reclaims an unreferenced formal file but keeps its database asset record', async () => {
    await database.db
      .insert(mediaAsset)
      .values({ digest: digestA, bytes: 32n });
    const path = upload.casPath(digestA)!;
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'unused');
    await expect(maintenance.reclaim(digestA)).resolves.toEqual({
      reclaimed: true,
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await database.db.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digestA),
        })
      )?.isDeleted,
    ).toBe(true);
  });

  it('serializes physical publication and reclamation across independent database transactions', async () => {
    const path = upload.casPath(digestA)!;
    await mkdir(join(path, '..'), { recursive: true });
    let published!: () => void;
    const publicationReady = new Promise<void>((resolve) => {
      published = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publication = publishMediaAsset(database, digestA, 4n, async () => {
      await writeFile(path, 'data');
      published();
      await gate;
    });
    await publicationReady;
    const reclamation = maintenance.reclaim(digestA);
    release();
    await publication;
    await expect(reclamation).resolves.toEqual({ reclaimed: true });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await publishMediaAsset(database, digestA, 4n, async () => {
      await writeFile(path, 'data');
    });
    expect(await readFile(path, 'utf8')).toBe('data');
    expect(
      (
        await database.db.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digestA),
        })
      )?.isDeleted,
    ).toBe(false);
  });

  it('retains temporary data referenced by failed tasks and cleans orphaned artifacts', async () => {
    await writeFile(join(upload.casTmpDir, `${digestA}.part`), 'partial');
    await writeFile(join(upload.casTmpDir, `${digestA}.resume.json`), '{}');
    const owner = await authoredAsset(digestA);
    await database.db.insert(fileSyncProgress).values({
      messageId: owner.id,
      digest: digestA,
      kind: 'FILE',
      batchId: '00000000-0000-4000-8000-000000000001',
      status: 'FAILED',
    });
    await expect(maintenance.cleanTemporary(digestA)).resolves.toEqual({
      cleaned: false,
    });
    expect((await maintenance.temporary({ take: 1 })).list[0]).toMatchObject({
      digest: digestA,
      bytes: '9',
      status: 'temporary',
    });
    await database.db
      .delete(fileSyncProgress)
      .where(eq(fileSyncProgress.digest, digestA));
    await expect(maintenance.cleanTemporary(digestA)).resolves.toEqual({
      cleaned: true,
    });
    expect((await maintenance.temporary({})).total).toBe(0);
  });

  it('serializes reclamation with an uncommitted reference admission', async () => {
    await database.db
      .insert(mediaAsset)
      .values({ digest: digestA, bytes: 32n });
    const row = await authoredAsset(digestA);
    await database.db
      .delete(messageAsset)
      .where(eq(messageAsset.digest, digestA));
    let inserted!: () => void;
    const insertion = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admission = database.db.transaction(async (tx) => {
      const msg = await tx.query.message.findFirst({
        where: eq(message.id, row.id),
      });
      await tx.insert(messageAsset).values({
        messageId: row.id,
        threadId: msg!.threadId,
        digest: digestA,
      });
      inserted();
      await gate;
    });
    await insertion;
    const reclamation = expect(maintenance.reclaim(digestA)).rejects.toThrow(
      'references',
    );
    release();
    await admission;
    await reclamation;
    expect(
      (
        await database.db.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digestA),
        })
      )?.isDeleted,
    ).toBe(false);
  });

  it('stops an interrupted upload while preserving task history, staging and received bytes', async () => {
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P' })
      .returning({ id: messageThread.id });
    const clientMessageId = '10000000-0000-4000-8000-000000000002';
    const [stage] = await database.db
      .insert(pendingMedia)
      .values({
        direction: 'OUTBOUND',
        threadId: thread.id,
        creatorAccount: 'alice',
        contentType: 'FILE',
        content: '{}',
        clientMessageId,
      })
      .returning({ id: pendingMedia.id });
    const [session] = await database.db
      .insert(uploadSession)
      .values({
        pendingMediaId: stage.id,
        partId: '20000000-0000-4000-8000-000000000002',
        position: 0,
        partIntent: 'FILE',
        creatorId: userId,
        contentType: 'FILE',
        originalName: 'do-not-expose.txt',
        mimeType: 'text/plain',
        totalBytes: 32n,
      })
      .returning();
    const fixture = await Test.createTestingModule({
      providers: [
        ResumableUploadService,
        // This fixture borrows query access; only the suite owns the pool lifecycle.
        { provide: DatabaseService, useValue: { db: database.db } },
        { provide: UploadService, useValue: upload },
        { provide: MessageService, useValue: {} },
        { provide: UserQuotaService, useValue: {} },
        UploadActivityService,
      ],
    }).compile();
    onTestFinished(() => fixture.close());
    const resumable = fixture.get(ResumableUploadService);
    Object.defineProperty(resumable, 'tmpDir', { value: upload.casTmpDir });
    const path = join(upload.casTmpDir, `${session.tmpKey}.part`);
    await writeFile(path, 'partial');
    await writeFile(
      join(upload.casTmpDir, `${session.tmpKey}.resume.json`),
      JSON.stringify({ offset: 7 }),
    );
    const page = await resumable.listForAdmin({ userId });
    expect(page.total).toBe(1);
    expect(JSON.stringify(page)).not.toContain('do-not-expose');
    expect(page.list[0]).toMatchObject({
      digest: null,
      bytesReceived: '7',
      bytes: '32',
      userId,
    });
    await expect(
      resumable.stopForAdmin(session.id.toString()),
    ).resolves.toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_STOPPED',
      offset: 7,
    });
    expect(
      await database.db.query.uploadSession.findFirst({
        where: eq(uploadSession.id, session.id),
      }),
    ).toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_STOPPED',
      pendingMediaId: stage.id,
    });
    expect(
      await database.db.query.pendingMedia.findFirst({
        where: eq(pendingMedia.id, stage.id),
      }),
    ).toBeDefined();
    expect(await readFile(path, 'utf8')).toBe('partial');
  });

  it('prevents reclamation while a staged uploader owns the digest', async () => {
    await database.db
      .insert(mediaAsset)
      .values({ digest: digestA, bytes: 32n });
    await database.db.insert(uploadSession).values({
      partId: '20000000-0000-4000-8000-000000000001',
      position: 0,
      partIntent: 'FILE',
      creatorId: userId,
      contentType: 'FILE',
      originalName: 'secret.txt',
      mimeType: 'text/plain',
      totalBytes: 32n,
      digest: digestA,
      status: 'PENDING',
    });
    await expect(maintenance.reclaim(digestA)).rejects.toThrow(
      'references or active transfers',
    );
  });
});
