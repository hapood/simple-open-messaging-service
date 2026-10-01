import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { ContentType } from '../src/database/enums.js';
import {
  identityNamespace,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  peerStateFeed,
  threadAudience,
  account as user,
} from '../src/database/schema.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';
import {
  federatedContentDigests,
  fromFederatedMessageContent,
} from '../src/federation/federated-message-content.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { seedAcceptedRelationship } from './seed.js';
import { truncateTablesForTest } from './support/truncate';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Round-trip digest fidelity: for each federated content type, take the URL-free Federation v1 wire
 * shape that peer A would send, run it through the inbound projection (`fromFederatedMessageContent`
 * — what the inbound pipeline stores), persist it, then read it back through the outbound feed
 * (`FederationMessageFeedService.query`, which calls `toFederatedMessageContent` internally).
 *
 * The content sha-256 of the original wire and the outbound wire must match: the message body must
 * survive the inbound→store→outbound round-trip byte-for-byte. A mismatch is body loss.
 *
 * Envelope fields that are per-hop by design (`createdAt` is the receiver's DB time, not A's) are
 * asserted separately so the per-message content digest stays the fidelity signal.
 */
describe('federation message round-trip digest fidelity', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationMessageFeedService;
  const peerDomain = 'roundtrip-peer.test';
  const ourDomain = loadFederationConfig().domain;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "PeerStateFeed", "Account", "GroupAccount", "Profile", "MessageThread", "IdentityNamespace" RESTART IDENTITY CASCADE',
    );
    service = new FederationMessageFeedService(database);
  });

  afterAll(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "PeerStateFeed", "Account", "GroupAccount", "Profile", "MessageThread", "IdentityNamespace" RESTART IDENTITY CASCADE',
    );
    await mod.close();
  });

  async function seed() {
    const now = new Date('2026-08-12T01:02:03.000Z');
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        domain: peerDomain,
        rootPublicKey: Buffer.alloc(32, 3).toString('base64'),
        identityPinnedAt: now,
        active: true,
        trustLevel: 'available',
      })
      .returning({ id: identityNamespace.id });
    const namespaceId = namespace.id;
    const [alice] = await database.db
      .insert(user)
      .values({ account: 'alice', domain: 'local', updatedAt: now })
      .returning();
    const bob = { account: 'bob', domain: peerDomain, namespaceId };
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: now })
      .returning();
    await seedAcceptedRelationship(database.db, alice.id, bob, thread.id);
    await database.db.insert(threadAudience).values({
      targetNamespaceId: namespaceId,
      threadId: thread.id,
      messageAccessAfterSeq: 0,
    });
    return { alice, bob, namespaceId, thread };
  }

  /**
   * Run one content-type round-trip: wire → fromFederated (inbound projection) → DB → query
   * (outbound projection via the feed service) → wire'. Returns both wire forms and the envelope
   * so the caller can compare digests and per-hop fields.
   */
  async function roundtrip(
    contentType: ContentType,
    originalWire: string,
    assetBytes: ReadonlyMap<string, number>,
    originTime: Date,
  ) {
    const { bob, namespaceId, thread } = await seed();
    // Inbound projection: the URL-free wire form is projected to the local client/storage shape.
    // This is exactly what the inbound pipeline stores.
    const localContent = fromFederatedMessageContent(
      contentType,
      originalWire,
      ourDomain,
      assetBytes,
    );
    const [inserted] = await database.db
      .insert(message)
      .values({
        seq: 1,
        contentType,
        content: localContent,
        threadId: thread.id,
        creatorAccount: bob.account,
        profileNamespaceId: namespaceId,
        publisherNamespaceId: namespaceId,
        originSeq: 1,
        originServerTime: originTime,
        profileRev: 0,
        localState: 'READY',
        isDeleted: false,
        updatedAt: new Date(),
      })
      .returning({ id: message.id });
    // Persist every CAS asset the wire content references so the outbound feed can describe them.
    for (const digest of federatedContentDigests(contentType, originalWire)) {
      await database.db
        .insert(mediaAsset)
        .values({
          digest,
          bytes: BigInt(assetBytes.get(digest) ?? 1),
          isDeleted: false,
        })
        .onConflictDoNothing();
      await database.db
        .insert(messageAsset)
        .values({ messageId: inserted.id, threadId: thread.id, digest })
        .onConflictDoNothing();
    }
    await database.db
      .update(messageThread)
      .set({ curSeq: 1 })
      .where(eq(messageThread.id, thread.id));
    await database.db.insert(peerStateFeed).values({
      namespaceId,
      account: 'alice',
      eventType: 'THREAD_CONTENT_HEAD',
      subjectAccount: 'bob',
      subjectNamespaceId: namespaceId,
      feedId: 1n,
      body: { messageEndSeq: 1, tombstoneEndSeq: 0 },
    });

    const page = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      1,
    );
    expect(page.messages).toHaveLength(1);
    const outbound = page.messages[0];
    return {
      originalWire,
      outboundWire: outbound.content,
      originalDigest: sha256(originalWire),
      outboundDigest: sha256(outbound.content),
      createdAt: outbound.createdAt,
      originCreatedAt: outbound.originCreatedAt,
      originSeq: outbound.originSeq,
      originTime,
    };
  }

  // --- Content round-trip: the wire body must survive inbound→store→outbound byte-for-byte. ---

  it('preserves an IMAGE wire body across the round-trip', async () => {
    const wire = JSON.stringify({
      digest: digestA,
      width: 10,
      height: 20,
      name: 'photo.png',
    });
    const r = await roundtrip(
      ContentType.IMAGE,
      wire,
      new Map([[digestA, 30]]),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
  });

  it('preserves a FILE wire body across the round-trip', async () => {
    const wire = JSON.stringify({
      digest: digestA,
      name: 'doc.txt',
      mimeType: 'text/plain',
    });
    const r = await roundtrip(
      ContentType.FILE,
      wire,
      new Map([[digestA, 30]]),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
  });

  it('preserves a VIDEO wire body across the round-trip', async () => {
    const wire = JSON.stringify({
      digest: digestA,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      duration: 12.5,
    });
    const r = await roundtrip(
      ContentType.VIDEO,
      wire,
      new Map([[digestA, 9999]]),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
  });

  it('preserves an AUDIO wire body across the round-trip', async () => {
    const wire = JSON.stringify({
      digest: digestA,
      name: 'song.mp3',
      mimeType: 'audio/mpeg',
      duration: 200.0,
    });
    const r = await roundtrip(
      ContentType.AUDIO,
      wire,
      new Map([[digestA, 5000]]),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
  });

  it('preserves a GALLERY wire body across the round-trip', async () => {
    const wire = JSON.stringify({
      items: [
        { kind: 'IMAGE', digest: digestA, name: 'a.png', width: 10, height: 20 },
        {
          kind: 'VIDEO',
          digest: digestB,
          name: 'b.mp4',
          mimeType: 'video/mp4',
          width: 100,
          height: 200,
          duration: 3.0,
        },
      ],
    });
    const r = await roundtrip(
      ContentType.GALLERY,
      wire,
      new Map([
        [digestA, 30],
        [digestB, 4000],
      ]),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
  });

  it('preserves a LINK wire body (with optional artwork digests) across the round-trip', async () => {
    const wire = JSON.stringify({
      url: 'https://example.test/article',
      title: 'Example',
      description: 'Description',
      siteName: 'example',
      icon: digestA,
      favicon: digestB,
    });
    const r = await roundtrip(
      ContentType.LINK,
      wire,
      new Map([
        [digestA, 100],
        [digestB, 50],
      ]),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
  });

  it('preserves a PURE_TEXT wire body that mentions the peer domain (no local placeholder)', async () => {
    const wire = JSON.stringify({
      text: `hi [@Bob](somfp://user/bob%40${peerDomain})`,
    });
    const r = await roundtrip(
      ContentType.PURE_TEXT,
      wire,
      new Map(),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
  });

  it('preserves a PURE_TEXT wire body that mentions OUR domain (local placeholder round-trip)', async () => {
    // A sends a message mentioning one of OUR users. Inbound maps @user@<ourDomain> → @user@local
    // (stored). Outbound must map @user@local → @user@<ourDomain> back. The content digest must match.
    const wire = JSON.stringify({
      text: `hi [@Alice](somfp://user/alice%40${ourDomain})`,
    });
    const r = await roundtrip(
      ContentType.PURE_TEXT,
      wire,
      new Map(),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
    expect(JSON.parse(r.outboundWire)).toEqual(JSON.parse(wire));
  });

  it('preserves a CONTACT_CARD wire body whose domain is the peer domain', async () => {
    const wire = JSON.stringify({
      account: 'carol',
      domain: peerDomain,
      displayName: 'Carol',
      bio: 'hi',
      avatarDigest: digestA,
    });
    const r = await roundtrip(
      ContentType.CONTACT_CARD,
      wire,
      new Map([[digestA, 200]]),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
  });

  it('preserves a CONTACT_CARD wire body whose domain is OUR domain (local placeholder round-trip)', async () => {
    const wire = JSON.stringify({
      account: 'carol',
      domain: ourDomain,
      displayName: 'Carol',
      bio: 'hi',
      avatarDigest: digestA,
    });
    const r = await roundtrip(
      ContentType.CONTACT_CARD,
      wire,
      new Map([[digestA, 200]]),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outboundDigest).toBe(r.originalDigest);
    expect(JSON.parse(r.outboundWire)).toEqual(JSON.parse(wire));
  });

  // --- Envelope: per-hop fields that are NOT part of the content digest. ---

  it('replaces createdAt with the receiver DB time but preserves originCreatedAt for a processing receipt', async () => {
    const originTime = new Date('2026-01-01T00:00:00.000Z');
    const wire = JSON.stringify({ text: 'hello' });
    const r = await roundtrip(ContentType.PURE_TEXT, wire, new Map(), originTime);
    // createdAt is the receiver's DB insert time (store-and-forward stamps each hop), NOT A's time.
    expect(r.createdAt).not.toBe(originTime.getTime());
    // A processing receipt (re-serving to the origin publisher) carries the origin coordinates back,
    // so A's original time survives as originCreatedAt. This is the only path that preserves it.
    expect(r.originCreatedAt).toBe(originTime.getTime());
    expect(r.originSeq).toBe(1);
  });

  it('does not include originSeq/originCreatedAt for a message authored by the local side', async () => {
    // When WE author a message (publisherNamespaceId = 0) and serve it to the peer, there is no
    // upstream origin: originSeq/originCreatedAt are null on the wire by construction.
    const { namespaceId, thread } = await seed();
    const wire = JSON.stringify({ text: 'we authored this' });
    await database.db
      .insert(message)
      .values({
        seq: 1,
        contentType: ContentType.PURE_TEXT,
        content: wire,
        threadId: thread.id,
        creatorAccount: 'alice',
        profileNamespaceId: 0,
        publisherNamespaceId: 0,
        profileRev: 0,
        localState: 'READY',
        isDeleted: false,
        updatedAt: new Date(),
      })
      .returning({ id: message.id });
    await database.db
      .update(messageThread)
      .set({ curSeq: 1 })
      .where(eq(messageThread.id, thread.id));
    await database.db.insert(peerStateFeed).values({
      namespaceId,
      account: 'alice',
      eventType: 'THREAD_CONTENT_HEAD',
      subjectAccount: 'bob',
      subjectNamespaceId: namespaceId,
      feedId: 1n,
      body: { messageEndSeq: 1, tombstoneEndSeq: 0 },
    });
    const page = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      1,
    );
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].originSeq).toBeNull();
    expect(page.messages[0].originCreatedAt).toBeNull();
  });
});
