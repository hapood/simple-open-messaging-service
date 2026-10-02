import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
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
import { FederationMessageProvenanceService } from '../src/federation/federation-message-provenance.service.js';
import {
  federatedContentDigests,
  fromFederatedMessageContent,
} from '../src/federation/federated-message-content.js';
import { contentDigest } from '../src/federation/canonical-json.js';
import { seedAcceptedRelationship } from './seed.js';
import { truncateTablesForTest } from './support/truncate';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

/**
 * Round-trip fidelity: for each federated content type, take the URL-free Federation v1 wire
 * shape that peer A would send, run it through the inbound projection (`fromFederatedMessageContent`
 * — what the inbound pipeline stores), persist it, then read it back through the outbound feed
 * (`FederationMessageFeedService.query`, which calls `toFederatedMessageContent` internally).
 *
 * The outbound wire content must equal the original wire content as a JSON object: the message
 * body must survive the inbound→store→outbound round-trip semantically. The two wire forms are
 * not byte-identical because the projection renames fields (`url`↔`digest`, `w`↔`width`, …),
 * so the assertion compares parsed objects, not raw strings. A mismatch is body loss.
 *
 * Envelope fields that are per-hop by design (`createdAt` is the receiver's DB time, not A's)
 * are asserted separately so the per-message content stays the fidelity signal.
 */
describe('federation message round-trip digest fidelity', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationMessageFeedService;
  let provenance: FederationMessageProvenanceService;
  const peerDomain = 'roundtrip-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "PeerStateFeed", "Account", "GroupAccount", "Profile", "MessageThread", "RelationshipIntent", "RelationshipPair", "ThreadAudience" RESTART IDENTITY CASCADE',
    );
    await database.pool.query('DELETE FROM "IdentityNamespace" WHERE id <> 0');
    service = new FederationMessageFeedService(database);
    provenance = new FederationMessageProvenanceService(database);
  });

  afterAll(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "PeerStateFeed", "Account", "GroupAccount", "Profile", "MessageThread", "RelationshipIntent", "RelationshipPair", "ThreadAudience" RESTART IDENTITY CASCADE',
    );
    await database.pool.query('DELETE FROM "IdentityNamespace" WHERE id <> 0');
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
      assetBytes,
    );
    const [inserted] = await database.db
      .insert(message)
      .values({
        seq: 1,
        contentType,
        content: localContent,
        contentDigest: contentDigest(originalWire),
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

    // Provenance: a query for this message's `(thread, seq, contentDigest)` must answer `yes`,
    // and a query for the same coordinate with a different digest must answer `no`. This is the
    // origin-attestation contract: the responder confirms it published this content at this
    // coordinate. The digest is computed over the canonical (JCS) wire form, so it is stable
    // across the round-trip.
    const expectedDigest = contentDigest(originalWire);
    const yesResults = await provenance.query([
      {
        thread: { account: 'alice', peerAccount: 'bob' },
        seq: 1,
        contentDigest: expectedDigest,
      },
    ]);
    expect(yesResults).toEqual([
      {
        thread: { account: 'alice', peerAccount: 'bob' },
        seq: 1,
        known: 'yes',
      },
    ]);
    const noResults = await provenance.query([
      {
        thread: { account: 'alice', peerAccount: 'bob' },
        seq: 1,
        contentDigest: '0'.repeat(64),
      },
    ]);
    expect(noResults[0].known).toBe('no');

    return {
      original: JSON.parse(originalWire),
      outbound: JSON.parse(outbound.content),
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
    expect(r.outbound).toEqual(r.original);
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
    expect(r.outbound).toEqual(r.original);
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
    expect(r.outbound).toEqual(r.original);
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
    expect(r.outbound).toEqual(r.original);
  });

  it('preserves a GALLERY wire body across the round-trip', async () => {
    const wire = JSON.stringify({
      items: [
        {
          kind: 'IMAGE',
          digest: digestA,
          name: 'a.png',
          width: 10,
          height: 20,
        },
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
    expect(r.outbound).toEqual(r.original);
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
    expect(r.outbound).toEqual(r.original);
  });

  it('preserves a PURE_TEXT wire body with a namespace/user mention across the round-trip', async () => {
    // v1 user entity is (namespaceId, account); the mention survives unchanged because the stored
    // form and the wire form are the same namespace/account token.
    const wire = JSON.stringify({
      text: 'hello [@Alice](somfp://user/0/alice)',
    });
    const r = await roundtrip(
      ContentType.PURE_TEXT,
      wire,
      new Map(),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(r.outbound).toEqual(r.original);
    expect(r.outbound).toEqual(r.original);
  });

  it('preserves a CONTACT_CARD wire body whose domain is a real SOMFP domain across the round-trip', async () => {
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
    expect(r.outbound).toEqual(r.original);
    expect(r.outbound).toEqual(r.original);
  });

  // --- Envelope: per-hop fields that are NOT part of the content digest. ---

  it('replaces createdAt with the receiver DB time but preserves originCreatedAt for a processing receipt', async () => {
    const originTime = new Date('2026-01-01T00:00:00.000Z');
    const wire = JSON.stringify({ text: 'hello' });
    const r = await roundtrip(
      ContentType.PURE_TEXT,
      wire,
      new Map(),
      originTime,
    );
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

  // --- Provenance: batched origin attestation against the real database. ---

  it('answers a batched provenance query with mixed yes/no across threads', async () => {
    const { bob, namespaceId, thread } = await seed();
    // Insert two messages with distinct digests on the same P2P thread.
    const wire1 = JSON.stringify({ text: 'first' });
    const wire2 = JSON.stringify({ text: 'second' });
    const digest1 = contentDigest(wire1);
    const digest2 = contentDigest(wire2);
    for (const [seq, wire, digest] of [
      [1, wire1, digest1],
      [2, wire2, digest2],
    ] as const) {
      await database.db.insert(message).values({
        seq,
        contentType: ContentType.PURE_TEXT,
        content: fromFederatedMessageContent(ContentType.PURE_TEXT, wire, new Map()),
        contentDigest: digest,
        threadId: thread.id,
        creatorAccount: bob.account,
        profileNamespaceId: namespaceId,
        publisherNamespaceId: namespaceId,
        originSeq: seq,
        originServerTime: new Date('2026-08-12T00:00:00.000Z'),
        profileRev: 0,
        localState: 'READY',
        isDeleted: false,
        updatedAt: new Date(),
      });
    }
    await database.db
      .update(messageThread)
      .set({ curSeq: 2 })
      .where(eq(messageThread.id, thread.id));

    // Batch: seq=1 matches (yes), seq=2 with the wrong digest (no), seq=3 does not exist (no).
    const results = await provenance.query([
      { thread: { account: 'alice', peerAccount: 'bob' }, seq: 1, contentDigest: digest1 },
      { thread: { account: 'alice', peerAccount: 'bob' }, seq: 2, contentDigest: '0'.repeat(64) },
      { thread: { account: 'alice', peerAccount: 'bob' }, seq: 3, contentDigest: digest2 },
    ]);
    expect(results.map((r) => r.known)).toEqual(['yes', 'no', 'no']);
  });

  it('rejects a duplicate (thread, seq) provenance query against the real database', async () => {
    const q = {
      thread: { account: 'alice', peerAccount: 'bob' },
      seq: 1,
      contentDigest: '0'.repeat(64),
    };
    await expect(provenance.query([q, q])).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('throws FEDERATION_PROVENANCE_DECLINED when the batch policy declines', async () => {
    class DecliningProvenance extends FederationMessageProvenanceService {
      protected shouldDeclineBatch(): boolean {
        return true;
      }
    }
    const declining = new DecliningProvenance(database);
    await expect(
      declining.query([
        {
          thread: { account: 'alice', peerAccount: 'bob' },
          seq: 1,
          contentDigest: '0'.repeat(64),
        },
      ]),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PROVENANCE_DECLINED,
    });
  });
});
