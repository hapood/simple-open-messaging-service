import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  bootFederationPair,
  truncateFederationDbs,
  makePng,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  uploadAvatar,
  establishFederatedFriendship,
  registerAndLogin,
  resolveFederatedCard,
  getAdminCookie,
  openSse,
  collectSseEvents,
  waitForSseEvent,
} from './federation-test-helpers.js';
import {
  findGroupRelationship,
  findP2PRelationship,
  seedAcceptedRelationship,
} from './seed.js';
import { BusinessCode } from '../src/common/business-code.js';
import { SignatureService } from '../src/federation/signature.service.js';
import {
  ContentType,
  GroupRole,
  MessageThreadType,
} from '../src/database/enums.js';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  account,
  federatedPeer,
  federatedFriendRequest,
  federatedPeerEvent,
  federatedGroupMember,
  federationMessageFeedIndex,
  federationPullCursor,
  federationMessageReceipt,
  federationTombstoneFeedIndex,
  federationTombstoneServeCursor,
  federationServeCursor,
  forwardBundle,
  forwardBundleDependency,
  forwardMessage,
  group,
  groupRequestProjection,
  relationshipPair,
  relationshipIntent,
  mediaAsset,
  messageAsset,
  message,
  clientMessageFeed,
  messageThread,
  peerStateFeed,
  peerStateFeedPullCursor,
  peerStateFeedTarget,
  s2SKeyCache,
  threadMember,
  threadParticipant,
  threadAudience,
  user,
} from '../src/database/schema.js';
import { randomUUID } from 'node:crypto';
import { mutuallyAuthorizedSql } from '../src/invite/relationship-authorization.js';

/**
 * Federation e2e — two full SOMS apps (aaa.local + bbb.local) in one process, making real signed HTTP
 * requests to each other over loopback. Exercises the full S2S chain: signOutbound → fetch → Fastify
 * preParsing raw-body capture → content-digest + signature verify → bidirectional recognition → friend flows →
 * avatar localization → /revision staleness probe. See the harness header for the loopback trick.
 */

const DOM_A = FED_DOMAIN_A;
const DOM_B = FED_DOMAIN_B;

describe('Federation e2e (two nodes, real signed S2S traffic)', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string; // alice @ appA
  let tokenB: string; // bob @ appB
  let tokenCarol: string; // carol @ appA — alice's LOCAL friend (a real SSE recipient for the profile fan-out)
  let bobStubIdOnA: number; // appA's stub of bob (foreign)
  let aliceStubIdOnB: number; // appB's stub of alice (foreign)
  let aliceLocalIdA: number;
  let bobLocalIdB: number;
  let carolLocalIdA: number;
  let adminCookieA: string; // super-admin on appA — admin_session cookie pair for the block test + admin reads
  let png2: Buffer; // second avatar (distinct color) for the re-pull test
  let firstGroupThreadA: number; // the first federated group's ORIGIN thread on appA (reused by later group tests)
  let firstMirrorBId: number; // that group's MIRROR thread on appB
  let firstMirrorGroupBId: number; // mirror-local group identity; scopes directed membership rows
  let firstGroupAccount: string; // its `!account` — the on-wire group address
  let tokenDave: string; // dave @ appB — a SECOND local member of the same mirror (shared-mirror fan-out test)
  let daveLocalIdB: number;
  let daveStubIdOnA: number;
  let adminCookieB: string;

  async function findActiveP2pParticipant(app: FedApp, userId: number) {
    const result = await app.database.execute<{ threadId: number }>(sql`
      SELECT mine."threadId"
      FROM "ThreadMember" mine
      JOIN "ThreadMember" peer
        ON peer."threadId" = mine."threadId" AND peer."userId" <> mine."userId"
      JOIN "MessageThread" thread
        ON thread.id = mine."threadId" AND thread.type = 'P2P'
      WHERE mine."userId" = ${userId}
        AND ${mutuallyAuthorizedSql(sql`mine."userId"`, sql`peer."userId"`)}
      LIMIT 1
    `);
    return result.rows[0];
  }

  async function findActiveP2pBetween(
    app: FedApp,
    firstUserId: number,
    secondUserId: number,
  ) {
    const result = await app.database.execute<{ threadId: number }>(sql`
      SELECT first_participant."threadId"
      FROM "ThreadMember" first_participant
      JOIN "ThreadMember" second_participant
        ON second_participant."threadId" = first_participant."threadId"
      JOIN "MessageThread" thread
        ON thread.id = first_participant."threadId" AND thread.type = 'P2P'
      WHERE first_participant."userId" = ${firstUserId}
        AND second_participant."userId" = ${secondUserId}
        AND ${mutuallyAuthorizedSql(firstUserId, secondUserId)}
      LIMIT 1
    `);
    return result.rows[0];
  }

  async function countMessages(app: FedApp, condition: ReturnType<typeof eq>) {
    const [row] = await app.database
      .select({ count: count() })
      .from(message)
      .where(condition);
    return row.count;
  }

  async function requireActiveNamespaceId(app: FedApp, domain: string) {
    const peer = await app.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, domain),
      columns: { activeNamespaceId: true },
    });
    if (peer?.activeNamespaceId == null) {
      throw new Error(`No active namespace for federated peer ${domain}`);
    }
    return peer.activeNamespaceId;
  }

  const textContent = (value: string) => JSON.stringify({ text: value });

  async function findGroupThreadByAccount(app: FedApp, account: string) {
    const [row] = await app.database
      .select({
        id: messageThread.id,
        groupId: messageThread.groupId,
        pullUntil: messageThread.pullUntil,
        account: group.account,
        name: group.name,
        domain: group.domain,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(group.account, account))
      .limit(1);
    return row
      ? {
          ...row,
          group: {
            id: row.groupId!,
            account: row.account,
            name: row.name,
            domain: row.domain,
          },
        }
      : undefined;
  }

  async function findGroupThreadById(app: FedApp, threadId: number) {
    const [row] = await app.database
      .select({
        groupId: messageThread.groupId,
        account: group.account,
        domain: group.domain,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    return row ? { groupId: row.groupId!, group: row } : undefined;
  }

  async function findLatestForwardMessage(
    app: FedApp,
    creator: { account: string; domain: string },
  ) {
    const [row] = await app.database
      .select({
        threadId: message.threadId,
        seq: message.seq,
        bundleId: forwardMessage.bundleId,
        messageCount: forwardBundle.messageCount,
      })
      .from(message)
      .innerJoin(forwardMessage, eq(forwardMessage.messageId, message.id))
      .innerJoin(forwardBundle, eq(forwardBundle.id, forwardMessage.bundleId))
      .where(
        and(
          eq(message.creatorAccount, creator.account),
          eq(message.creatorDomain, creator.domain),
          eq(message.contentType, ContentType.FORWARD),
        ),
      )
      .orderBy(desc(message.seq))
      .limit(1);
    return row
      ? {
          threadId: row.threadId,
          seq: row.seq,
          forwardMessage: {
            bundleId: row.bundleId,
            bundle: { messageCount: row.messageCount },
          },
        }
      : undefined;
  }

  beforeAll(async () => {
    // Boot appA (aaa.local) + appB (bbb.local) in SEPARATE processes on SEPARATE databases. Each app is
    // its own Node process (isolated global state — Passport's `local` strategy etc. are per-app, not
    // cross-app leaks) + its own DB (a group's groupUser.account is @unique per DB). A transparent S2S proxy
    // sits on appB→appA (for the resume test's fault injection). bootFederationPair asserts the DBs differ.
    ({ appA, appB, proxy } = await bootFederationPair());
    // Persist a small, valid range size so the fixture crosses multiple requests. Restarting verifies
    // that subprocesses load runtime policy from their own database rather than process env.
    const transport = JSON.stringify({
      keyCacheTtlSec: 21_600,
      connectTimeoutSec: 12,
      callTimeoutSec: 12,
      mediaChunkBytes: 262_144,
      mediaChunkTimeoutSec: 120,
      mediaMaxChunkRetries: 5,
    });
    await Promise.all(
      [appA, appB].map((app) =>
        app.database.execute(sql`
          INSERT INTO "SystemSetting" ("key", "value", "updatedAt")
          VALUES ('federation:transport', ${transport}, NOW())
          ON CONFLICT ("key") DO UPDATE
          SET "value" = EXCLUDED."value", "updatedAt" = EXCLUDED."updatedAt"
        `),
      ),
    );
    await Promise.all([appA.restart(), appB.restart()]);
    await truncateFederationDbs(appA, appB);

    // Seed alice @ appA + bob @ appB via the real register+login HTTP path (Passport's `local` strategy is
    // now isolated per process, so /auth/login works correctly for each app).
    ({ id: aliceLocalIdA, token: tokenA } = await registerAndLogin(
      appA,
      'alice',
      'Alice',
    ));
    ({ id: bobLocalIdB, token: tokenB } = await registerAndLogin(
      appB,
      'bob',
      'Bob',
    ));
    // dave @ appB — a second local user, used as a second member of the same group MIRROR (the
    // shared-mirror two-member test: same-server members receive via the one mirror thread's SSE fan).
    ({ id: daveLocalIdB, token: tokenDave } = await registerAndLogin(
      appB,
      'dave',
      'Dave',
    ));

    // carol @ appA — a LOCAL friend of alice. The profile-edit fan-out (PEER_PROFILE_UPDATED) targets
    // active P2P peers; a foreign stub holds no SSE connection, so this gives the fan-out a real local
    // recipient whose SSE stream the test can read.
    ({ id: carolLocalIdA, token: tokenCarol } = await registerAndLogin(
      appA,
      'carol',
      'Carol',
    ));
    const [carolThread] = await appA.database
      .insert(messageThread)
      .values({ type: MessageThreadType.P2P, updatedAt: new Date() })
      .returning({ id: messageThread.id });
    await seedAcceptedRelationship(
      appA.database,
      aliceLocalIdA,
      carolLocalIdA,
      carolThread.id,
    );

    // Avatars are TEST FIXTURES (alice's profile must carry a real avatar over S2S; bob's must exist so
    // alice's resolve localizes a real one). Uploaded via the real multipart /user/update-avatar route.
    await uploadAvatar(appA, tokenA, await makePng(220));
    png2 = await makePng(40); // second avatar for the re-pull test (distinct bytes → distinct file)
    await uploadAvatar(appB, tokenB, await makePng(100));

    // A super-admin on appA — the trust-lifecycle tests block a peer + read the event timeline via the
    // REAL admin routes (which call markBlocked/peerEvents), not direct database shortcuts.
    adminCookieA = await getAdminCookie(appA);
    adminCookieB = await getAdminCookie(appB);
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('temporary resolve establishes trust without creating a stub', async () => {
    const resolved = await resolveFederatedCard(appA, tokenA, 'bob', DOM_B);
    expect(resolved.event, JSON.stringify(resolved)).toBe('resolved');
    expect(resolved.data).toMatchObject({
      relationship: 'NONE',
      user: { id: 0, domain: DOM_B },
    });
    expect(
      await appA.database.query.user.findFirst({
        where: and(eq(user.account, 'bob'), eq(user.domain, DOM_B)),
      }),
    ).toBeUndefined();

    const repeated = await resolveFederatedCard(appA, tokenA, 'bob', DOM_B);
    expect(repeated.event).toBe('resolved');
    expect(
      await appA.database.query.user.findFirst({
        where: and(eq(user.account, 'bob'), eq(user.domain, DOM_B)),
      }),
    ).toBeUndefined();

    // appA now trusts bbb.local.
    const peerA = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(peerA?.trustLevel).toBe('available');
    expect(peerA?.trustedAt).toBeInstanceOf(Date);
    expect(peerA).toMatchObject({
      recognizesPeer: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
      localServiceAvailable: true,
      remoteServiceReachable: true,
    });
    const peerB = await appB.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_A),
    });
    expect(peerB?.trustLevel).toBe('available');
    expect(peerB?.trustedAt).toBeInstanceOf(Date);

    const missing = await resolveFederatedCard(
      appA,
      tokenA,
      'missing-user',
      DOM_B,
    );
    expect(missing).toEqual({ event: 'failed', data: { reason: 'NOT_FOUND' } });
  });

  it('publishes PROFILE after an addressed request so the pending card has an avatar', async () => {
    const [namespaceBOnA, namespaceAOnB] = await Promise.all([
      requireActiveNamespaceId(appA, DOM_B),
      requireActiveNamespaceId(appB, DOM_A),
    ]);
    const res = await request(appA.baseUrl)
      .post('/api/v1/invite/federated-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        account: 'bob',
        domain: DOM_B,
        displayName: 'Bob',
        note: 'hi from aaa',
      });
    expect(res.status).toBe(200);
    expect(res.body.code, JSON.stringify(res.body)).toBe(BusinessCode.OK);

    const [incoming] = await vi.waitFor(
      async () => {
        const row = await appB.database.query.federatedFriendRequest.findFirst({
          where: and(
            eq(federatedFriendRequest.localUserId, bobLocalIdB),
            eq(federatedFriendRequest.remoteAccount, 'alice'),
            eq(federatedFriendRequest.remoteDomain, DOM_A),
            eq(federatedFriendRequest.namespaceId, namespaceAOnB),
            eq(federatedFriendRequest.direction, 'INCOMING'),
          ),
        });
        expect(row).toBeDefined();
        expect(row?.profileRevision).toBeGreaterThan(0);
        const profile = await appB.database.query.user.findFirst({
          where: and(
            eq(user.account, 'alice'),
            eq(user.domain, DOM_A),
            eq(user.sourceDomain, DOM_A),
            eq(user.namespaceId, namespaceAOnB),
          ),
        });
        expect(profile).toBeDefined();
        return [row!, profile!] as const;
      },
      { timeout: 5000, interval: 100 },
    );
    expect(incoming.expiresAt).not.toBeNull();
    expect(
      incoming.expiresAt!.getTime() - incoming.requestedAt!.getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);
    expect(incoming.displayName).toBe('Alice');
    expect(incoming.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
    expect(incoming.profileRevision).toBeGreaterThan(0);

    const [publishedProfile, publishedRequest] = await Promise.all([
      appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.namespaceId, namespaceBOnA),
          eq(peerStateFeed.account, 'alice'),
          eq(peerStateFeed.eventType, 'PROFILE'),
        ),
      }),
      appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.namespaceId, namespaceBOnA),
          eq(peerStateFeed.account, 'alice'),
          eq(peerStateFeed.subjectAccount, 'bob'),
          eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      }),
    ]);
    expect(publishedProfile).toBeDefined();
    expect(publishedRequest).toBeDefined();
    expect(publishedProfile!.feedId).toBeGreaterThan(publishedRequest!.feedId);

    const accepted = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ account: 'alice', domain: DOM_A });
    expect(accepted.body.code).toBe(BusinessCode.OK);

    const [aliceStubB, bobStubA] = await vi.waitFor(
      async () => {
        const stubs = await Promise.all([
          appB.database.query.user.findFirst({
            where: and(
              eq(user.account, 'alice'),
              eq(user.domain, DOM_A),
              eq(user.namespaceId, namespaceAOnB),
            ),
          }),
          appA.database.query.user.findFirst({
            where: and(
              eq(user.account, 'bob'),
              eq(user.domain, DOM_B),
              eq(user.namespaceId, namespaceBOnA),
            ),
          }),
        ]);
        expect(stubs[0]).toBeDefined();
        expect(stubs[1]).toBeDefined();
        return stubs as [
          NonNullable<(typeof stubs)[0]>,
          NonNullable<(typeof stubs)[1]>,
        ];
      },
      { timeout: 5000, interval: 100 },
    );
    aliceStubIdOnB = aliceStubB.id;
    bobStubIdOnA = bobStubA.id;
    expect(aliceStubB.avatar).toMatch(/^\/uploads\/.+-(512)\.webp$/);

    await vi.waitFor(
      async () => {
        for (const [app, localId, peerId] of [
          [appA, aliceLocalIdA, bobStubIdOnA],
          [appB, bobLocalIdB, aliceStubIdOnB],
        ] as const) {
          const relationship = await findP2PRelationship(
            app.database,
            localId,
            peerId,
          );
          const rows = await app.database
            .select()
            .from(relationshipIntent)
            .where(eq(relationshipIntent.pairId, relationship.pair!.id));
          expect(rows).toHaveLength(2);
          expect(rows.map((row) => row.note).sort()).toEqual([
            '',
            'hi from aaa',
          ]);
          const pair = relationship.pair;
          expect(pair?.active).toBe(true);
          expect(await findActiveP2pParticipant(app, peerId)).toBeDefined();
        }
      },
      { timeout: 5000, interval: 100 },
    );
  });

  it('crossed friend requests create the P2P thread on both servers', async () => {
    const threadB = await findActiveP2pParticipant(appB, aliceStubIdOnB);
    expect(threadB).toBeDefined();
    const threadA = await findActiveP2pParticipant(appA, bobStubIdOnA);
    expect(threadA).toBeDefined();

    // ACCEPTED + verified home PROFILE materialized bob's localized avatar.
    const bobStubA = await appA.database.query.user.findFirst({
      where: eq(user.id, bobStubIdOnA),
    });
    expect(bobStubA?.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
  });

  it('activates REQUESTED + ACCEPTED before the second acknowledgement arrives', async () => {
    const suffix = Date.now().toString(36);
    const alphaAccount = `cross-a-${suffix}`;
    const betaAccount = `cross-b-${suffix}`;
    const [alpha, beta] = await Promise.all([
      registerAndLogin(appA, alphaAccount, 'Cross Alpha'),
      registerAndLogin(appB, betaAccount, 'Cross Beta'),
    ]);
    const [namespaceBOnA, namespaceAOnB] = await Promise.all([
      requireActiveNamespaceId(appA, DOM_B),
      requireActiveNamespaceId(appB, DOM_A),
    ]);
    const [[betaStubA], [alphaStubB]] = await Promise.all([
      appA.database
        .insert(user)
        .values({
          account: betaAccount,
          name: 'Cross Beta',
          domain: DOM_B,
          sourceDomain: DOM_B,
          namespaceId: namespaceBOnA,
          updatedAt: new Date(),
        })
        .returning({ id: user.id }),
      appB.database
        .insert(user)
        .values({
          account: alphaAccount,
          name: 'Cross Alpha',
          domain: DOM_A,
          sourceDomain: DOM_A,
          namespaceId: namespaceAOnB,
          updatedAt: new Date(),
        })
        .returning({ id: user.id }),
    ]);

    proxy.blockStateFeed(true);
    try {
      const fromA = await request(appA.baseUrl)
        .post('/api/v1/invite/federated-friend')
        .set('Authorization', `Bearer ${alpha.token}`)
        .send({
          account: betaAccount,
          domain: DOM_B,
          displayName: 'Cross Beta',
          note: 'A request',
        });
      expect(fromA.body.code).toBe(BusinessCode.OK);

      const fromB = await request(appB.baseUrl)
        .post('/api/v1/invite/federated-friend')
        .set('Authorization', `Bearer ${beta.token}`)
        .send({
          account: alphaAccount,
          domain: DOM_A,
          displayName: 'Cross Alpha',
          note: 'B request',
        });
      expect(fromB.body.code).toBe(BusinessCode.OK);

      await vi.waitFor(
        () => expect(proxy.blockedStateFeedCount()).toBeGreaterThan(0),
        { timeout: 5000, interval: 50 },
      );
      await vi.waitFor(
        async () => {
          const relationship = await findP2PRelationship(
            appA.database,
            alpha.id,
            betaStubA.id,
          );
          const directions =
            await appA.database.query.relationshipIntent.findMany({
              where: eq(relationshipIntent.pairId, relationship.pair!.id),
            });
          expect(
            directions.find((row) => row.authorSide === relationship.firstSide),
          ).toMatchObject({ status: 'ACCEPTED', expiresAt: null });
          expect(
            directions.find(
              (row) => row.authorSide === relationship.secondSide,
            ),
          ).toMatchObject({ status: 'REQUESTED' });
          expect(relationship.pair).toMatchObject({
            active: true,
            threadId: expect.any(Number),
          });
        },
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      proxy.blockStateFeed(false);
    }

    await vi.waitFor(
      async () => {
        for (const [app, localId, peerId] of [
          [appA, alpha.id, betaStubA.id],
          [appB, beta.id, alphaStubB.id],
        ] as const) {
          const relationship = await findP2PRelationship(
            app.database,
            localId,
            peerId,
          );
          const directions =
            await app.database.query.relationshipIntent.findMany({
              where: eq(relationshipIntent.pairId, relationship.pair!.id),
            });
          expect(directions).toHaveLength(2);
          expect(directions.every((row) => row.status === 'ACCEPTED')).toBe(
            true,
          );
          expect(relationship.pair).toMatchObject({ active: true });
        }
      },
      { timeout: 30_000, interval: 100 },
    );
  }, 60_000);

  // ─── Step 2: cross-server 1:1 messages + media ───────────────────────────────
  // alice@appA ↔ bob@appB are now APPROVED with a P2P thread on each server. These exercise the
  // durable HWM → global /message-feed pipeline. State is always drained before message discovery.

  /** Resolve alice's P2P thread on appA (the thread she sends into). A friend relationship == a
   *  shared active P2P thread, so look it up via the bob stub's active participant row. */
  async function alicesThreadIdOnA(): Promise<number> {
    const p = await findActiveP2pParticipant(appA, bobStubIdOnA);
    if (!p?.threadId) throw new Error('alice↔bob thread missing on appA');
    return p.threadId;
  }

  /** Keep media tests individually runnable under Vitest's `-t`. Friendship is formed by the two
   * directed requests converging; there is no separate federated accept command. */
  async function ensureAliceAndBobAreFriends(): Promise<void> {
    const existingBob = await appA.database.query.user.findFirst({
      where: and(eq(user.account, 'bob'), eq(user.domain, DOM_B)),
    });
    if (existingBob) bobStubIdOnA = existingBob.id;
    if (bobStubIdOnA && (await findActiveP2pParticipant(appA, bobStubIdOnA))) {
      const existingAlice = await appB.database.query.user.findFirst({
        where: and(eq(user.account, 'alice'), eq(user.domain, DOM_A)),
      });
      if (existingAlice) aliceStubIdOnB = existingAlice.id;
      return;
    }

    const friendship = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: aliceLocalIdA,
      remoteUserId: bobLocalIdB,
      localToken: tokenA,
      remoteToken: tokenB,
      localAccount: 'alice',
      remoteAccount: 'bob',
      localDomain: DOM_A,
      remoteDomain: DOM_B,
      note: 'media test setup',
    });
    bobStubIdOnA = friendship.remoteStubIdOnLocal;
    aliceStubIdOnB = friendship.localStubIdOnRemote;
  }

  async function sendFederatedImage(bytes: Buffer) {
    const clientMessageId = randomUUID();
    const stage = await request(appA.baseUrl)
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        contentType: 'IMAGE',
        clientMessageId,
      });
    expect(stage.body.code).toBe(BusinessCode.OK);
    const upload = await request(appA.baseUrl)
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', bytes, 'federated.png')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'IMAGE');
    expect(upload.body.code).toBe(BusinessCode.OK);
    const { url, size } = upload.body.data as { url: string; size: number };
    const digest = url
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '');
    // Both subprocesses share this test checkout's CAS directory. Model physically separate NAS
    // storage by serving appA's bytes from the S2S proxy and removing the shared shard before appB
    // localizes it; otherwise appB legitimately deduplicates and never exercises /media/:digest.
    proxy.setGetFileFixture(digest, bytes);
    const { rm } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    await rm(
      nodePath.join(
        process.cwd(),
        'data',
        'cas',
        digest.slice(0, 2),
        digest.slice(2, 4),
        digest,
      ),
      { force: true },
    );
    return { url, size, digest };
  }

  it('Step 2: a federated message is pushed + pulled to the peer (text) + SSE-fanned', async () => {
    // Open bob's SSE stream BEFORE alice sends, so the delivery frame is captured on the real wire
    // (a real end-to-end delivery check — stronger than spying on the internal onNewMessage call).
    const reader = await openSse(appB.baseUrl, tokenB);
    try {
      const res = await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: await alicesThreadIdOnA(),
          content: 'hi from alice',
          contentType: 'PURE_TEXT',
        });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(BusinessCode.OK);
      // The ~500ms debounce pushes the hint; appB drains + pulls + stores + SSE. Poll for the stored row,
      // capturing bob's LOCAL thread id + the receiver-allocated seq — NEW_MESSAGE is identity-only
      // { threadId, seq, ts }, so those two fields ARE the on-wire signal asserted next.
      let bobLocalThreadId = 0;
      let bobLocalSeq = -1;
      await vi.waitFor(
        async () => {
          const msg = await appB.database.query.message.findFirst({
            where: and(
              eq(message.content, JSON.stringify({ text: 'hi from alice' })),
              eq(message.creatorAccount, 'alice'),
              eq(message.creatorDomain, DOM_A),
            ),
          });
          expect(msg).toBeDefined();
          // Structured friendship SYSTEM records may precede the first user-authored message.
          expect(msg!.originSeq).toBeGreaterThanOrEqual(0);
          bobLocalThreadId = msg!.threadId;
          bobLocalSeq = msg!.seq;
        },
        { timeout: 5000 },
      );
      await vi.waitFor(
        async () => {
          const [source, remoteCopy] = await Promise.all([
            appA.database.query.message.findFirst({
              where: and(
                eq(message.content, JSON.stringify({ text: 'hi from alice' })),
                eq(message.creatorAccount, 'alice'),
                eq(message.creatorDomain, 'local'),
              ),
            }),
            appB.database.query.message.findFirst({
              where: and(
                eq(message.content, JSON.stringify({ text: 'hi from alice' })),
                eq(message.creatorAccount, 'alice'),
                eq(message.creatorDomain, DOM_A),
              ),
            }),
          ]);
          expect(source?.originSeq).toBeNull();
          expect(source?.originServerTime).toBeNull();
          const receipt =
            await appA.database.query.federationMessageReceipt.findFirst({
              where: and(
                eq(federationMessageReceipt.peerDomain, DOM_B),
                eq(federationMessageReceipt.threadId, source!.threadId),
                eq(federationMessageReceipt.peerSeq, remoteCopy!.seq),
                eq(federationMessageReceipt.messageId, source!.id),
              ),
            });
          expect(receipt).toBeDefined();
          expect(source?.createdAt.getTime()).toBe(
            remoteCopy?.originServerTime?.getTime(),
          );
        },
        { timeout: 5000 },
      );
      // The real SSE stream delivered the identity-only NEW_MESSAGE signal to bob (end-to-end wire delivery).
      await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === bobLocalThreadId &&
          (data as { seq?: number }).seq === bobLocalSeq,
      );
    } finally {
      await reader.cancel();
    }
  });

  it('Step 2: a federated member can reply to a peer-authored message', async () => {
    await ensureAliceAndBobAreFriends();
    const marker = `quote target ${randomUUID()}`;
    const original = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        content: marker,
        contentType: 'PURE_TEXT',
      });
    expect(original.body.code).toBe(BusinessCode.OK);
    const quotedOnB = await vi.waitFor(
      async () => {
        const found = await appB.database.query.message.findFirst({
          where: and(
            eq(message.content, JSON.stringify({ text: marker })),
            eq(message.creatorAccount, 'alice'),
            eq(message.creatorDomain, DOM_A),
          ),
        });
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: 5000 },
    );

    const sent = await request(appB.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: quotedOnB.threadId,
        content: JSON.stringify({
          text: 'reply from bob',
          quote: { seq: quotedOnB.seq },
        }),
        contentType: 'PURE_TEXT',
      });
    expect(sent.status).toBe(200);
    expect(sent.body.code).toBe(BusinessCode.OK);

    await vi.waitFor(
      async () => {
        const reply = await appA.database.query.message.findFirst({
          where: and(
            eq(message.creatorAccount, 'bob'),
            eq(message.creatorDomain, DOM_B),
            eq(message.contentType, ContentType.PURE_TEXT),
          ),
          orderBy: (row, { desc }) => [desc(row.seq)],
        });
        expect(reply).toBeDefined();
        expect(JSON.parse(reply!.content)).toEqual({
          text: 'reply from bob',
          quote: { seq: original.body.data.seq },
        });
      },
      { timeout: 5000 },
    );
  });

  it('forwards a complete bundle closure, preserves retry idempotency, and relays a nested bundle from the receiving server', async () => {
    const sourceA = await appA.database.query.message.findFirst({
      where: and(
        eq(message.content, JSON.stringify({ text: 'hi from alice' })),
        eq(message.creatorAccount, 'alice'),
        eq(message.creatorDomain, 'local'),
      ),
    });
    if (!sourceA) throw new Error('source message missing on appA');
    const clientMessageIdA = randomUUID();
    const payloadA = {
      threadId: sourceA.threadId,
      sourceMessages: [{ threadId: sourceA.threadId, seq: sourceA.seq }],
      mode: 'HISTORY',
      clientMessageId: clientMessageIdA,
    };
    const first = await request(appA.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(payloadA);
    expect(first.status).toBe(200);
    expect(first.body.code).toBe(BusinessCode.OK);
    const retry = await request(appA.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(payloadA);
    expect(retry.body.data.seq).toBe(first.body.data.seq);
    expect(
      await countMessages(appA, eq(message.clientMessageId, clientMessageIdA)),
    ).toBe(1);

    let importedOnB: {
      threadId: number;
      seq: number;
      forwardMessage: {
        bundleId: string;
        bundle: { messageCount: number };
      } | null;
    } | null = null;
    await vi.waitFor(
      async () => {
        importedOnB = await findLatestForwardMessage(appB, {
          account: 'alice',
          domain: DOM_A,
        });
        expect(importedOnB?.forwardMessage?.bundle.messageCount).toBe(1);
      },
      { timeout: 5000 },
    );

    const clientMessageIdB = randomUUID();
    const nested = await request(appB.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: importedOnB!.threadId,
        sourceMessages: [
          { threadId: importedOnB!.threadId, seq: importedOnB!.seq },
        ],
        mode: 'HISTORY',
        clientMessageId: clientMessageIdB,
      });
    expect(nested.status).toBe(200);
    expect(nested.body.code).toBe(BusinessCode.OK);

    await vi.waitFor(
      async () => {
        const relayed = await findLatestForwardMessage(appA, {
          account: 'bob',
          domain: DOM_B,
        });
        expect(relayed?.forwardMessage?.bundle.messageCount).toBe(2);
        const closure =
          await appA.database.query.forwardBundleDependency.findMany({
            where: eq(
              forwardBundleDependency.parentBundleId,
              relayed!.forwardMessage!.bundleId,
            ),
          });
        expect(closure).toHaveLength(1);
      },
      { timeout: 5000 },
    );
  }, 30_000);

  it('Step 2: a federated image localizes on the peer (media round-trip, same-origin)', async () => {
    // alice uploads an image on appA (fixture) → a CAS url. Sent as an IMAGE message whose content
    // embeds the url (the shape extractDigestEntries scans for the digest + ext).
    const { url, digest } = await sendFederatedImage(
      await makePng(Math.floor(Math.random() * 256)),
      16,
    );

    // The message pulls, then localizeMedia fetches the digest via /media/:digest + stores it in appB's CAS
    // (byte-identical → same shard path) + writes the MediaMessage authz row. Poll for both.
    await vi.waitFor(
      async () => {
        const asset = await appB.database.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        expect(asset).toBeDefined();
        expect(asset!.isDeleted).toBe(false);
        const mm = await appB.database.query.messageAsset.findFirst({
          where: eq(messageAsset.digest, digest),
        });
        expect(mm).toBeDefined();
      },
      { timeout: 5000 },
    );
    // The localized file exists on appB's disk at the SAME server-relative path → renders same-origin.
    const { stat } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const abs = nodePath.join(
      appB.dataDir,
      'cas',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    await expect(stat(abs)).resolves.toBeDefined();
  });

  it('Step 2: a federated file localizes over multiple Range chunks (resumable transport)', async () => {
    // A noisy PNG spans multiple configured chunks. The file can ONLY
    // localize if appB fetches /media/:digest as signed Range GETs + reassembles them — so a
    // byte-exact result here PROVES the multi-chunk path.
    proxy.clearRequestLog();
    const { url, size, digest } = await sendFederatedImage(
      await makePng(77, 512, true),
    );

    // appB (its own DB) has never seen this asset → localizeMedia fetches it over /media/:digest + writes a
    // MediaAsset + MediaMessage row. (No shared-DB dedup to defeat: appA's row is in _a, appB's in _b.)
    await vi.waitFor(
      async () => {
        const asset = await appB.database.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        expect(asset).toBeDefined();
        expect(asset!.isDeleted).toBe(false);
        const mm = await appB.database.query.messageAsset.findFirst({
          where: eq(messageAsset.digest, digest),
        });
        expect(mm).toBeDefined();
      },
      { timeout: 5000 },
    );

    // Integrity: the localized file re-hashes to the advertised digest — byte-exact (only possible via
    // multiple reassembled 64-byte Range units for a file this size).
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const nodePath = await import('node:path');
    const abs = nodePath.join(
      appB.dataDir,
      'cas',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    const onDisk = await readFile(abs);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(digest);
    expect(onDisk.length).toBe(size);

    // The digest alone is not authorization. Re-sign the same resource request with a different
    // stable message seq and thread recipient; both must fail the exact historical ownership lookup.
    const servedPath = proxy
      .requestLog()
      .find((entry) => entry.path.startsWith(`/s2s/v1/media/${digest}?`))?.path;
    expect(servedPath).toBeDefined();
    const assertRejectedBinding = async (
      mutate: (url: URL) => void,
    ): Promise<void> => {
      const url = new URL(servedPath!, 'http://federation.test');
      mutate(url);
      const probe = await request(appB.baseUrl)
        .get('/api/v1/test/signed-s2s-get')
        .query({ peerDomain: DOM_A, path: `${url.pathname}${url.search}` });
      expect(probe.body.status).toBe(200);
      expect(probe.body.body.code).toBe(BusinessCode.FORBIDDEN);
    };
    await assertRejectedBinding((url) => {
      url.searchParams.set(
        'seq',
        String(Number(url.searchParams.get('seq')) + 1),
      );
    });
    await assertRejectedBinding((url) => {
      url.searchParams.set('toAccount', 'not-the-delivered-thread');
    });

    // Feed allocation and resource authorization are intentionally independent. Once appB has consumed
    // the carrier message, disable the proxy's byte fixture so this probe reaches appA's real /media
    // authorization path. The exact message/digest binding plus retained ThreadAudience authorizes it.
    const sourceBinding = await appA.database.query.messageAsset.findFirst({
      where: eq(messageAsset.digest, digest),
      columns: { messageId: true },
    });
    expect(sourceBinding).toBeDefined();
    proxy.setGetFileFixture(digest, null);
    const afterFeedGc = await request(appB.baseUrl)
      .get('/api/v1/test/signed-s2s-get')
      .query({ peerDomain: DOM_A, path: servedPath });
    expect(afterFeedGc.body.status).toBe(200);
  });

  it('Step 2: a dropped media chunk resumes from its offset (no degradation, byte-exact)', async () => {
    await ensureAliceAndBobAreFriends();
    const imageBytes = await makePng(190, 48);

    // Arm the S2S proxy (on appB→appA) to truncate the FIRST media `bytes=0-` response mid-stream —
    // a simulated network drop. appB must discard the partial unit + re-request the SAME range (resume),
    // NOT degrade appA. The proxy preserves the signed Host, so signatures still verify at appA.
    proxy.armGetFileTruncation();

    const { url, size, digest } = await sendFederatedImage(imageBytes, 48);

    await vi.waitFor(
      async () => {
        const asset = await appB.database.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        expect(asset).toBeDefined();
        expect(asset!.isDeleted).toBe(false);
      },
      { timeout: 5000 },
    );

    // Resume proven: the first media range was issued ≥2 times through the proxy (the initial call
    // that got truncated + the retry that succeeded) → appB re-requested the SAME range, not restarted.
    expect(proxy.firstRangeGetFileCount()).toBeGreaterThanOrEqual(2);
    // A mid-body stall is a stream glitch, not a trust failure → appB must still trust appA.
    const peer = await appB.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_A),
    });
    expect(peer?.trustLevel).toBe('available');

    // Integrity: the resumed file re-hashes to the digest (no gap/duplicate from the drop + retry).
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const nodePath = await import('node:path');
    const abs = nodePath.join(
      appB.dataDir,
      'cas',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    const onDisk = await readFile(abs);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(digest);
    expect(onDisk.length).toBe(size);
  });

  it('state feed propagates a changed avatar without a client profile probe', async () => {
    const before = await appB.database.query.user.findFirst({
      where: eq(user.id, aliceStubIdOnB),
    });
    expect(before?.profileRev).not.toBeNull();
    const avatarBefore = before!.avatar;

    // alice changes her avatar on appA → profileRev bumps (multipart upload — the real path).
    await uploadAvatar(appA, tokenA, png2);

    // The committed PROFILE state item wakes appB; no chat-open/client probe is involved.
    const after = await vi.waitFor(
      async () => {
        const a = await appB.database.query.user.findFirst({
          where: eq(user.id, aliceStubIdOnB),
        });
        expect(a?.avatar).not.toBe(avatarBefore); // re-pulled to the new avatar
        return a!;
      },
      { timeout: 5000 },
    );
    const source = await appA.database.query.user.findFirst({
      where: eq(user.id, aliceId),
    });
    expect(after.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
    expect(after.profileRev).toBe(source!.profileRev);
  });

  it('removes the legacy client peer-profile sync endpoint', async () => {
    const res = await request(appB.baseUrl)
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    expect(res.status).toBe(404);
  });

  it('local profile edit advances the shared client state revision', async () => {
    const before = await appA.database.query.account.findFirst({
      where: eq(account.id, carolLocalIdA),
      columns: { stateFeedAllocatedThrough: true },
    });
    expect(before).toBeDefined();
    const reader = await openSse(appA.baseUrl, tokenCarol);
    try {
      const res = await request(appA.baseUrl)
        .post('/api/v1/user/update-profile')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Alice Renamed' });
      expect(res.status).toBe(200);
      const payload = (await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'STATE_FEED_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { feedId?: unknown }).feedId === 'number' &&
          (data as { feedId: number }).feedId >
            before!.stateFeedAllocatedThrough,
      )) as { feedId?: number };
      expect(payload.feedId).toBeGreaterThan(0);
      const delta = await request(appA.baseUrl)
        .get('/api/v1/user/state-feed')
        .set('Authorization', `Bearer ${tokenCarol}`)
        .query({ mode: 'delta', after: 0, through: payload.feedId });
      expect(delta.status).toBe(200);
      expect(delta.body.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            account: 'alice',
            eventType: 'PROFILE',
            body: expect.objectContaining({
              displayName: 'Alice Renamed',
            }),
          }),
        ]),
      );
    } finally {
      await reader.cancel();
    }
  });

  it('federated profile application advances the local shared state revision', async () => {
    await uploadAvatar(appA, tokenA, await makePng(180));

    // Read bob's real SSE stream — he's the stub's local friend, so the re-localization pushes to him.
    const reader = await openSse(appB.baseUrl, tokenB);
    try {
      await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'STATE_FEED_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { feedId?: unknown }).feedId === 'number',
      );
    } finally {
      await reader.cancel();
    }
  });

  // ─── Step 3 Phase B: cross-server group messaging (origin-hub) ────────────────
  it('Step 3: federated group — invite → accept → origin-hub message delivery', async () => {
    // alice@appA creates a group, then invites bob@appB (a federated friend). writeInvites sends the
    // cross-server invite (peer mints the mirror + Invite) AND writes the GROUP_INVITE card into alice's
    // P2P mirror (it flows to bob via the Step-2 pull). The card + the accept key on the group `!account`.
    const create = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'fed-group' });
    expect(create.status).toBe(200);
    expect(create.body.code, JSON.stringify(create.body)).toBe(BusinessCode.OK);
    const groupThreadA = create.body.data.threadId as number;
    const invite = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: groupThreadA, userIds: [bobStubIdOnA] });
    expect(invite.body.code, JSON.stringify(invite.body)).toBe(BusinessCode.OK);

    // The independent Group account is the on-wire group address.
    const trdA = await findGroupThreadById(appA, groupThreadA);
    expect(trdA?.group?.account).toBeTruthy();
    // appA is the ORIGIN: a local Group carries the 'local' domain sentinel (isOriginThread checks
    // `=== 'local'`); the real domain is materialized only on the wire (roster/address mapping). The
    // mirror (appB) stores the origin's real domain — asserted below.
    expect(trdA?.group?.domain).toBe('local');
    const groupAccount = trdA!.group!.account;

    // appB mints the mirror + the incoming Invite (handleGroupInvite). Poll for the mirror thread.
    const mirrorB = await vi.waitFor(
      async () => {
        const m = await findGroupThreadByAccount(appB, groupAccount);
        expect(m).toBeDefined();
        expect(m!.group?.domain).toBe(DOM_A); // mirror knows the origin
        return m!;
      },
      { timeout: 5000 },
    );

    // Group invites are structural client state, not chat messages. The inbound
    // RELATIONSHIP_INTENT must materialize the mirror's durable membership request without requiring
    // bob to open a P2P conversation or pull a legacy INVITE message card.
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          mirrorB.groupId,
          bobLocalIdB,
        );
        const pendingInvite =
          await appB.database.query.relationshipIntent.findFirst({
            where: and(
              eq(relationshipIntent.pairId, relationship.pair!.id),
              eq(relationshipIntent.authorSide, relationship.groupSide),
              eq(relationshipIntent.status, 'REQUESTED'),
            ),
          });
        expect(pendingInvite).toBeDefined();
      },
      { timeout: 5000 },
    );

    const [publishedGroupProfile, publishedGroupInvite] = await Promise.all([
      appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.account, groupAccount),
          eq(peerStateFeed.eventType, 'PROFILE'),
        ),
      }),
      appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.account, groupAccount),
          eq(peerStateFeed.subjectAccount, 'bob'),
          eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      }),
    ]);
    expect(publishedGroupProfile?.body).toMatchObject({
      displayName: 'fed-group',
    });
    expect(publishedGroupProfile!.feedId).toBeGreaterThan(
      publishedGroupInvite!.feedId,
    );
    await vi.waitFor(
      async () => {
        const hydratedMirror = await findGroupThreadByAccount(
          appB,
          groupAccount,
        );
        expect(hydratedMirror?.group?.name).toBe('fed-group');
      },
      { timeout: 5000, interval: 100 },
    );

    // Local acceptance updates the relationship state. The remote host later publishes the
    // authoritative member roster through GROUP_META; mirrors do not derive ThreadParticipant.
    const accept = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: mirrorB.id });
    expect(accept.status).toBe(200);
    expect(accept.body.code).toBe(BusinessCode.OK);
    const outboundJoin = await appB.database.query.peerStateFeed.findFirst({
      where: and(
        eq(peerStateFeed.peerDomain, DOM_A),
        eq(peerStateFeed.account, 'bob'),
        eq(peerStateFeed.subjectAccount, groupAccount),
        eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
      ),
    });
    expect(outboundJoin?.body).toMatchObject({ status: 'ACCEPTED' });
    const establishedImmediately =
      await appB.database.query.threadMember.findFirst({
        where: and(
          eq(threadMember.threadId, mirrorB.id),
          eq(threadMember.userId, bobLocalIdB),
        ),
      });
    expect(establishedImmediately).toBeUndefined();
    await vi.waitFor(
      async () => {
        const cursor =
          await appA.database.query.peerStateFeedPullCursor.findFirst({
            where: eq(peerStateFeedPullCursor.peerDomain, DOM_B),
          });
        expect(cursor?.committedThrough ?? 0n).toBeGreaterThanOrEqual(
          outboundJoin!.feedId,
        );
      },
      { timeout: 5000, interval: 100 },
    );
    const originMembership = await findGroupRelationship(
      appA.database,
      trdA!.groupId,
      bobStubIdOnA,
    );
    const originMembershipRows =
      await appA.database.query.relationshipIntent.findMany({
        where: eq(relationshipIntent.pairId, originMembership.pair!.id),
      });
    expect(originMembershipRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorSide: 'A', status: 'ACCEPTED' }),
        expect.objectContaining({ authorSide: 'B', status: 'ACCEPTED' }),
      ]),
    );
    expect(originMembership.pair?.active).toBe(true);

    // The origin (appA) records bob on its canonical roster (handleGroupAccept). Poll for it.
    await vi.waitFor(
      async () => {
        const bobOnA = await appA.database.query.threadMember.findFirst({
          where: and(
            eq(threadMember.userId, bobStubIdOnA),
            eq(threadMember.threadId, groupThreadA),
          ),
        });
        expect(bobOnA).toBeDefined(); // bob is an active member on the origin roster

        const bobOnMirror = await appB.database.query.threadMember.findFirst({
          where: and(
            eq(threadMember.userId, bobLocalIdB),
            eq(threadMember.threadId, mirrorB.id),
          ),
        });
        expect(bobOnMirror).toBeDefined();

        const bobRosterAddress =
          await appB.database.query.federatedGroupMember.findFirst({
            where: and(
              eq(federatedGroupMember.sourcePeerDomain, DOM_A),
              eq(federatedGroupMember.groupAccount, groupAccount),
              eq(federatedGroupMember.memberAccount, 'bob'),
              eq(federatedGroupMember.memberDomain, DOM_B),
            ),
          });
        expect(bobRosterAddress).toBeDefined();
      },
      { timeout: 5000 },
    );

    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          mirrorB.groupId,
          bobLocalIdB,
        );
        const confirmedMemberships = await appB.database
          .select({
            authorSide: relationshipIntent.authorSide,
            status: relationshipIntent.status,
            expiresAt: relationshipIntent.expiresAt,
          })
          .from(relationshipIntent)
          .where(eq(relationshipIntent.pairId, relationship.pair!.id));
        expect(confirmedMemberships).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              authorSide: relationship.groupSide,
              status: 'ACCEPTED',
              expiresAt: null,
            }),
            expect.objectContaining({
              authorSide: relationship.memberSide,
              status: 'ACCEPTED',
              expiresAt: null,
            }),
          ]),
        );
      },
      { timeout: 5000, interval: 100 },
    );

    // System messages are local timeline decorations: the accepting mirror and
    // the confirming origin each persist exactly one notice.
    await vi.waitFor(
      async () => {
        for (const [app, threadId] of [
          [appA, groupThreadA],
          [appB, mirrorB.id],
        ] as const) {
          const joined = await app.database
            .select({ id: message.id })
            .from(message)
            .where(
              and(
                eq(message.threadId, threadId),
                eq(message.contentType, ContentType.SYSTEM),
                sql`${message.content}::text like '%GROUP_JOINED%'`,
                sql`${message.content}::text like '%bob%'`,
              ),
            );
          expect(joined).toHaveLength(1);
        }
      },
      { timeout: 5000, interval: 100 },
    );

    // alice (origin local member) sends a group message → appB mirror pulls it from the origin hub.
    // Open bob's SSE stream BEFORE the send; assert BOTH the stored mirror row AND the real delivery.
    const reader = await openSse(appB.baseUrl, tokenB);
    try {
      const send = await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: groupThreadA,
          content: 'hello group',
          contentType: 'PURE_TEXT',
        });
      expect(send.status).toBe(200);
      expect(send.body.code).toBe(BusinessCode.OK);
      // The message lands on bob's mirror (origin-hub: appA signals appB; appB pulls). Capture its
      // receiver-local seq so the SSE assertion targets THIS signal (NEW_MESSAGE is identity-only).
      let helloGroupSeq = -1;
      await vi.waitFor(
        async () => {
          const msg = await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirrorB.id),
              eq(message.content, textContent('hello group')),
            ),
          });
          expect(msg).toBeDefined();
          helloGroupSeq = msg!.seq;
        },
        { timeout: 5000 },
      );
      // ...AND arrives on bob's real SSE stream (identity-only NEW_MESSAGE signal, end-to-end cross-server).
      await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === mirrorB.id &&
          (data as { seq?: number }).seq === helloGroupSeq,
      );
    } finally {
      await reader.cancel();
    }
    // Capture the group + mirror for the recovery test + the shared-mirror two-member test (both reuse it).
    firstGroupThreadA = groupThreadA;
    firstGroupAccount = groupAccount;
    firstMirrorBId = mirrorB.id;
    firstMirrorGroupBId = mirrorB.groupId;
  }, 60_000);

  it('projects a federated join application and converges reject, renew, and revoke', async () => {
    const { token: tokenErin } = await registerAndLogin(
      appB,
      'erin-join-projection',
      'Erin',
    );
    const diagnosticReset = await request(appA.baseUrl).post(
      '/api/v1/test/feed-drain-diagnostics/reset',
    );
    expect(diagnosticReset.status).toBe(201);
    const apply = await request(appB.baseUrl)
      .post('/api/v1/group/federated-join-request')
      .set('Authorization', `Bearer ${tokenErin}`)
      .send({
        account: firstGroupAccount,
        domain: DOM_A,
        displayName: 'fed-group',
        note: 'federated application',
      });
    expect(apply.body.code, JSON.stringify(apply.body)).toBe(BusinessCode.OK);

    const projected = await vi.waitFor(
      async () => {
        const applicant = await appA.database.query.user.findFirst({
          where: and(
            eq(user.account, 'erin-join-projection'),
            eq(user.domain, DOM_B),
          ),
          columns: { id: true },
        });
        expect(applicant).toBeDefined();
        const row = await appA.database.query.groupRequestProjection.findFirst({
          where: and(
            eq(groupRequestProjection.managerUserId, aliceLocalIdA),
            eq(groupRequestProjection.threadId, firstGroupThreadA),
            eq(groupRequestProjection.memberUserId, applicant!.id),
            eq(groupRequestProjection.direction, 'APPLICATION'),
          ),
        });
        expect(row).toMatchObject({ status: 'REQUESTED' });
        return row!;
      },
      { timeout: 5000, interval: 100 },
    );
    const diagnostic = await request(appA.baseUrl).get(
      '/api/v1/test/feed-drain-diagnostics',
    );
    expect(diagnostic.status).toBe(200);
    expect(diagnostic.body).toMatchObject({
      pullErrors: 0,
      retriesScheduled: 0,
    });
    expect(diagnostic.body.maxHeadToPullStartMs).toBeLessThan(1000);
    expect(diagnostic.body.maxPullDurationMs).toBeLessThan(5000);
    const rejected = await request(appA.baseUrl)
      .post('/api/v1/group/join-request/reject')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        groupId: firstGroupThreadA,
        requestId: projected.requestId.toString(),
      });
    expect(rejected.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appA.database.query.groupRequestProjection.findFirst({
            where: eq(groupRequestProjection.requestId, projected.requestId),
          }),
        ).toMatchObject({ status: 'REVOKED' });
      },
      { timeout: 5000, interval: 100 },
    );

    const renewed = await request(appB.baseUrl)
      .post('/api/v1/group/federated-join-request')
      .set('Authorization', `Bearer ${tokenErin}`)
      .send({
        account: firstGroupAccount,
        domain: DOM_A,
        displayName: 'fed-group',
        note: 'renewed application',
      });
    expect(renewed.body.code).toBe(BusinessCode.OK);
    const renewedProjection = await vi.waitFor(
      async () => {
        const applicant = await appA.database.query.user.findFirst({
          where: and(
            eq(user.account, 'erin-join-projection'),
            eq(user.domain, DOM_B),
          ),
          columns: { id: true },
        });
        expect(applicant).toBeDefined();
        const row = await appA.database.query.groupRequestProjection.findFirst({
          where: and(
            eq(groupRequestProjection.managerUserId, aliceLocalIdA),
            eq(groupRequestProjection.threadId, firstGroupThreadA),
            eq(groupRequestProjection.memberUserId, applicant!.id),
            eq(groupRequestProjection.direction, 'APPLICATION'),
          ),
        });
        expect(row).toMatchObject({
          status: 'REQUESTED',
          note: 'renewed application',
        });
        expect(row!.feedId).toBeGreaterThan(projected.feedId);
        return row!;
      },
      { timeout: 5000, interval: 100 },
    );

    const revoked = await request(appB.baseUrl)
      .post('/api/v1/invite/revoke')
      .set('Authorization', `Bearer ${tokenErin}`)
      .send({ account: firstGroupAccount, domain: DOM_A });
    expect(revoked.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        const row = await appA.database.query.groupRequestProjection.findFirst({
          where: eq(
            groupRequestProjection.requestId,
            renewedProjection.requestId,
          ),
        });
        expect(row).toMatchObject({ status: 'REVOKED' });
        expect(row!.feedId).toBeGreaterThan(renewedProjection.feedId);
      },
      { timeout: 5000, interval: 100 },
    );
  });

  it('Step 3: a group mirror converges without requiring chat-open recovery', async () => {
    // The #1 fix: a group message that lands in the receiver-debounce window (or a transiently-lost push
    // with no follow-up) is recovered on chat-open by syncGroupMessagesOnOpen — the group twin of P2P's
    // pull-on-open. alice sends two messages; appB's mirror pulls both (pullUntil advances past them).
    await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: firstGroupThreadA,
        content: 'open-recover-1',
        contentType: 'PURE_TEXT',
      });
    await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: firstGroupThreadA,
        content: 'open-recover-2',
        contentType: 'PURE_TEXT',
      });
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, firstMirrorBId),
              eq(message.content, textContent('open-recover-1')),
            ),
          }),
        ).not.toBeNull();
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, firstMirrorBId),
              eq(message.content, textContent('open-recover-2')),
            ),
          }),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );

    // No chat-open request is made. The durable global feed is the recovery mechanism; old
    // thread-level pullUntil and open-message recovery are compatibility behavior only.
  }, 60_000);

  it('Step 3: two local members on the same mirror both receive an origin message (shared mirror)', async () => {
    // The untested topology path: TWO local members (bob + dave) on appB's SAME mirror thread. A pulled
    // message must SSE-fan to EVERY local active member (storePulledMessage's recipient loop), and the
    // mirror is SHARED (MessageThread.groupId @unique → one mirror per group, not one per local user).
    // Friend gate for the group invite: ACCEPTED state creates dave's stub.
    const daveFriendship = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: aliceLocalIdA,
      remoteUserId: daveLocalIdB,
      localToken: tokenA,
      remoteToken: tokenDave,
      localAccount: 'alice',
      remoteAccount: 'dave',
      localDomain: DOM_A,
      remoteDomain: DOM_B,
      note: 'hi dave',
    });
    daveStubIdOnA = daveFriendship.remoteStubIdOnLocal;
    // The group-invite friend gate keys on an active P2P thread alice↔dave on appB — wait for it.
    await vi.waitFor(
      async () => {
        expect(
          await findActiveP2pParticipant(appB, daveLocalIdB),
        ).not.toBeNull();
        expect(
          await findActiveP2pParticipant(appA, daveStubIdOnA),
        ).not.toBeNull();
        const pairThread = await appA.database.execute<{
          threadId: number;
        }>(sql`
          SELECT mine."threadId" FROM "ThreadMember" mine
          JOIN "ThreadMember" peer ON peer."threadId" = mine."threadId"
          JOIN "MessageThread" thread ON thread.id = mine."threadId" AND thread.type = 'P2P'
          WHERE mine."userId" = ${aliceLocalIdA} AND peer."userId" = ${daveStubIdOnA}
          LIMIT 1
        `);
        expect(pairThread.rows[0]).toBeDefined();
      },
      { timeout: 5000, interval: 100 },
    );

    // Force the next GROUP_META_HEAD to perform a full rebuild and seed one receiver-only current
    // member. The authoritative full snapshot must mark that absent member as departed while retaining
    // its source-scoped identity for already materialized data.
    const namespaceAOnB = await requireActiveNamespaceId(appB, DOM_A);
    const [staleIdentity] = await appB.database
      .insert(user)
      .values({
        account: 'stale-roster-member',
        domain: 'stale.test',
        sourceDomain: DOM_A,
        namespaceId: namespaceAOnB,
        name: 'Stale roster member',
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    await appB.database.insert(threadMember).values({
      threadId: firstMirrorBId,
      userId: staleIdentity.id,
      role: GroupRole.MEMBER,
      updatedAt: new Date(),
    });
    await appB.database
      .update(group)
      .set({ remoteGroupMetaFeedId: null, updatedAt: new Date() })
      .where(eq(group.id, firstMirrorGroupBId));

    // Invite dave to the SAME group bob is in; appB adds dave to the EXISTING mirror thread.
    const groupInviteDave = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: firstGroupThreadA, userIds: [daveStubIdOnA] });
    expect(groupInviteDave.body.code).toBe(BusinessCode.OK);
    expect(
      groupInviteDave.body.data.invited,
      JSON.stringify(groupInviteDave.body),
    ).toContain(daveStubIdOnA);
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          firstMirrorGroupBId,
          daveLocalIdB,
        );
        const pending = await appB.database.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.pairId, relationship.pair!.id),
            eq(relationshipIntent.authorSide, relationship.groupSide),
            eq(relationshipIntent.status, 'REQUESTED'),
          ),
        });
        expect(pending).toBeDefined();
      },
      { timeout: 5000 },
    );
    const daveAccept = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenDave}`)
      .send({ groupId: firstMirrorBId });
    expect(daveAccept.body.code).toBe(BusinessCode.OK);

    // dave is now on the SAME mirror thread as bob (the shared-mirror property).
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.threadMember.findFirst({
            where: and(
              eq(threadMember.userId, daveLocalIdB),
              eq(threadMember.threadId, firstMirrorBId),
            ),
          }),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );

    // Joining a federated mirror is two-phase: B authors USER→GROUP, then A activates it and returns
    // an authoritative GROUP_META. Do not treat B's first observed participant row as convergence;
    // require the origin roster and then the mirror roster to agree before exercising message fan-out.
    await vi.waitFor(
      async () => {
        const [daveOnOrigin] = await appA.database
          .select({ id: threadMember.id })
          .from(threadMember)
          .innerJoin(user, eq(user.id, threadMember.userId))
          .where(
            and(
              eq(threadMember.threadId, firstGroupThreadA),
              eq(user.account, 'dave'),
              eq(user.domain, DOM_B),
            ),
          )
          .limit(1);
        expect(daveOnOrigin?.id).toBeDefined();
      },
      { timeout: 5000 },
    );
    await vi.waitFor(
      async () => {
        const daveOnMirror = await appB.database.query.threadMember.findFirst({
          where: and(
            eq(threadMember.userId, daveLocalIdB),
            eq(threadMember.threadId, firstMirrorBId),
          ),
        });
        expect(daveOnMirror).not.toBeNull();
        const staleMember = await appB.database.query.threadMember.findFirst({
          where: and(
            eq(threadMember.threadId, firstMirrorBId),
            eq(threadMember.userId, staleIdentity.id),
          ),
        });
        expect(
          staleMember,
          'full group-meta rebuild must mark a receiver-only member as departed',
        ).toMatchObject({ left: true });
        expect(
          await appB.database.query.user.findFirst({
            where: eq(user.id, staleIdentity.id),
          }),
          'full group-meta rebuild must retain the departed source-scoped identity',
        ).toBeDefined();
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, firstMirrorBId),
              eq(message.contentType, ContentType.SYSTEM),
              sql`${message.content}::text like '%GROUP_JOINED%'`,
              sql`${message.content}::text like '%dave%'`,
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 5000 },
    );

    const [originGroup] = await appA.database
      .select({ groupId: messageThread.groupId })
      .from(messageThread)
      .where(eq(messageThread.id, firstGroupThreadA))
      .limit(1);
    const [originAudience, ownerPair] = await Promise.all([
      appA.database.query.threadAudience.findFirst({
        where: and(
          eq(threadAudience.targetDomain, DOM_B),
          eq(threadAudience.threadId, firstGroupThreadA),
          isNull(threadAudience.localUserId),
        ),
      }),
      findGroupRelationship(
        appA.database,
        originGroup.groupId!,
        aliceLocalIdA,
      ).then((relationship) => relationship.pair),
    ]);
    expect(
      { originAudience, ownerPair },
      'shared mirror must retain its domain audience and owner relationship',
    ).toMatchObject({
      originAudience: { targetDomain: DOM_B },
      ownerPair: { active: true },
    });
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appA.database,
          originGroup.groupId!,
          daveStubIdOnA,
        );
        const [pair, intents] = await Promise.all([
          relationship.pair,
          appA.database.query.relationshipIntent.findMany({
            where: eq(relationshipIntent.pairId, relationship.pair!.id),
          }),
        ]);
        expect(
          { pair, intents },
          'origin must finish both directed relationship facts before shared-mirror delivery',
        ).toMatchObject({ pair: { active: true } });
      },
      { timeout: 15_000, interval: 100 },
    );

    // Open BOTH SSE streams; alice sends; assert BOTH bob AND dave receive it (the multi-local-member fan).
    const readerBob = await openSse(appB.baseUrl, tokenB);
    const readerDave = await openSse(appB.baseUrl, tokenDave);
    const bobEvents = collectSseEvents(readerBob);
    const daveEvents = collectSseEvents(readerDave);
    try {
      // `openSse` resolves as soon as the server flushes `: connected`; registration happens
      // immediately after that write in the server process, so across processes the final connection
      // can still have a tiny not-yet-registered window. HELLO is the protocol-level ready barrier.
      await Promise.all([
        bobEvents.waitFor((event) => event === 'HELLO'),
        daveEvents.waitFor((event) => event === 'HELLO'),
      ]);
      const sharedSend = await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: firstGroupThreadA,
          content: 'hi both',
          contentType: 'PURE_TEXT',
        });
      expect(sharedSend.body.code, JSON.stringify(sharedSend.body)).toBe(
        BusinessCode.OK,
      );
      await vi.waitFor(
        async () => {
          const index =
            await appA.database.query.federationMessageFeedIndex.findFirst({
              where: and(
                eq(federationMessageFeedIndex.peerDomain, DOM_B),
                eq(federationMessageFeedIndex.threadId, firstGroupThreadA),
              ),
            });
          expect(index).toMatchObject({ messageEndSeq: expect.any(Number) });
        },
        { timeout: 5000, interval: 100 },
      );
      // 'hi both' is pulled into the SHARED mirror; capture its receiver-local seq once, then assert the
      // identity-only NEW_MESSAGE signal { threadId, seq, ts } reached BOTH local members — the fan must
      // iterate every active local member of the one mirror thread, not just the first.
      const hiBoth = await vi.waitFor(
        async () => {
          const [
            msg,
            sourceMessageCursor,
            sourceStateCursor,
            receiverMessageCursor,
            receiverStateCursor,
          ] = await Promise.all([
            appB.database.query.message.findFirst({
              where: and(
                eq(message.threadId, firstMirrorBId),
                eq(message.content, textContent('hi both')),
              ),
            }),
            appA.database.query.federationServeCursor.findFirst({
              where: eq(federationServeCursor.peerDomain, DOM_B),
            }),
            appA.database.query.peerStateFeedTarget.findFirst({
              where: eq(peerStateFeedTarget.peerDomain, DOM_B),
            }),
            appB.database.query.federationPullCursor.findFirst({
              where: eq(federationPullCursor.peerDomain, DOM_A),
            }),
            appB.database.query.peerStateFeedPullCursor.findFirst({
              where: eq(peerStateFeedPullCursor.peerDomain, DOM_A),
            }),
          ]);
          if (!msg) {
            throw new Error(
              `shared-mirror receiver cursor snapshot: ${JSON.stringify({
                sourceMessageAllocatedThrough:
                  sourceMessageCursor?.allocatedThrough?.toString(),
                sourceStateAllocatedThrough:
                  sourceStateCursor?.allocatedThrough?.toString(),
                receiverMessageCommittedThrough:
                  receiverMessageCursor?.committedThrough?.toString(),
                receiverStateCommittedThrough:
                  receiverStateCursor?.committedThrough?.toString(),
              })}`,
            );
          }
          return msg!;
        },
        { timeout: 30_000, interval: 100 },
      );
      const activeLocalRecipients = await appB.database
        .select({ userId: threadMember.userId })
        .from(threadMember)
        .innerJoin(user, eq(user.id, threadMember.userId))
        .where(
          and(
            eq(threadMember.threadId, firstMirrorBId),
            eq(user.domain, 'local'),
          ),
        );
      expect(activeLocalRecipients.map((row) => row.userId).sort()).toEqual(
        [bobLocalIdB, daveLocalIdB].sort(),
      );
      const isHiBothSignal = (event: string, data: unknown) =>
        event === 'NEW_MESSAGE' &&
        typeof data === 'object' &&
        data !== null &&
        (data as { threadId?: number }).threadId === firstMirrorBId &&
        (data as { seq?: number }).seq === hiBoth.seq;
      const [bobSignal, daveSignal] = (await Promise.all([
        bobEvents.waitFor(isHiBothSignal, 30_000).catch((error) => {
          throw new Error(
            `bob did not receive shared-mirror message: ${(error as Error).message}`,
          );
        }),
        daveEvents.waitFor(isHiBothSignal, 30_000).catch((error) => {
          throw new Error(
            `dave did not receive shared-mirror message: ${(error as Error).message}`,
          );
        }),
      ])) as Array<{ seq?: number }>;
      expect(bobSignal.seq).toBe(hiBoth.seq);
      expect(daveSignal.seq).toBe(hiBoth.seq);
    } finally {
      await readerBob.cancel();
      await readerDave.cancel();
    }
  }, 60_000);

  it('a mirror leave closes USER→GROUP and still delivers the boundary SYSTEM message', async () => {
    const leave = await request(appB.baseUrl)
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${tokenDave}`)
      .send({ groupId: firstMirrorBId, deleteData: false });
    expect(leave.status).toBe(200);
    expect(leave.body.code).toBe(BusinessCode.OK);

    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          firstMirrorGroupBId,
          daveLocalIdB,
        );
        const joinDirection =
          await appB.database.query.relationshipIntent.findFirst({
            where: and(
              eq(relationshipIntent.pairId, relationship.pair!.id),
              eq(relationshipIntent.authorSide, relationship.memberSide),
            ),
          });
        expect(joinDirection?.status).toBe('REVOKED');

        const pair = relationship.pair;
        expect(pair?.active).toBe(false);

        const originMember = await appA.database.query.threadMember.findFirst({
          where: and(
            eq(threadMember.userId, daveStubIdOnA),
            eq(threadMember.threadId, firstGroupThreadA),
          ),
        });
        expect(originMember).toMatchObject({ left: true });

        const boundaryMessage = await appA.database.query.message.findFirst({
          where: and(
            eq(message.threadId, firstGroupThreadA),
            eq(message.contentType, ContentType.SYSTEM),
            sql`${message.content}::text like '%GROUP_LEFT%'`,
          ),
          orderBy: desc(message.seq),
        });
        expect(boundaryMessage).toMatchObject({
          creatorAccount: null,
          creatorDomain: null,
        });
        expect(
          await appB.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.accountId, daveLocalIdB),
              eq(threadParticipant.threadId, firstMirrorBId),
              sql`${threadParticipant.messageVisibleBeforeSeq} IS NOT NULL`,
            ),
          }),
        ).toBeDefined();
        expect(
          await appB.database.query.federatedGroupMember.findFirst({
            where: and(
              eq(federatedGroupMember.sourcePeerDomain, DOM_A),
              eq(federatedGroupMember.memberAccount, 'dave'),
              eq(federatedGroupMember.memberDomain, DOM_B),
            ),
          }),
          'group-meta DEPART must retain and mark the historical member projection',
        ).toMatchObject({ left: true });
      },
      { timeout: 5000, interval: 100 },
    );
  });

  it('a member who rejoins a still-subscribed shared mirror can see messages from the gap', async () => {
    const duringDaveGap = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: firstGroupThreadA,
        content: textContent('group-gap-with-bob-still-present'),
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(duringDaveGap.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, firstMirrorBId),
              eq(
                message.content,
                textContent('group-gap-with-bob-still-present'),
              ),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 5000, interval: 100 },
    );

    const reinvite = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: firstGroupThreadA, userIds: [daveStubIdOnA] });
    expect(reinvite.body.code).toBe(BusinessCode.OK);
    expect(reinvite.body.data.invited, JSON.stringify(reinvite.body)).toContain(
      daveStubIdOnA,
    );
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          firstMirrorGroupBId,
          daveLocalIdB,
        );
        const requestRow =
          await appB.database.query.relationshipIntent.findFirst({
            where: and(
              eq(relationshipIntent.pairId, relationship.pair!.id),
              eq(relationshipIntent.authorSide, relationship.groupSide),
            ),
          });
        expect(requestRow?.status).toBe('REQUESTED');
      },
      { timeout: 5000, interval: 100 },
    );
    const rejoin = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenDave}`)
      .send({ groupId: firstMirrorBId });
    expect(rejoin.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        const davePair = (
          await findGroupRelationship(
            appB.database,
            firstMirrorGroupBId,
            daveLocalIdB,
          )
        ).pair;
        expect(davePair?.active).toBe(true);
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, firstMirrorBId),
              eq(
                message.content,
                textContent('group-gap-with-bob-still-present'),
              ),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 5000, interval: 100 },
    );
  });

  it('last-member leave revokes blocked boundary access; rejoin resumes without gap history', async () => {
    // Leave dave first so bob's later leave is the last member from appB.
    const daveLeaveAgain = await request(appB.baseUrl)
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${tokenDave}`)
      .send({ groupId: firstMirrorBId, deleteData: false });
    expect(daveLeaveAgain.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        const pair = (
          await findGroupRelationship(
            appB.database,
            firstMirrorGroupBId,
            daveLocalIdB,
          )
        ).pair;
        expect(pair?.active).toBe(false);
      },
      { timeout: 5000, interval: 100 },
    );

    proxy.blockMessageFeed(true);
    try {
      const finalBeforeLeave = await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: firstGroupThreadA,
          content: textContent('group-final-before-last-peer-leave'),
          contentType: ContentType.PURE_TEXT,
          clientMessageId: randomUUID(),
        });
      expect(finalBeforeLeave.body.code).toBe(BusinessCode.OK);
      await vi.waitFor(
        () => expect(proxy.blockedMessageFeedCount()).toBeGreaterThan(0),
        { timeout: 5000, interval: 100 },
      );

      const bobLeave = await request(appB.baseUrl)
        .post('/api/v1/group/leave')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: firstMirrorBId, deleteData: false });
      expect(bobLeave.body.code).toBe(BusinessCode.OK);
      await vi.waitFor(
        async () => {
          const [bobOnOrigin, originAudience, bobOnMirror] = await Promise.all([
            appA.database.query.threadMember.findFirst({
              where: and(
                eq(threadMember.userId, bobStubIdOnA),
                eq(threadMember.threadId, firstGroupThreadA),
              ),
            }),
            appA.database.query.threadAudience.findFirst({
              where: and(
                eq(threadAudience.targetDomain, DOM_B),
                eq(threadAudience.threadId, firstGroupThreadA),
              ),
            }),
            appB.database.query.threadMember.findFirst({
              where: and(
                eq(threadMember.userId, bobLocalIdB),
                eq(threadMember.threadId, firstMirrorBId),
              ),
            }),
          ]);
          expect(bobOnOrigin).toBeDefined();
          expect(originAudience).toBeUndefined();
          expect(bobOnMirror).toBeDefined();
        },
        { timeout: 5000, interval: 100 },
      );
    } finally {
      proxy.blockMessageFeed(false);
    }

    // Authorization is the origin's current audience fact. Once the last member leaves, a message
    // that was blocked in transit is no longer queryable and must not arrive from historical state.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, firstMirrorBId),
          eq(
            message.content,
            textContent('group-final-before-last-peer-leave'),
          ),
        ),
      }),
    ).toBeUndefined();

    const targetBeforeGap =
      await appA.database.query.federationServeCursor.findFirst({
        where: eq(federationServeCursor.peerDomain, DOM_B),
      });
    const absentGap = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: firstGroupThreadA,
        content: textContent('group-gap-with-no-peer-members'),
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(absentGap.body.code).toBe(BusinessCode.OK);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const targetAfterGap =
      await appA.database.query.federationServeCursor.findFirst({
        where: eq(federationServeCursor.peerDomain, DOM_B),
      });
    expect(targetAfterGap?.allocatedThrough).toBe(
      targetBeforeGap?.allocatedThrough,
    );
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, firstMirrorBId),
          eq(message.content, textContent('group-gap-with-no-peer-members')),
        ),
      }),
    ).toBeUndefined();

    const reinviteBob = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: firstGroupThreadA, userIds: [bobStubIdOnA] });
    expect(reinviteBob.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          firstMirrorGroupBId,
          bobLocalIdB,
        );
        const invite = await appB.database.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.pairId, relationship.pair?.id ?? 0n),
            eq(relationshipIntent.authorSide, relationship.groupSide),
          ),
        });
        expect(invite?.status).toBe('REQUESTED');
      },
      { timeout: 5000, interval: 100 },
    );
    const bobRejoin = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: firstMirrorBId });
    expect(bobRejoin.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        const [originAudience, localAudience, bobOnMirror] = await Promise.all([
          appA.database.query.threadAudience.findFirst({
            where: and(
              eq(threadAudience.targetDomain, DOM_B),
              eq(threadAudience.threadId, firstGroupThreadA),
            ),
          }),
          appB.database.query.threadAudience.findFirst({
            where: and(
              eq(threadAudience.targetDomain, 'local'),
              eq(threadAudience.localUserId, bobLocalIdB),
              eq(threadAudience.threadId, firstMirrorBId),
            ),
          }),
          appB.database.query.threadMember.findFirst({
            where: and(
              eq(threadMember.userId, bobLocalIdB),
              eq(threadMember.threadId, firstMirrorBId),
            ),
          }),
        ]);
        expect(originAudience).toBeDefined();
        expect(localAudience).toBeDefined();
        expect(bobOnMirror).toBeDefined();
      },
      { timeout: 5000, interval: 100 },
    );

    // Rejoin reuses the same mirror id, does not backfill the no-member gap,
    // and resumes delivery for messages created from this point onward.
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, firstMirrorBId),
          eq(message.content, textContent('group-gap-with-no-peer-members')),
        ),
      }),
    ).toBeUndefined();
    const afterRejoin = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: firstGroupThreadA,
        content: textContent('group-after-last-peer-rejoin'),
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(afterRejoin.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, firstMirrorBId),
              eq(message.content, textContent('group-after-last-peer-rejoin')),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 5000, interval: 100 },
    );
  }, 90_000);

  it('allows an immediate mirror leave and rejoin before the origin observes the leave', async () => {
    await appA.stop();
    try {
      const leave = await request(appB.baseUrl)
        .post('/api/v1/group/leave')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: firstMirrorBId, deleteData: false });
      expect(leave.body.code).toBe(BusinessCode.OK);
      expect(
        await appB.database.query.threadParticipant.findFirst({
          where: and(
            eq(threadParticipant.threadId, firstMirrorBId),
            eq(threadParticipant.accountId, bobLocalIdB),
          ),
        }),
      ).toMatchObject({ messageVisibleBeforeSeq: expect.any(Number) });
      expect(
        (
          await findGroupRelationship(
            appB.database,
            firstMirrorGroupBId,
            bobLocalIdB,
          )
        ).pair,
      ).toMatchObject({ active: false });

      // JOIN replaces the unserved leave on the compacted directional key.
      // The local server must accept it even though the origin still believes
      // Bob is a member, and must wait for a fresh origin GROUP_META.
      const rejoin = await request(appB.baseUrl)
        .post('/api/v1/group/join-request')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: firstMirrorBId });
      expect(rejoin.body.code).toBe(BusinessCode.OK);
      const relationship = await findGroupRelationship(
        appB.database,
        firstMirrorGroupBId,
        bobLocalIdB,
      );
      const pending = await appB.database.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.pairId, relationship.pair!.id),
          eq(relationshipIntent.authorSide, relationship.memberSide),
        ),
      });
      // The member explicitly rejoins against the currently observed origin ACCEPTED,
      // so its authored direction is immediately ACCEPTED even before the origin
      // observes the intervening REVOKED revision.
      expect(pending?.status).toBe('ACCEPTED');
    } finally {
      await appA.restart();
    }

    await vi.waitFor(
      async () => {
        const [originMember, mirrorMember] = await Promise.all([
          appA.database.query.threadMember.findFirst({
            where: and(
              eq(threadMember.threadId, firstGroupThreadA),
              eq(threadMember.userId, bobStubIdOnA),
            ),
          }),
          appB.database.query.threadMember.findFirst({
            where: and(
              eq(threadMember.threadId, firstMirrorBId),
              eq(threadMember.userId, bobLocalIdB),
            ),
          }),
        ]);
        expect(originMember).toBeDefined();
        expect(mirrorMember).toBeDefined();
        const relationship = await findGroupRelationship(
          appB.database,
          firstMirrorGroupBId,
          bobLocalIdB,
        );
        const join = await appB.database.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.pairId, relationship.pair!.id),
            eq(relationshipIntent.authorSide, relationship.memberSide),
          ),
        });
        expect(join?.status).toBe('ACCEPTED');
      },
      // Feed-head notifications are ephemeral. If the wake-up races appA's restart, the durable
      // missed-feed sweep is the correctness backstop and may take one scheduler interval.
      { timeout: 40_000, interval: 150 },
    );
  }, 90_000);

  it('rejects an unsupported federated join and clears the mirror pending state', async () => {
    const created = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'full-fed-group' });
    expect(created.body.code).toBe(BusinessCode.OK);
    const originThreadId = created.body.data.threadId as number;
    const invited = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: originThreadId, userIds: [daveStubIdOnA] });
    expect(invited.body.code).toBe(BusinessCode.OK);
    const originThread = await findGroupThreadById(appA, originThreadId);
    const groupAccount = originThread!.group.account;
    const mirror = await vi.waitFor(
      async () => {
        const row = await findGroupThreadByAccount(appB, groupAccount);
        expect(row).toBeDefined();
        return row!;
      },
      // Group propagation is durable but asynchronous. Under a full multi-worker
      // run it can fall back to the missed-feed sweep instead of the immediate
      // wake-up, so use the same budget as the other durable-feed assertions.
      { timeout: 40_000, interval: 150 },
    );

    // Simulate a stale or dishonest mirror-side invitation. It lets Bob author
    // a validly signed join intent, but the origin has never reserved his slot
    // and must enforce its own capacity policy when that intent arrives.
    const requestedAt = new Date();
    const [dishonestPair] = await appB.database
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'GROUP',
        endpointAAccount: mirror.group.account,
        endpointADomain: mirror.group.domain,
        endpointBType: 'USER',
        endpointBAccount: 'bob',
        endpointBDomain: 'local',
        threadId: mirror.id,
        active: false,
        updatedAt: requestedAt,
      })
      .onConflictDoUpdate({
        target: [
          relationshipPair.endpointAType,
          relationshipPair.endpointAAccount,
          relationshipPair.endpointADomain,
          relationshipPair.endpointBType,
          relationshipPair.endpointBAccount,
          relationshipPair.endpointBDomain,
        ],
        set: { threadId: mirror.id, updatedAt: requestedAt },
      })
      .returning({ id: relationshipPair.id });
    await appB.database.insert(relationshipIntent).values({
      pairId: dishonestPair.id,
      authorSide: 'A',
      status: 'REQUESTED',
      note: '',
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      updatedAt: requestedAt,
    });

    const accepted = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: mirror.id });
    expect(accepted.body.code).toBe(BusinessCode.OK);

    await vi.waitFor(
      async () => {
        const [invite, join] = await Promise.all([
          appB.database.query.relationshipIntent.findFirst({
            where: and(
              eq(relationshipIntent.pairId, dishonestPair.id),
              eq(relationshipIntent.authorSide, 'A'),
            ),
          }),
          appB.database.query.relationshipIntent.findFirst({
            where: and(
              eq(relationshipIntent.pairId, dishonestPair.id),
              eq(relationshipIntent.authorSide, 'B'),
            ),
          }),
        ]);
        expect(invite).toMatchObject({
          status: 'REVOKED',
          note: '',
        });
        expect(join?.status).toBe('ACCEPTED');
        const mirrorAuthorization =
          await appB.database.query.relationshipPair.findFirst({
            where: eq(relationshipPair.id, dishonestPair.id),
            columns: { active: true },
          });
        expect(mirrorAuthorization?.active).toBe(false);
      },
      { timeout: 5000, interval: 100 },
    );
    const originAuthorization = await findGroupRelationship(
      appA.database,
      originThread!.groupId,
      bobStubIdOnA,
    );
    expect(originAuthorization.pair?.active ?? false).toBe(false);
    expect(
      await appA.database.query.message.findFirst({
        where: and(
          eq(message.threadId, originThreadId),
          eq(message.contentType, ContentType.SYSTEM),
          sql`${message.content}::text like '%GROUP_JOINED%'`,
          sql`${message.content}::text like '%bob%'`,
        ),
      }),
    ).toBeUndefined();
  }, 60_000);

  it('unfriend removes the current feed projection and re-add resumes only with later messages', async () => {
    const oldThreadA = await findActiveP2pBetween(
      appA,
      aliceLocalIdA,
      bobStubIdOnA,
    );
    const oldThreadB = await findActiveP2pBetween(
      appB,
      bobLocalIdB,
      aliceStubIdOnB,
    );
    expect(oldThreadA).toBeDefined();
    expect(oldThreadB).toBeDefined();

    // Keep B offline so A has an unconsumed message projection. Unfriend removes
    // that projection; REVOKED carries no feed boundary or message content.
    await appB.stop();
    const lastBeforeDelete = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: oldThreadA!.threadId,
        content: textContent('last-before-unfriend'),
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(lastBeforeDelete.body.code).toBe(BusinessCode.OK);

    // The two discovery indexes are independent. Seed a tombstone projection so
    // this transition proves that close removes both current stable keys.
    await appA.database.transaction(async (tx) => {
      const [head] = await tx
        .update(federationTombstoneServeCursor)
        .set({
          allocatedThrough: sql`${federationTombstoneServeCursor.allocatedThrough} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(federationTombstoneServeCursor.peerDomain, DOM_B))
        .returning({ feedId: federationTombstoneServeCursor.allocatedThrough });
      expect(head).toBeDefined();
      await tx
        .insert(federationTombstoneFeedIndex)
        .values({
          peerDomain: DOM_B,
          threadId: oldThreadA!.threadId,
          feedId: head!.feedId,
          tombstoneEndSeq: 1,
        })
        .onConflictDoUpdate({
          target: [
            federationTombstoneFeedIndex.peerDomain,
            federationTombstoneFeedIndex.threadId,
          ],
          set: { feedId: head!.feedId, tombstoneEndSeq: 1 },
        });
    });

    const res = await request(appA.baseUrl)
      .post('/api/v1/user/delete-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(
      await appA.database.query.federationMessageFeedIndex.findFirst({
        where: and(
          eq(federationMessageFeedIndex.peerDomain, DOM_B),
          eq(federationMessageFeedIndex.threadId, oldThreadA!.threadId),
        ),
      }),
    ).toBeUndefined();
    expect(
      await appA.database.query.federationTombstoneFeedIndex.findFirst({
        where: and(
          eq(federationTombstoneFeedIndex.peerDomain, DOM_B),
          eq(federationTombstoneFeedIndex.threadId, oldThreadA!.threadId),
        ),
      }),
    ).toBeUndefined();

    // appA tore it down — the P2P thread is soft-left (no active thread between alice and bob's stub).
    const threadA = await findActiveP2pParticipant(appA, bobStubIdOnA);
    expect(threadA).toBeUndefined();

    // The delete transaction owns the thread lock, so later sends cannot race
    // past the leave boundary.
    const rejectedAfterDelete = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: oldThreadA!.threadId,
        content: textContent('must-not-exist'),
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(rejectedAfterDelete.body.code).toBe(BusinessCode.FRIEND_NOT_FOUND);

    // B has not consumed A's NOT_FRIEND state. A must still accept an
    // immediate re-add; the compacted directional feed exposes only the newest
    // revision when B comes back, so the stale remote FRIEND cannot block it.
    const revive = await request(appA.baseUrl)
      .post('/api/v1/invite/federated-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        account: 'bob',
        domain: DOM_B,
        displayName: 'Bob',
        note: 'revive from alice',
      });
    expect(revive.body.code).toBe(BusinessCode.OK);
    expect(
      await findActiveP2pBetween(appA, aliceLocalIdA, bobStubIdOnA),
    ).toEqual(oldThreadA);

    await appB.restart();

    await vi.waitFor(
      async () => {
        expect(
          await findActiveP2pBetween(appB, aliceStubIdOnB, bobLocalIdB),
        ).toEqual(oldThreadB);
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, oldThreadB!.threadId),
              eq(message.content, textContent('last-before-unfriend')),
            ),
          }),
        ).toBeUndefined();
      },
      { timeout: 40_000, interval: 150 },
    );
    await vi.waitFor(
      async () => {
        expect(
          await findActiveP2pBetween(appA, aliceLocalIdA, bobStubIdOnA),
        ).toEqual(oldThreadA);
        expect(
          await findActiveP2pBetween(appB, bobLocalIdB, aliceStubIdOnB),
        ).toEqual(oldThreadB);
      },
      { timeout: 40_000, interval: 150 },
    );

    const [resumedAudience, targetBeforeContinue, peerBeforeContinue] =
      await Promise.all([
        appA.database.query.threadAudience.findFirst({
          where: and(
            eq(threadAudience.threadId, oldThreadA!.threadId),
            eq(threadAudience.targetDomain, DOM_B),
          ),
        }),
        appA.database.query.federationServeCursor.findFirst({
          where: eq(federationServeCursor.peerDomain, DOM_B),
        }),
        appA.database.query.federatedPeer.findFirst({
          where: eq(federatedPeer.domain, DOM_B),
        }),
      ]);
    expect(resumedAudience).toBeDefined();
    expect(resumedAudience!.messageAccessAfterSeq).toBeGreaterThanOrEqual(
      lastBeforeDelete.body.data.seq,
    );
    expect(peerBeforeContinue?.trustLevel).toBe('available');

    const continued = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: oldThreadA!.threadId,
        content: textContent('after-re-add'),
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(continued.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(async () => {
      const targetAfterContinue =
        await appA.database.query.federationServeCursor.findFirst({
          where: eq(federationServeCursor.peerDomain, DOM_B),
        });
      expect(targetAfterContinue!.allocatedThrough).toBeGreaterThan(
        targetBeforeContinue!.allocatedThrough,
      );
    });
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, oldThreadB!.threadId),
              eq(message.content, textContent('after-re-add')),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 40_000, interval: 150 },
    );
  }, 120_000);

  it('materializes a federated unfriend as a local exclusive SYSTEM/feed visibility boundary on the receiving server', async () => {
    const threadA = await findActiveP2pBetween(
      appA,
      aliceLocalIdA,
      bobStubIdOnA,
    );
    const threadB = await findActiveP2pBetween(
      appB,
      bobLocalIdB,
      aliceStubIdOnB,
    );
    expect(threadA).toBeDefined();
    expect(threadB).toBeDefined();

    const response = await request(appA.baseUrl)
      .post('/api/v1/user/delete-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(response.body.code).toBe(BusinessCode.OK);

    await vi.waitFor(
      async () => {
        expect(
          await findActiveP2pBetween(appB, bobLocalIdB, aliceStubIdOnB),
        ).toBeUndefined();
        const boundary = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, threadB!.threadId),
            eq(message.contentType, ContentType.SYSTEM),
            sql`${message.content}::text like '%FRIEND_REMOVED%'`,
          ),
          orderBy: desc(message.seq),
        });
        expect(boundary).toMatchObject({
          creatorAccount: null,
          creatorDomain: null,
        });
        const participant =
          await appB.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.threadId, threadB!.threadId),
              eq(threadParticipant.accountId, bobLocalIdB),
            ),
          });
        expect(participant?.messageVisibleBeforeSeq).toBe(boundary!.seq + 1);
        expect(
          await appB.database.query.clientMessageFeed.findFirst({
            where: and(
              eq(clientMessageFeed.userId, bobLocalIdB),
              eq(clientMessageFeed.threadId, threadB!.threadId),
              eq(clientMessageFeed.messageEndSeq, boundary!.seq),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 40_000, interval: 150 },
    );
  }, 60_000);

  it('rejects an inbound state wake-up signed by an untrusted domain', async () => {
    // evil.local: a real Ed25519 key, but never init'd → not in FederatedPeer.
    const evilPriv = ed25519.utils.randomSecretKey();
    const evilKeypair = {
      getKeyId: () => `${DOM_A}-evil/key-1`, // signer domain = "aaa.local-evil" → not trusted
      getPrivateKey: () => evilPriv,
      getPublicKeyB64: () =>
        Buffer.from(ed25519.getPublicKey(evilPriv)).toString('base64'),
    };
    const evilSig = new SignatureService(evilKeypair as never);
    const authority = `127.0.0.1:${appA.port}`;
    const body = JSON.stringify({
      stateFeedEndId: '1',
      messageFeedEndId: '1',
      tombstoneFeedEndId: '1',
    });
    const headers = await evilSig.signOutbound({
      method: 'POST',
      url: new URL(`http://${authority}/s2s/v1/feed-heads`),
      body,
    });

    const res = await fetch(`http://${authority}/s2s/v1/feed-heads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe(BusinessCode.FEDERATION_RECOGNITION_REQUIRED);
  });

  // ─── trust lifecycle: degrade on failure → re-handshake → halt ───────────────────────────────
  // These run after the friend-flow tests; aaa↔bbb are still mutually trusted (unfriending above is
  // local-only and does not degrade). They drive the state machine through real signed S2S traffic:
  // a dead loopback URL forces a network failure → markTransportDegraded; restoring it → ensurePeerTrusted
  // re-handshakes → markTrusted; markBlocked → resolve surfaces FEDERATION_PEER_BLOCKED.

  it('degrades a healthy peer on transport failure while retaining certificates', async () => {
    // Precondition: aaa still trusts bbb, and bbb's signing keys are cached on aaa (fetched at init).
    const peerBefore = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(peerBefore?.trustLevel).toBe('available');
    const keysBefore = await appA.database.query.s2SKeyCache.findMany({
      where: eq(s2SKeyCache.domain, DOM_B),
    });
    expect(keysBefore.length).toBeGreaterThan(0);

    // STOP appB, then resolve a user which is not already localized. Resolving bob again would now be a
    // local cache hit and deliberately performs no network request, so it cannot exercise degradation.
    // The uncached lookup reaches fetchRemoteUser and gets a real ECONNREFUSED → markTransportDegraded(DOM_B).
    await appB.stop();
    try {
      const res = await resolveFederatedCard(
        appA,
        tokenA,
        'unreachable',
        DOM_B,
      );
      expect(res).toEqual({ event: 'failed', data: { reason: 'UNREACHABLE' } });

      // A reconnect ping already in flight when stop() began may finish just after the failed GET and
      // temporarily recover the peer. Once that bounded race has drained, a second operation leaves the
      // peer stably degraded (or fails fast because it already is degraded).
      await new Promise((resolve) => setTimeout(resolve, 250));
      await resolveFederatedCard(appA, tokenA, 'still-unreachable', DOM_B);

      // aaa marked bbb degraded: state flipped, count bumped and the event is logged. Pinned keys are continuity
      // evidence, so a transient outage must retain them for the signed-heartbeat recovery below.
      const peerAfter = await appA.database.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, DOM_B),
      });
      expect(peerAfter?.trustLevel).toBe('degraded');
      expect(peerAfter?.remoteServiceReachable).toBe(false);
      expect(peerAfter?.degradationCount).toBeGreaterThanOrEqual(1);
      expect(peerAfter?.degradedAt).not.toBeNull();
      expect(peerAfter?.degradationReason).toMatch(
        /network\/timeout|HTTP 5\d\d/,
      );

      const degradedEvent =
        await appA.database.query.federatedPeerEvent.findFirst({
          where: and(
            eq(federatedPeerEvent.domain, DOM_B),
            eq(federatedPeerEvent.type, 'degraded'),
          ),
        });
      expect(degradedEvent).toBeDefined();
      expect(degradedEvent!.reason).toMatch(/network\/timeout|HTTP 5\d\d/);

      const keysAfter = await appA.database.query.s2SKeyCache.findMany({
        where: eq(s2SKeyCache.domain, DOM_B),
      });
      expect(keysAfter).toHaveLength(keysBefore.length);
    } finally {
      // Always restore the shared fixture, including when an assertion above fails, so the recovery
      // test reports its own behavior instead of inheriting an ECONNREFUSED cascade.
      await appB.restart();
    }
  });

  it('recovers a degraded peer through Health without replacing recognition facts', async () => {
    const beforeRecovery = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(beforeRecovery?.identityPinnedAt).toBeInstanceOf(Date);
    // The reconnect sweep may already have healed the outage from the preceding test. Put only this
    // local trust edge back into the exact precondition so identity recovery is deterministic.
    await appA.database
      .update(federatedPeer)
      .set({
        trustLevel: 'degraded',
        remoteServiceReachable: false,
        degradedAt: new Date(),
        degradationReason: 'deterministic identity recovery fixture',
      })
      .where(eq(federatedPeer.domain, DOM_B));
    const res = await resolveFederatedCard(appA, tokenA, 'bob', DOM_B);
    expect(res.event).toBe('resolved');

    const peer = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(peer?.trustLevel).toBe('available');
    expect(peer?.remoteServiceReachable).toBe(true);
    expect(peer?.degradedAt).toBeNull();
    expect(peer?.degradationReason).toBeNull();
    expect(peer?.identityPinnedAt?.getTime()).toBe(
      beforeRecovery?.identityPinnedAt?.getTime(),
    );

    // peerEvents is newest-first. The state is `trusted`, while the lifecycle transition is named
    // `recovered` distinguishes identity recovery from first-contact trust establishment.
    const eventsRes = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/events`)
      .set('Cookie', adminCookieA)
      .send({ take: 50 });
    const types = (eventsRes.body.data as { type: string }[]).map(
      (e) => e.type,
    );
    expect(types).toContain('degraded');
  });

  it('lets a super-admin recover identity loss only after the exact original pin returns', async () => {
    const before = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    const beforeOnB = await appB.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_A),
    });
    expect(before?.trustLevel).toBe('available');
    expect(before?.identityPinnedAt).toBeInstanceOf(Date);
    expect(before?.rootPublicKey).toBeTruthy();
    expect(before?.rootKeyFingerprint).toBeTruthy();

    // This represents the state left by a poisoned DNS answer. The proxy now points at the original
    // appB again, so the explicit admin probe must discard its discovery cache and prove every old pin.
    await appA.database
      .update(federatedPeer)
      .set({
        trustLevel: 'halted',
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: 'e2e simulated transient DNS identity contradiction',
      })
      .where(eq(federatedPeer.domain, DOM_B));
    // Both sides may have observed poisoned DNS. A lost peer can still obtain the signed proof with
    // its original key, but serving that proof must not silently restore the responder's trust edge.
    await appB.database
      .update(federatedPeer)
      .set({
        trustLevel: 'halted',
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: 'e2e simulated reciprocal identity contradiction',
      })
      .where(eq(federatedPeer.domain, DOM_A));

    const wrongConfirmation = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/recover-identity`)
      .set('Cookie', adminCookieA)
      .send({ confirmDomain: DOM_A });
    expect(wrongConfirmation.status).toBe(400);
    expect(wrongConfirmation.body.code).toBe(BusinessCode.VALIDATION_FAILED);

    const recovered = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/recover-identity`)
      .set('Cookie', adminCookieA)
      .send({ confirmDomain: DOM_B });
    expect(recovered.status).toBe(200);
    expect(recovered.body.data).toEqual({
      domain: DOM_B,
      trustLevel: 'degraded',
    });

    const after = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(after?.trustLevel).toBe('degraded');
    expect(after?.haltedAt).toBeNull();
    expect(after?.haltCode).toBeNull();
    expect(after?.haltReason).toBeNull();
    expect(after?.trustedAt?.getTime()).toBe(before?.trustedAt?.getTime());
    expect(after?.rootPublicKey).toBe(before?.rootPublicKey);
    expect(after?.rootKeyFingerprint).toBe(before?.rootKeyFingerprint);

    const stillLostOnB = await appB.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_A),
    });
    expect(stillLostOnB?.trustLevel).toBe('halted');

    const recoveredOnB = await request(appB.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_A}/recover-identity`)
      .set('Cookie', adminCookieB)
      .send({ confirmDomain: DOM_A });
    expect(recoveredOnB.status).toBe(200);
    const afterOnB = await appB.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_A),
    });
    expect(afterOnB?.trustLevel).toBe('degraded');
    expect(afterOnB?.trustedAt?.getTime()).toBe(
      beforeOnB?.trustedAt?.getTime(),
    );

    const newestEvent = await appA.database.query.federatedPeerEvent.findFirst({
      where: eq(federatedPeerEvent.domain, DOM_B),
      orderBy: [desc(federatedPeerEvent.createdAt)],
    });
    expect(newestEvent).toMatchObject({
      type: 'recovered',
      reason: 'administrator verified the original pinned identity',
    });
  });

  it('blocks a peer: resolve fails fast with FEDERATION_PEER_BLOCKED + admin reads work', async () => {
    // Admin blocks bbb on appA via the real admin route (→ markBlocked). Then resolve must NOT attempt a
    // handshake — it surfaces FEDERATION_PEER_BLOCKED (distinct from an unreachable peer).
    await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/block`)
      .set('Cookie', adminCookieA)
      .send({ note: 'abuse' });
    const blocked = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(blocked).toMatchObject({
      trustLevel: 'halted',
      haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
    });

    const res = await resolveFederatedCard(appA, tokenA, 'bob', DOM_B);
    expect(res).toEqual({ event: 'failed', data: { reason: 'BLOCKED' } });

    // Admin reads (the admin page's data sources, via their real routes): the list filters by state; the
    // timeline (newest-first) carries the full discovered → trusted → degraded → trusted → blocked process.
    const listRes = await request(appA.baseUrl)
      .post('/api/v1/admin/federation/peers')
      .set('Cookie', adminCookieA)
      .send({ skip: 0, take: 10, status: 'halted' });
    expect(
      (listRes.body.data.list as { domain: string }[]).some(
        (p) => p.domain === DOM_B,
      ),
    ).toBe(true);

    const tlRes = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/events`)
      .set('Cookie', adminCookieA)
      .send({ take: 50 });
    const types = (tlRes.body.data as { type: string }[]).map((e) => e.type);
    expect(types).toContain('discovered');
    expect(types).toContain('degraded');
    expect(types[0]).toBe('halted');
  });
});
