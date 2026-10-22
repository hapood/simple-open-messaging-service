import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { ContentType } from '../src/database/enums.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import { dataDirectory } from '../src/common/data-directory.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { FederationPeerResourceService } from '../src/federation/federation-peer-resource.service.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';
import { wirePayloadDigest } from '../src/federation/federated-message-content.js';
import { payloadDigest } from '../src/federation/canonical-json.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { withMessageDigest } from './support/message-fixture.js';

describe('group authority media authorization for a different member peer', () => {
  const suffix = Date.now().toString(36);
  const authorAccount = `media-author-${suffix}`;
  const readerAccount = `media-reader-${suffix}`;
  const authorDomain = `media-author-${suffix}.test`;
  const readerDomain = `media-reader-${suffix}.test`;
  const outsiderDomain = `media-outsider-${suffix}.test`;
  const bytes = Buffer.from(`group-media-${suffix}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  let path: string;
  let database: DatabaseService;
  let service: FederationPeerResourceService;
  let authorNs: number;
  let readerNs: number;
  let outsiderNs: number;
  let counter = 0;

  beforeAll(async () => {
    database = new DatabaseService();
    service = new FederationPeerResourceService(database, {} as never);
    authorNs = await seedFederatedPeerNamespace(database.db, authorDomain);
    readerNs = await seedFederatedPeerNamespace(database.db, readerDomain);
    outsiderNs = await seedFederatedPeerNamespace(database.db, outsiderDomain);
    path = dataDirectory('cas', digest.slice(0, 2), digest.slice(2, 4), digest);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await database.db
      .insert(tables.mediaAsset)
      .values({ digest, bytes: BigInt(bytes.length) });
  });

  afterAll(async () => {
    await rm(path, { force: true });
    await database.onApplicationShutdown();
  });

  async function fixture(mirror = false) {
    const groupAccount = `!media-${suffix}-${++counter}`;
    const [group] = mirror
      ? [{ id: null }]
      : await database.db
          .insert(tables.groupAccount)
          .values({ account: groupAccount, updatedAt: new Date() })
          .returning({ id: tables.groupAccount.id });
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'GROUP',
        groupAccount,
        groupAccountId: group.id,
        authorityNamespaceId: mirror ? authorNs : 0,
        curSeq: 5,
        updatedAt: new Date(),
      })
      .returning({ id: tables.messageThread.id });
    await database.db.insert(tables.groupMeta).values({ threadId: thread.id });
    await database.db.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      threadId: thread.id,
      endpointAType: 'GROUP',
      endpointAAccount: groupAccount,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: readerAccount,
      endpointBNamespaceId: readerNs,
      established: true,
      active: true,
    });
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: groupAccount,
      authorNamespaceId: 0,
      profileNamespaceId: 0,
      receiverAccount: readerAccount,
      receiverNamespaceId: readerNs,
      status: 'ACCEPTED',
      messageEndSeq: 5,
      tombstoneEndSeq: 0,
      profileRev: 0,
      requestedAt: new Date(),
    });
    await database.db.insert(tables.threadAudience).values({
      threadId: thread.id,
      targetNamespaceId: readerNs,
    });
    await database.db.insert(tables.peerStateFeed).values({
      namespaceId: readerNs,
      account: groupAccount,
      eventType: 'THREAD_CONTENT_HEAD',
      feedId: BigInt(counter),
      body: { messageEndSeq: 5, tombstoneEndSeq: 0 },
      updatedAt: new Date(),
    });
    const [message] = await database.db
      .insert(tables.message)
      .values(
        withMessageDigest({
          threadId: thread.id,
          seq: 5,
          originSeq: 7,
          creatorAccount: authorAccount,
          publisherNamespaceId: authorNs,
          profileNamespaceId: 0,
          contentType: 'FILE',
          content: JSON.stringify({
            url: `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
            size: bytes.length,
            name: 'asset.bin',
            mimeType: 'application/octet-stream',
          }),
          localState: 'READY',
          updatedAt: new Date(),
        }),
      )
      .returning({ id: tables.message.id });
    await database.db
      .insert(tables.messageAsset)
      .values({ messageId: message.id, threadId: thread.id, digest });
    const download = (
      ns = readerNs,
      domain = readerDomain,
      requestedDigest = digest,
      seq = 5,
    ) =>
      service.resolveMediaFile(
        authorAccount,
        groupAccount,
        authorDomain,
        domain,
        ns,
        requestedDigest,
        seq,
      );
    return {
      groupAccount,
      groupId: group.id,
      threadId: thread.id,
      messageId: message.id,
      download,
    };
  }

  it('serves the exact file to another member peer despite different author and reader namespaces', async () => {
    const value = await fixture();
    expect(authorNs).not.toBe(readerNs);
    const result = await value.download();
    expect(result).toEqual({ absPath: path, bytes: bytes.length });
    expect(await readFile(result.absPath)).toEqual(bytes);
  });

  it('rejects a non-member even when it has a retained audience row', async () => {
    const value = await fixture();
    await database.db.insert(tables.threadAudience).values({
      threadId: value.threadId,
      targetNamespaceId: outsiderNs,
    });
    await expect(
      value.download(outsiderNs, outsiderDomain),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
  });

  it('rejects a revoked reader direction despite retained audience and message rows', async () => {
    const value = await fixture();
    await database.db
      .update(tables.relationshipIntent)
      .set({ status: 'REVOKED' })
      .where(eq(tables.relationshipIntent.authorAccount, value.groupAccount));
    await expect(value.download()).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
  });

  it('enforces both the history floor and the published message head', async () => {
    const value = await fixture();
    await database.db
      .update(tables.threadAudience)
      .set({ messageAccessAfterSeq: 5 })
      .where(eq(tables.threadAudience.threadId, value.threadId));
    await expect(value.download()).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
    await database.db
      .update(tables.threadAudience)
      .set({ messageAccessAfterSeq: 0 })
      .where(eq(tables.threadAudience.threadId, value.threadId));
    await database.db
      .update(tables.peerStateFeed)
      .set({ body: { messageEndSeq: 4 } })
      .where(
        and(
          eq(tables.peerStateFeed.account, value.groupAccount),
          eq(tables.peerStateFeed.namespaceId, readerNs),
        ),
      );
    await expect(value.download()).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
  });

  it('rejects withdrawn messages, incorrect message coordinates, and unrelated digests', async () => {
    const value = await fixture();
    await expect(
      value.download(readerNs, readerDomain, 'f'.repeat(64)),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    await expect(
      value.download(readerNs, readerDomain, digest, 7),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
    await database.db
      .update(tables.message)
      .set({ isDeleted: true })
      .where(eq(tables.message.id, value.messageId));
    await expect(value.download()).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
  });

  it('rejects dissolved groups even with retained positive intent and audience rows', async () => {
    const value = await fixture();
    await database.db
      .update(tables.groupAccount)
      .set({ dissolvedAt: new Date() })
      .where(eq(tables.groupAccount.id, value.groupId!));
    await expect(value.download()).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
  });

  it('lets a mirror serve its own submission only to the authenticated group origin', async () => {
    const value = await fixture(true);
    const [local] = await database.db
      .insert(tables.account)
      .values({
        account: authorAccount,
        namespaceId: 0,
        updatedAt: new Date(),
      })
      .returning({ id: tables.account.id });
    await database.db.insert(tables.accountThreadState).values({
      accountId: local.id,
      threadId: value.threadId,
      role: 'MEMBER',
    });
    await database.db.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      threadId: value.threadId,
      endpointAType: 'USER',
      endpointAAccount: authorAccount,
      endpointANamespaceId: 0,
      endpointBType: 'GROUP',
      endpointBAccount: value.groupAccount,
      endpointBNamespaceId: authorNs,
      active: true,
      established: true,
    });
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: value.groupAccount,
      authorNamespaceId: authorNs,
      receiverAccount: authorAccount,
      receiverNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 0,
      status: 'ACCEPTED',
      messageEndSeq: 5,
      tombstoneEndSeq: 0,
      requestedAt: new Date(),
    });
    await database.db
      .update(tables.message)
      .set({ publisherNamespaceId: 0 })
      .where(eq(tables.message.id, value.messageId));
    await expect(value.download(authorNs, authorDomain)).resolves.toEqual({
      absPath: path,
      bytes: bytes.length,
    });
    await expect(value.download()).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
    await database.db
      .update(tables.message)
      .set({ publisherNamespaceId: readerNs })
      .where(eq(tables.message.id, value.messageId));
    await expect(value.download(authorNs, authorDomain)).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
  });

  it('returns an accepted media receipt before client localization and still filters deletion', async () => {
    const value = await fixture();
    await database.db.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      threadId: value.threadId,
      endpointAType: 'GROUP',
      endpointAAccount: value.groupAccount,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: authorAccount,
      endpointBNamespaceId: authorNs,
      active: true,
      established: true,
    });
    await database.db.insert(tables.relationshipIntent).values({
      authorAccount: value.groupAccount,
      authorNamespaceId: 0,
      receiverAccount: authorAccount,
      receiverNamespaceId: authorNs,
      profileNamespaceId: 0,
      profileRev: 0,
      status: 'ACCEPTED',
      messageEndSeq: 5,
      tombstoneEndSeq: 0,
      requestedAt: new Date(),
    });
    await database.db.insert(tables.peerStateFeed).values({
      namespaceId: authorNs,
      account: value.groupAccount,
      eventType: 'THREAD_CONTENT_HEAD',
      feedId: 1n,
      body: { messageEndSeq: 5, tombstoneEndSeq: 0 },
      updatedAt: new Date(),
    });
    const originTime = new Date('2026-09-01T00:00:00Z');
    const stored = await database.db.query.message.findFirst({
      where: eq(tables.message.id, value.messageId),
    });
    const expectedDigest = wirePayloadDigest(
      ContentType.FILE,
      stored!.content,
      [{ digest, bytes: bytes.length }],
    );
    await database.db
      .update(tables.message)
      .set({
        localState: 'STUB',
        originServerTime: originTime,
        payloadDigest: expectedDigest,
      })
      .where(eq(tables.message.id, value.messageId));
    await database.db
      .delete(tables.messageAsset)
      .where(eq(tables.messageAsset.messageId, value.messageId));
    await rm(path);
    try {
      const feed = new FederationMessageFeedService(database);
      const query = () =>
        feed.query(
          authorNs,
          { type: 'GROUP', account: value.groupAccount },
          0,
          100,
          5,
        );
      const page = await query();
      expect(page.messages).toHaveLength(1);
      const receipt = page.messages[0];
      expect(receipt).toMatchObject({
        seq: 5,
        originSeq: 7,
        originCreatedAt: originTime.getTime(),
        assets: [{ digest, bytes: bytes.length }],
      });
      expect(
        payloadDigest(receipt.content, receipt.assets, receipt.quoteDigest),
      ).toBe(expectedDigest);
      expect(receipt).not.toHaveProperty('localState');
      // FAILED is also a client projection state, not a reason to suppress acceptance.
      await database.db
        .update(tables.message)
        .set({ localState: 'FAILED' })
        .where(eq(tables.message.id, value.messageId));
      expect((await query()).messages).toHaveLength(1);
      await database.db
        .update(tables.message)
        .set({ isDeleted: true })
        .where(eq(tables.message.id, value.messageId));
      expect(await query()).toMatchObject({ messages: [], scannedThrough: 5 });
    } finally {
      await writeFile(path, bytes);
    }
  });

  it('does not let a mirror forward its cached group media to another member peer', async () => {
    const value = await fixture(true);
    await expect(value.download()).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
  });
});
