import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
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
import { publishMediaAsset } from '../src/upload/media-asset.service.js';
import { ResumableUploadService } from '../src/upload/resumable-upload.service.js';
import { FederationDownloadScheduler } from '../src/federation/federation-download-scheduler.js';
import { withMessageDigest } from './support/message-fixture.js';
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
    await database.db.execute(
      sql`TRUNCATE "MessageThread", "UploadSession", "FileSyncProgress", "MediaAsset", "Account" RESTART IDENTITY CASCADE`,
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

  it('returns completed batch counts without fabricating historical byte progress', async () => {
    const row = await authoredAsset(digestA);
    await database.db.insert(pendingMedia).values({
      direction: 'INBOUND',
      messageId: row.id,
      status: 'ready',
      fileCnt: 3,
      originDomain: 'peer.test',
      publisherNamespaceId: 0,
      expectedAuthorizationEpoch: 0,
    });
    const page = await catalog.batches({ userId, take: 1 });
    expect(page.total).toBe(1);
    expect(page.list[0]).toMatchObject({
      status: 'ready',
      completedFiles: 3,
      totalFiles: 3,
      bytesTotal: null,
      bytesReceived: null,
      files: [],
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
    await restageInboundMedia(database, msg, route);
    expect(
      (await database.db.query.fileSyncProgress.findMany())[0].bytesReceived,
    ).toBe(8n);
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
    await database.db.insert(fileSyncProgress).values({
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

  it('stops an interrupted upload batch and physically deletes its sessions and temporary files', async () => {
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P' })
      .returning({ id: messageThread.id });
    const clientMessageId = '10000000-0000-4000-8000-000000000002';
    await database.db.insert(pendingMedia).values({
      direction: 'OUTBOUND',
      threadId: thread.id,
      creatorAccount: 'alice',
      contentType: 'FILE',
      content: '{}',
      clientMessageId,
    });
    const [session] = await database.db
      .insert(uploadSession)
      .values({
        clientMessageId,
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
    const resumable = new ResumableUploadService(
      database,
      upload,
      {
        discardStaged: async (_user: number, id: string) => {
          await database.db
            .delete(pendingMedia)
            .where(eq(pendingMedia.clientMessageId, id));
          return true;
        },
      } as never,
      {} as never,
    );
    Object.defineProperty(resumable, 'tmpDir', { value: upload.casTmpDir });
    const path = join(upload.casTmpDir, `${session.tmpKey}.part`);
    await writeFile(path, 'partial');
    await writeFile(
      join(upload.casTmpDir, `${session.tmpKey}.resume.json`),
      JSON.stringify({ version: 1, offset: 7 }),
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
    await expect(resumable.stopForAdmin(session.uploadId)).resolves.toEqual({
      removed: 1,
    });
    expect(await database.db.query.uploadSession.findMany()).toEqual([]);
    expect(await database.db.query.pendingMedia.findMany()).toEqual([]);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prevents reclamation while a staged uploader owns the digest', async () => {
    await database.db
      .insert(mediaAsset)
      .values({ digest: digestA, bytes: 32n });
    await database.db.insert(uploadSession).values({
      clientMessageId: '10000000-0000-4000-8000-000000000001',
      partId: '20000000-0000-4000-8000-000000000001',
      position: 0,
      partIntent: 'FILE',
      creatorId: userId,
      contentType: 'FILE',
      originalName: 'secret.txt',
      mimeType: 'text/plain',
      totalBytes: 32n,
      digest: digestA,
      status: 'COMPLETING',
    });
    await expect(maintenance.reclaim(digestA)).rejects.toThrow(
      'references or active transfers',
    );
  });
});
