import {
  groupState as group,
  groupStateFields,
} from '../src/group/shared/group-state.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../src/user/account-address.js';
import type { NamespacedAddress } from '../src/common/client-identity.js';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  onTestFinished,
  vi,
} from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  bootFederationPair,
  ensureFederationDbs,
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
import {
  waitForAcceptedDurableTask,
  waitForAcceptedDurableTasks,
} from './durable-task-helpers.js';
import { SignatureService } from '../src/federation/signature.service.js';
import {
  ContentType,
  GroupRole,
  MessageThreadType,
} from '../src/database/enums.js';
import { and, count, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  account,
  federationMessageReceipt,
  federationThreadSyncState,
  forwardBundle,
  forwardBundleAsset,
  forwardBundleDependency,
  forwardMessage,
  groupMeta,
  groupMetaMemberFeed,
  groupRequestProjection,
  relationshipPair,
  relationshipIntent,
  mediaAsset,
  messageAsset,
  message,
  clientStateFeed,
  durableTask,
  messageThread,
  peerStateFeed,
  s2SKeyCache,
  accountThreadState,
  threadAudience,
  profileTable,
  identityNamespace,
  systemSetting,
} from '../src/database/schema.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCurrentGroupMemberByAddressInTx } from '../src/group/meta/current-group-roster.js';
import { encodeFederationResourceComponent } from '../src/federation/federation-resource-request.js';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../src/federation/federation-history-access-setting.js';

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
  let bobAddressOnA: NamespacedAddress; // Bob's source-scoped address on appA
  let aliceAddressOnB: NamespacedAddress; // Alice's source-scoped address on appB
  let aliceLocalIdA: number;
  let bobLocalIdB: number;
  let adminCookieA: string; // super-admin on appA — admin_session cookie pair for the block test + admin reads
  let png2: Buffer; // second avatar (distinct color) for the re-pull test
  let firstGroupThreadA: number; // the first federated group's ORIGIN thread on appA (reused by later group tests)
  let firstMirrorBId: number; // that group's MIRROR thread on appB
  let firstMirrorGroupBId: number; // mirror-local group identity; scopes directed membership rows
  let firstGroupAccount: string; // its `!account` — the on-wire group address
  let tokenDave: string; // dave @ appB — a SECOND local member of the same mirror (shared-mirror fan-out test)
  let daveLocalIdB: number;
  let daveAddressOnA: NamespacedAddress;
  let adminCookieB: string;

  async function findActiveP2pParticipant(app: FedApp, target: AccountTarget) {
    const identity = await accountAddressInTx(app.database, target);
    const result = await app.database.execute<{ threadId: number }>(sql`
      SELECT pair."threadId"
      FROM "RelationshipPair" pair
      JOIN "MessageThread" thread
        ON thread.id = pair."threadId" AND thread.type = 'P2P'
      WHERE pair.kind = 'P2P'
        AND pair.active = true
        AND (
          (pair."endpointAAccount" = ${identity.account}
            AND pair."endpointANamespaceId" = ${identity.namespaceId})
          OR
          (pair."endpointBAccount" = ${identity.account}
            AND pair."endpointBNamespaceId" = ${identity.namespaceId})
        )
      LIMIT 1
    `);
    return result.rows[0];
  }

  async function findActiveP2pBetween(
    app: FedApp,
    firstUserId: AccountTarget,
    secondUserId: AccountTarget,
  ) {
    const relationship = await findP2PRelationship(
      app.database,
      firstUserId,
      secondUserId,
    );
    return relationship.pair?.active && relationship.pair.threadId !== null
      ? { threadId: relationship.pair.threadId }
      : undefined;
  }

  async function countMessages(app: FedApp, condition: ReturnType<typeof eq>) {
    const [row] = await app.database
      .select({ count: count() })
      .from(message)
      .where(condition);
    return row.count;
  }

  async function requireActiveNamespaceId(app: FedApp, domain: string) {
    const peer = await app.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, domain),
        eq(identityNamespace.active, true),
      ),
      columns: { id: true },
    });
    if (peer?.id == null) {
      throw new Error(`No active namespace for federated peer ${domain}`);
    }
    return peer.id;
  }

  const textContent = (value: string) => JSON.stringify({ text: value });

  async function findGroupThreadByAccount(app: FedApp, account: string) {
    const [row] = await app.database
      .select({
        id: messageThread.id,
        groupId: messageThread.id,
        pullUntil: messageThread.pullUntil,
        account: groupStateFields.account,
        name: groupStateFields.name,
        domain: groupStateFields.domain,
        namespaceId: groupStateFields.namespaceId,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
      .where(eq(groupStateFields.account, account))
      .limit(1);
    return row
      ? {
          ...row,
          group: {
            id: row.groupId!,
            account: row.account,
            name: row.name,
            domain: row.domain,
            namespaceId: row.namespaceId,
          },
        }
      : undefined;
  }

  async function findCurrentGroupMemberByAddress(
    app: FedApp,
    threadId: number,
    identity: { account: string; domain: string },
  ) {
    return app.database.transaction(async (tx) => {
      const [thread] = await tx
        .select({ groupId: messageThread.id })
        .from(messageThread)
        .where(eq(messageThread.id, threadId))
        .limit(1);
      return thread?.groupId
        ? readCurrentGroupMemberByAddressInTx(tx, thread.groupId, identity)
        : undefined;
    });
  }

  async function findGroupThreadById(app: FedApp, threadId: number) {
    const [row] = await app.database
      .select({
        groupId: messageThread.id,
        account: groupStateFields.account,
        domain: groupStateFields.domain,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
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
    // Persist a small, valid range size so the fixture crosses multiple requests. Inserting before
    // boot means the subprocesses load runtime policy from their own database rather than process
    // env; no restart is needed. SystemSetting survives the harness truncation.
    const transport = JSON.stringify({
      keyCacheTtlSec: 21_600,
      connectTimeoutSec: 12,
      callTimeoutSec: 12,
      mediaChunkBytes: 262_144,
      mediaChunkTimeoutSec: 120,
      mediaMaxChunkRetries: 5,
    });
    const { urlA, urlB } = await ensureFederationDbs();
    await Promise.all(
      [urlA, urlB].map(async (url) => {
        const pool = new Pool({ connectionString: url });
        try {
          await pool.query(
            `INSERT INTO "SystemSetting" ("key", "value", "updatedAt")
             VALUES ('federation:transport', $1, NOW())
             ON CONFLICT ("key") DO UPDATE
             SET "value" = EXCLUDED."value", "updatedAt" = EXCLUDED."updatedAt"`,
            [transport],
          );
        } finally {
          await pool.end();
        }
      }),
    );
    ({ appA, appB, proxy } = await bootFederationPair());
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
      user: { id: 0, domain: DOM_B },
    });
    expect(resolved.data).not.toHaveProperty('relationship');
    expect(
      await appA.database.query.account.findFirst({
        where: and(eq(account.account, 'bob'), eq(account.domain, DOM_B)),
      }),
    ).toBeUndefined();

    const repeated = await resolveFederatedCard(appA, tokenA, 'bob', DOM_B);
    expect(repeated.event).toBe('resolved');
    expect(
      await appA.database.query.account.findFirst({
        where: and(eq(account.account, 'bob'), eq(account.domain, DOM_B)),
      }),
    ).toBeUndefined();

    // appA now trusts bbb.local.
    const peerA = await appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_B),
        eq(identityNamespace.active, true),
      ),
    });
    expect(peerA?.trustLevel).toBe('available');
    expect(peerA?.trustedAt).toBeInstanceOf(Date);
    expect(peerA).toMatchObject({
      recognizesPeer: true,
      peerAcceptanceConfirmed: true,
      localServiceAvailable: true,
      remoteServiceReachable: true,
    });
    const peerB = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
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

  it('resolves the profile revision referenced by an addressed request', async () => {
    const [namespaceBOnA, namespaceAOnB] = await Promise.all([
      requireActiveNamespaceId(appA, DOM_B),
      requireActiveNamespaceId(appB, DOM_A),
    ]);
    const res = await request(appA.baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        account: 'bob',
        domain: DOM_B,
        displayName: 'Bob',
        note: 'hi from aaa',
      });
    expect(res.status).toBe(200);
    expect(res.body.code, JSON.stringify(res.body)).toBe(BusinessCode.OK);
    // The addressed request commits synchronously through the intent family;
    // delivery to the origin is the peer feed pull asserted below.
    expect(res.body.data).toMatchObject({ status: 'OK' });

    const incoming = await vi.waitFor(
      async () => {
        const rows = await appB.database.execute<{ profileRev: number }>(sql`
          SELECT intent."profileRev"
          FROM "RelationshipIntent" intent
          JOIN "RelationshipPair" pair
            ON pair."endpointAAccount" = intent."receiverAccount"
           AND pair."endpointANamespaceId" = intent."receiverNamespaceId"
           AND pair."endpointBAccount" = intent."authorAccount"
           AND pair."endpointBNamespaceId" = intent."authorNamespaceId"
          WHERE pair.kind = 'P2P'
            AND pair."endpointBAccount" = 'alice'
            AND pair."endpointBNamespaceId" = ${namespaceAOnB}
          LIMIT 1
        `);
        const row = rows.rows[0];
        expect(row).toBeDefined();
        expect(row?.profileRev).toBeGreaterThan(0);
        return row!;
      },
      { timeout: 5000, interval: 100 },
    );
    const publishedProfile = await request(appB.baseUrl)
      .get('/api/v1/test/signed-s2s-get')
      .query({
        peerDomain: DOM_A,
        path: `/s2s/v1/profiles/alice?rev=${incoming.profileRev}`,
      });
    expect(publishedProfile.body.status).toBe(200);
    expect(publishedProfile.body.body).toMatchObject({
      code: BusinessCode.OK,
      data: {
        account: 'alice',
        domain: DOM_A,
        profileRev: incoming.profileRev,
      },
    });

    const incomingProfile = await vi.waitFor(
      async () => {
        const profile = await appB.database.query.profileTable.findFirst({
          where: and(
            eq(profileTable.account, 'alice'),
            eq(profileTable.domain, DOM_A),
            eq(profileTable.profileNamespaceId, namespaceAOnB),
            eq(profileTable.profileRev, incoming.profileRev),
          ),
        });
        expect(profile).toBeDefined();
        return profile!;
      },
      { timeout: 5000, interval: 100 },
    );
    const incomingTimings = await appB.database.execute<{
      requestedAt: Date;
      expiresAt: Date;
    }>(sql`
      SELECT intent."requestedAt", intent."expiresAt"
      FROM "RelationshipIntent" intent
      WHERE intent."profileRev" = ${incoming.profileRev}
        AND intent."authorAccount" = 'alice'
        AND intent."authorNamespaceId" = ${namespaceAOnB}
      LIMIT 1
    `);
    const incomingTiming = incomingTimings.rows[0];
    expect(incomingTiming).toBeDefined();
    expect(
      new Date(incomingTiming!.expiresAt).getTime() -
        new Date(incomingTiming!.requestedAt).getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);
    expect(incoming.profileRev).toBeGreaterThan(0);
    expect(incomingProfile.displayName).toBe('Alice');
    expect(incomingProfile.avatar).toMatch(
      /^\/uploads\/avatars\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|gif|webp)$/,
    );

    const publishedRequest = await appA.database.query.peerStateFeed.findFirst({
      where: and(
        eq(peerStateFeed.peerDomain, DOM_B),
        eq(peerStateFeed.namespaceId, namespaceBOnA),
        eq(peerStateFeed.account, 'alice'),
        eq(peerStateFeed.subjectAccount, 'bob'),
        eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
      ),
    });
    expect(publishedRequest).toBeDefined();

    const accepted = await request(appB.baseUrl)
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ account: 'alice', domain: DOM_A });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    // The address-only acceptance activates synchronously on the accepting
    // side; the origin learns through the peer state-feed push.
    expect(accepted.body.data).toMatchObject({ status: 'OK' });

    aliceAddressOnB = {
      account: 'alice',
      domain: DOM_A,
      namespaceId: namespaceAOnB,
    };
    bobAddressOnA = {
      account: 'bob',
      domain: DOM_B,
      namespaceId: namespaceBOnA,
    };

    await vi.waitFor(
      async () => {
        for (const [app, localId, peerId] of [
          [appA, aliceLocalIdA, bobAddressOnA],
          [appB, bobLocalIdB, aliceAddressOnB],
        ] as const) {
          const relationship = await findP2PRelationship(
            app.database,
            localId,
            peerId,
          );
          const rows = await app.database
            .select()
            .from(relationshipIntent)
            .where(
              or(
                and(
                  eq(
                    relationshipIntent.authorAccount,
                    relationship.firstEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.authorNamespaceId,
                    relationship.firstEndpoint.namespaceId,
                  ),
                  eq(
                    relationshipIntent.receiverAccount,
                    relationship.secondEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.receiverNamespaceId,
                    relationship.secondEndpoint.namespaceId,
                  ),
                ),
                and(
                  eq(
                    relationshipIntent.authorAccount,
                    relationship.secondEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.authorNamespaceId,
                    relationship.secondEndpoint.namespaceId,
                  ),
                  eq(
                    relationshipIntent.receiverAccount,
                    relationship.firstEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.receiverNamespaceId,
                    relationship.firstEndpoint.namespaceId,
                  ),
                ),
              ),
            );
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
    const threadB = await findActiveP2pParticipant(appB, aliceAddressOnB);
    expect(threadB).toBeDefined();
    const threadA = await findActiveP2pParticipant(appA, bobAddressOnA);
    expect(threadA).toBeDefined();

    // ACCEPTED references Bob's exact profile revision; the profile snapshot is
    // stored separately from the stable foreign identity shell.
    await vi.waitFor(
      async () => {
        const bobProfileA = await appA.database.query.profileTable.findFirst({
          where: and(
            eq(profileTable.account, bobAddressOnA.account),
            eq(profileTable.domain, bobAddressOnA.domain),
            eq(profileTable.profileNamespaceId, bobAddressOnA.namespaceId),
          ),
        });
        expect(bobProfileA?.avatar).toMatch(
          /^\/uploads\/avatars\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|gif|webp)$/,
        );
      },
      { timeout: 5000, interval: 100 },
    );
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
    const betaAddressOnA = {
      account: betaAccount,
      domain: DOM_B,
      namespaceId: namespaceBOnA,
    };
    const alphaAddressOnB = {
      account: alphaAccount,
      domain: DOM_A,
      namespaceId: namespaceAOnB,
    };

    proxy.blockStateFeed(true);
    try {
      const fromA = await request(appA.baseUrl)
        .post('/api/v1/relationship/request')
        .set('Authorization', `Bearer ${alpha.token}`)
        .send({
          account: betaAccount,
          domain: DOM_B,
          displayName: 'Cross Beta',
          note: 'A request',
        });
      expect(fromA.body.code).toBe(BusinessCode.OK);
      // Both crossed requests commit synchronously; with the state feeds
      // blocked their peer items park until the unblock below.
      expect(fromA.body.data).toMatchObject({ status: 'OK' });

      const fromB = await request(appB.baseUrl)
        .post('/api/v1/relationship/request')
        .set('Authorization', `Bearer ${beta.token}`)
        .send({
          account: alphaAccount,
          domain: DOM_A,
          displayName: 'Cross Alpha',
          note: 'B request',
        });
      expect(fromB.body.code).toBe(BusinessCode.OK);
      // The live reverse request collapses into acceptance on B; the thread
      // id may already be present even while the feeds are blocked.
      expect(fromB.body.data).toMatchObject({ status: 'OK' });

      await vi.waitFor(
        () => expect(proxy.blockedStateFeedCount()).toBeGreaterThan(0),
        { timeout: 5000, interval: 50 },
      );
      await vi.waitFor(
        async () => {
          const relationship = await findP2PRelationship(
            appA.database,
            alpha.id,
            betaAddressOnA,
          );
          const directions =
            await appA.database.query.relationshipIntent.findMany({
              where: or(
                and(
                  eq(
                    relationshipIntent.authorAccount,
                    relationship.firstEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.authorNamespaceId,
                    relationship.firstEndpoint.namespaceId,
                  ),
                  eq(
                    relationshipIntent.receiverAccount,
                    relationship.secondEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.receiverNamespaceId,
                    relationship.secondEndpoint.namespaceId,
                  ),
                ),
                and(
                  eq(
                    relationshipIntent.authorAccount,
                    relationship.secondEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.authorNamespaceId,
                    relationship.secondEndpoint.namespaceId,
                  ),
                  eq(
                    relationshipIntent.receiverAccount,
                    relationship.firstEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.receiverNamespaceId,
                    relationship.firstEndpoint.namespaceId,
                  ),
                ),
              ),
            });
          expect(
            directions.find(
              (row) =>
                row.authorAccount === relationship.firstEndpoint.account &&
                row.authorNamespaceId ===
                  relationship.firstEndpoint.namespaceId,
            ),
          ).toMatchObject({ status: 'ACCEPTED', expiresAt: null });
          const secondDirection = directions.find(
            (row) =>
              row.authorAccount === relationship.secondEndpoint.account &&
              row.authorNamespaceId === relationship.secondEndpoint.namespaceId,
          );
          // A crossed local request can collapse the second direction before
          // its peer acknowledgement is delivered.
          expect(['REQUESTED', 'ACCEPTED']).toContain(secondDirection?.status);
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
          [appA, alpha.id, betaAddressOnA],
          [appB, beta.id, alphaAddressOnB],
        ] as const) {
          const relationship = await findP2PRelationship(
            app.database,
            localId,
            peerId,
          );
          const directions =
            await app.database.query.relationshipIntent.findMany({
              where: or(
                and(
                  eq(
                    relationshipIntent.authorAccount,
                    relationship.firstEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.authorNamespaceId,
                    relationship.firstEndpoint.namespaceId,
                  ),
                  eq(
                    relationshipIntent.receiverAccount,
                    relationship.secondEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.receiverNamespaceId,
                    relationship.secondEndpoint.namespaceId,
                  ),
                ),
                and(
                  eq(
                    relationshipIntent.authorAccount,
                    relationship.secondEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.authorNamespaceId,
                    relationship.secondEndpoint.namespaceId,
                  ),
                  eq(
                    relationshipIntent.receiverAccount,
                    relationship.firstEndpoint.account,
                  ),
                  eq(
                    relationshipIntent.receiverNamespaceId,
                    relationship.firstEndpoint.namespaceId,
                  ),
                ),
              ),
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
    const p = await findActiveP2pParticipant(appA, bobAddressOnA);
    if (!p?.threadId) throw new Error('alice↔bob thread missing on appA');
    return p.threadId;
  }

  /** Keep media tests individually runnable under Vitest's `-t`. Friendship is formed by the two
   * directed requests converging; there is no separate federated accept task. */
  async function ensureAliceAndBobAreFriends(): Promise<void> {
    if (bobAddressOnA && (await findActiveP2pParticipant(appA, bobAddressOnA)))
      return;

    await establishFederatedFriendship({
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
    bobAddressOnA = {
      account: 'bob',
      domain: DOM_B,
      namespaceId: await requireActiveNamespaceId(appA, DOM_B),
    };
    aliceAddressOnB = {
      account: 'alice',
      domain: DOM_A,
      namespaceId: await requireActiveNamespaceId(appB, DOM_A),
    };
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

  it('Step 2: a federated message advances the peer client feed and emits its throttled wake', async () => {
    const beforeFeed = await appB.database.query.account.findFirst({
      where: eq(account.id, bobLocalIdB),
      columns: { threadFeedEndId: true },
    });
    expect(beforeFeed).toBeDefined();
    // Open bob's SSE stream before alice sends so the throttled state-feed wake is observed end to end.
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
      // The peer hint starts the state and thread rounds. Poll for the stored receiver-local identity.
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
          expect(source?.originSeq).toBe(remoteCopy?.originSeq);
          expect(source?.originServerTime).toBeNull();
          const namespaceId = await requireActiveNamespaceId(appA, DOM_B);
          const receipt =
            await appA.database.query.federationMessageReceipt.findFirst({
              where: and(
                eq(federationMessageReceipt.namespaceId, namespaceId),
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
      const wake = (await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'THREAD_FEED_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { threadFeedEndId?: unknown }).threadFeedEndId ===
            'number' &&
          (data as { threadFeedEndId: number }).threadFeedEndId >
            beforeFeed!.threadFeedEndId,
        10_000,
      )) as { threadFeedEndId: number };
      expect(wake.threadFeedEndId).toBeGreaterThan(beforeFeed!.threadFeedEndId);
      await vi.waitFor(
        async () => {
          const head = await appB.database.query.accountThreadState.findFirst({
            where: and(
              eq(accountThreadState.accountId, bobLocalIdB),
              eq(accountThreadState.threadId, bobLocalThreadId),
            ),
          });
          expect(head?.messageEndSeq).toBeGreaterThanOrEqual(bobLocalSeq);
        },
        { timeout: 10_000, interval: 100 },
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
          quote: { namespaceId: 0, seq: original.body.data.seq },
        });
      },
      { timeout: 5000 },
    );
  });

  it('quotes, directly forwards, and repeatedly federates every forwardable type with byte-exact bundle assets', async () => {
    await ensureAliceAndBobAreFriends();

    // Keep the source conversation local to appA. The remote node cannot see these messages or their
    // assets until the HISTORY carrier reaches it, so a successful assertion below necessarily travels
    // through GET /s2s/v1/forward-bundles/:id + signed Range media downloads.
    const sourcePeerAccount = `forwardpeer${randomUUID().slice(0, 8)}`;
    const sourcePeer = await registerAndLogin(
      appA,
      sourcePeerAccount,
      'Forward Source Peer',
    );
    const [sourceThread] = await appA.database
      .insert(messageThread)
      .values({ type: MessageThreadType.P2P, updatedAt: new Date() })
      .returning({ id: messageThread.id });
    await seedAcceptedRelationship(
      appA.database,
      aliceLocalIdA,
      sourcePeer.id,
      sourceThread.id,
    );

    const fixtureBytes = new Map<string, Buffer>();
    const addFixture = async (label: string): Promise<string> => {
      const bytes = Buffer.from(`forward-e2e:${label}:${randomUUID()}`);
      const digest = createHash('sha256').update(bytes).digest('hex');
      fixtureBytes.set(digest, bytes);
      const shard = join(
        appA.dataDir,
        'cas',
        digest.slice(0, 2),
        digest.slice(2, 4),
      );
      await mkdir(shard, { recursive: true });
      await writeFile(join(shard, digest), bytes);
      await appA.database.insert(mediaAsset).values({
        digest,
        bytes: BigInt(bytes.length),
      });
      return digest;
    };
    const cas = (digest: string) =>
      `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;

    const [
      imageDigest,
      videoDigest,
      audioDigest,
      fileDigest,
      linkImageDigest,
      linkFaviconDigest,
      contactAvatarDigest,
      galleryImageDigest,
      galleryVideoDigest,
      galleryAudioDigest,
      galleryFileDigest,
    ] = await Promise.all(
      [
        'image',
        'video',
        'audio',
        'file',
        'link-image',
        'link-favicon',
        'contact-avatar',
        'gallery-image',
        'gallery-video',
        'gallery-audio',
        'gallery-file',
      ].map(addFixture),
    );

    const now = Date.now();
    const sourceSpecs: Array<{
      contentType: ContentType;
      content: string;
      digests: string[];
    }> = [
      {
        contentType: ContentType.PURE_TEXT,
        content: textContent('all-types text'),
        digests: [],
      },
      {
        contentType: ContentType.IMAGE,
        content: JSON.stringify({
          url: cas(imageDigest),
          w: 7,
          h: 5,
          size: fixtureBytes.get(imageDigest)!.length,
        }),
        digests: [imageDigest],
      },
      {
        contentType: ContentType.VIDEO,
        content: JSON.stringify({
          url: cas(videoDigest),
          name: 'clip.webm',
          size: fixtureBytes.get(videoDigest)!.length,
          mimeType: 'video/webm',
          w: 16,
          h: 9,
          duration: 2.5,
        }),
        digests: [videoDigest],
      },
      {
        contentType: ContentType.AUDIO,
        content: JSON.stringify({
          url: cas(audioDigest),
          name: 'voice.ogg',
          size: fixtureBytes.get(audioDigest)!.length,
          mimeType: 'audio/ogg',
          duration: 1.25,
        }),
        digests: [audioDigest],
      },
      {
        contentType: ContentType.FILE,
        content: JSON.stringify({
          url: cas(fileDigest),
          name: 'report.bin',
          size: fixtureBytes.get(fileDigest)!.length,
          mimeType: 'application/octet-stream',
        }),
        digests: [fileDigest],
      },
      {
        contentType: ContentType.LINK,
        content: JSON.stringify({
          url: 'https://example.test/all-types',
          title: 'All forward types',
          description: 'Link artwork must remain part of the bundle closure.',
          image: cas(linkImageDigest),
          favicon: cas(linkFaviconDigest),
        }),
        digests: [linkImageDigest, linkFaviconDigest],
      },
      {
        contentType: ContentType.CONTACT_CARD,
        content: JSON.stringify({
          account: sourcePeerAccount,
          domain: 'local',
          displayName: 'Forward Contact',
          bio: 'Contact-card avatar fixture',
          avatar: cas(contactAvatarDigest),
        }),
        digests: [contactAvatarDigest],
      },
      {
        contentType: ContentType.GALLERY,
        content: JSON.stringify({
          items: [
            {
              kind: 'IMAGE',
              url: cas(galleryImageDigest),
              size: fixtureBytes.get(galleryImageDigest)!.length,
              w: 4,
              h: 3,
            },
            {
              kind: 'VIDEO',
              url: cas(galleryVideoDigest),
              size: fixtureBytes.get(galleryVideoDigest)!.length,
              name: 'gallery.webm',
              mimeType: 'video/webm',
              w: 16,
              h: 9,
              duration: 3,
            },
            {
              kind: 'AUDIO',
              url: cas(galleryAudioDigest),
              size: fixtureBytes.get(galleryAudioDigest)!.length,
              name: 'gallery.ogg',
              mimeType: 'audio/ogg',
              duration: 4,
            },
            {
              kind: 'FILE',
              url: cas(galleryFileDigest),
              size: fixtureBytes.get(galleryFileDigest)!.length,
              name: 'gallery.bin',
              mimeType: 'application/octet-stream',
            },
          ],
        }),
        digests: [
          galleryImageDigest,
          galleryVideoDigest,
          galleryAudioDigest,
          galleryFileDigest,
        ],
      },
    ];

    const sourceRows = await appA.database.transaction(async (tx) => {
      const rows = [];
      for (const [index, spec] of sourceSpecs.entries()) {
        const seq = index + 1;
        const [row] = await tx
          .insert(message)
          .values({
            seq,
            originSeq: seq,
            profileRev: 1,
            contentType: spec.contentType,
            content: spec.content,
            threadId: sourceThread.id,
            creatorAccount: 'alice',
            creatorDomain: 'local',
            createdAt: new Date(now + index),
            updatedAt: new Date(now + index),
          })
          .returning({ id: message.id, seq: message.seq });
        if (spec.digests.length > 0) {
          await tx.insert(messageAsset).values(
            spec.digests.map((digest) => ({
              messageId: row.id,
              threadId: sourceThread.id,
              digest,
            })),
          );
        }
        rows.push(row);
      }
      await tx
        .update(messageThread)
        .set({
          curSeq: sourceSpecs.length,
          updatedAt: new Date(now + sourceSpecs.length - 1),
        })
        .where(eq(messageThread.id, sourceThread.id));
      return rows;
    });

    // Quote every supported source shape through the real local HTTP endpoint, then verify that the
    // query endpoint enriches each stored seq-only reference with the correct target type.
    const replyIds: string[] = [];
    for (const [index, source] of sourceRows.entries()) {
      const clientMessageId = randomUUID();
      replyIds.push(clientMessageId);
      const reply = await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: sourceThread.id,
          contentType: ContentType.PURE_TEXT,
          clientMessageId,
          content: JSON.stringify({
            text: `reply to ${sourceSpecs[index].contentType}`,
            quote: { seq: source.seq },
          }),
        });
      expect(reply.body.code).toBe(BusinessCode.OK);
    }
    const quoted = await request(appA.baseUrl)
      .post('/api/v1/query-messages')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ threadId: sourceThread.id, after: 0, take: 50 });
    expect(quoted.body.code).toBe(BusinessCode.OK);
    // Annotated so the key stays `string` (not `string | undefined`) and the
    // value keeps the row shape for the seq/content assertions below.
    const quotedById = new Map<
      string,
      { clientMessageId?: string; content: string; seq: number }
    >(
      quoted.body.data.messages.map(
        (item: { clientMessageId?: string; content: string; seq: number }) => [
          item.clientMessageId as string,
          item,
        ],
      ),
    );
    for (const [index, clientMessageId] of replyIds.entries()) {
      expect(
        JSON.parse(quotedById.get(clientMessageId)!.content).quote,
      ).toMatchObject({
        seq: sourceRows[index].seq,
        contentType: sourceSpecs[index].contentType,
      });
    }

    // First make an inner local bundle from all nine concrete types. It becomes the tenth (FORWARD)
    // source type in the outer bundle that is actually sent across the federation boundary.
    const innerId = randomUUID();
    const inner = await request(appA.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: sourceThread.id,
        sourceMessages: sourceRows.map((row) => ({
          threadId: sourceThread.id,
          seq: row.seq,
        })),
        mode: 'HISTORY',
        clientMessageId: innerId,
      });
    expect(inner.body.code).toBe(BusinessCode.OK);
    expect(inner.body.data.contentType).toBe(ContentType.FORWARD);
    const innerSeq = inner.body.data.seq as number;

    const forwardQuoteId = randomUUID();
    const forwardQuote = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: sourceThread.id,
        contentType: ContentType.PURE_TEXT,
        clientMessageId: forwardQuoteId,
        content: JSON.stringify({
          text: 'reply to nested forward',
          quote: { seq: innerSeq },
        }),
      });
    expect(forwardQuote.body.code).toBe(BusinessCode.OK);

    const allQuoted = await request(appA.baseUrl)
      .post('/api/v1/query-messages')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: sourceThread.id,
        after: 0,
        through: forwardQuote.body.data.seq,
        take: 50,
      });
    const forwardQuoteRow = allQuoted.body.data.messages.find(
      (item: { clientMessageId?: string }) =>
        item.clientMessageId === forwardQuoteId,
    );
    expect(JSON.parse(forwardQuoteRow.content).quote).toMatchObject({
      seq: innerSeq,
      contentType: ContentType.FORWARD,
    });

    // Exercise DIRECT through the real local API for every allowed type, including FORWARD. A quoted
    // text reply is also directly forwarded to prove that reply context is intentionally stripped.
    const directSources: Array<{
      seq: number;
      contentType: ContentType;
      stripsQuote?: boolean;
    }> = [
      ...sourceRows.map((row, index) => ({
        seq: row.seq,
        contentType: sourceSpecs[index].contentType,
      })),
      { seq: innerSeq, contentType: ContentType.FORWARD },
      {
        seq: quotedById.get(replyIds[0])!.seq,
        contentType: ContentType.PURE_TEXT,
        stripsQuote: true,
      },
    ];
    for (const source of directSources) {
      const direct = await request(appA.baseUrl)
        .post('/api/v1/send-forward')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: sourceThread.id,
          sourceMessages: [{ threadId: sourceThread.id, seq: source.seq }],
          mode: 'DIRECT',
          clientMessageId: randomUUID(),
        });
      expect(direct.body.code).toBe(BusinessCode.OK);
      expect(direct.body.data.contentType).toBe(source.contentType);
      if (source.stripsQuote) {
        expect(JSON.parse(direct.body.data.content)).not.toHaveProperty(
          'quote',
        );
      }
    }

    const destinationThreadA = await alicesThreadIdOnA();
    const outerClientMessageId = randomUUID();
    // The outer carrier contains the source rows and one complete inner bundle.
    const outerMessageCount = sourceRows.length * 2 + 1;
    const outerPayload = {
      threadId: destinationThreadA,
      sourceMessages: [
        ...sourceRows.map((row) => ({
          threadId: sourceThread.id,
          seq: row.seq,
        })),
        { threadId: sourceThread.id, seq: innerSeq },
      ],
      mode: 'HISTORY',
      clientMessageId: outerClientMessageId,
    };
    const outer = await request(appA.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(outerPayload);
    expect(outer.status).toBe(200);
    expect(outer.body.code).toBe(BusinessCode.OK);

    // HTTP retry must return the exact carrier instead of creating another bundle/message.
    const retry = await request(appA.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(outerPayload);
    expect(retry.body.data.seq).toBe(outer.body.data.seq);
    expect(
      await countMessages(
        appA,
        eq(message.clientMessageId, outerClientMessageId),
      ),
    ).toBe(1);

    let importedOnB: Awaited<ReturnType<typeof findLatestForwardMessage>>;
    await vi.waitFor(
      async () => {
        importedOnB = await findLatestForwardMessage(appB, {
          account: 'alice',
          domain: DOM_A,
        });
        expect(importedOnB?.forwardMessage?.bundle.messageCount).toBe(
          outerMessageCount,
        );
      },
      { timeout: 15_000, interval: 100 },
    );

    const closureResponse = await request(appB.baseUrl)
      .get(`/api/v1/forward-bundles/${importedOnB!.forwardMessage!.bundleId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(closureResponse.body.code).toBe(BusinessCode.OK);
    const closure = closureResponse.body.data as {
      messages: Array<{
        contentType: ContentType;
        content: string;
        childBundleId?: string;
      }>;
      children: Array<{
        id: string;
        messages: Array<{ contentType: ContentType }>;
      }>;
      assets: Array<{ digest: string; bytes: number }>;
      accessContext: { threadId: number; seq: number };
    };
    expect(closure.messages.map((item) => item.contentType)).toEqual([
      ...sourceSpecs.map((item) => item.contentType),
      ContentType.FORWARD,
    ]);
    const nestedCard = closure.messages.at(-1)!;
    expect(nestedCard.childBundleId).toBe(closure.children[0]?.id);
    expect(JSON.parse(nestedCard.content)).toEqual({
      bundleId: nestedCard.childBundleId,
    });
    expect(closure.children).toHaveLength(1);
    expect(
      closure.children[0].messages.map((item) => item.contentType),
    ).toEqual(sourceSpecs.map((item) => item.contentType));
    expect(new Set(closure.assets.map((asset) => asset.digest)).size).toBe(
      closure.assets.length,
    );
    for (const digest of fixtureBytes.keys()) {
      expect(closure.assets.map((asset) => asset.digest)).toContain(digest);
    }

    // Every declared closure asset, including profile snapshots, must become byte-identical local CAS
    // data and be readable through appB's normal bearer + per-forward-message authorization boundary.
    await vi.waitFor(
      async () => {
        for (const asset of closure.assets) {
          const row = await appB.database.query.mediaAsset.findFirst({
            where: and(
              eq(mediaAsset.digest, asset.digest),
              eq(mediaAsset.isDeleted, false),
            ),
          });
          expect(row?.bytes).toBe(BigInt(asset.bytes));
          const local = await readFile(
            join(
              appB.dataDir,
              'cas',
              asset.digest.slice(0, 2),
              asset.digest.slice(2, 4),
              asset.digest,
            ),
          );
          expect(createHash('sha256').update(local).digest('hex')).toBe(
            asset.digest,
          );
        }
      },
      { timeout: 20_000, interval: 100 },
    );
    for (const asset of closure.assets) {
      const download = await request(appB.baseUrl)
        .get(
          `${cas(asset.digest)}?threadId=${closure.accessContext.threadId}&seq=${closure.accessContext.seq}`,
        )
        .set('Authorization', `Bearer ${tokenB}`)
        .buffer(true);
      expect(download.status).toBe(200);
      expect(Buffer.isBuffer(download.body)).toBe(true);
      expect(createHash('sha256').update(download.body).digest('hex')).toBe(
        asset.digest,
      );
    }

    // Re-wrap the received carrier twice more (B→A→B). Each pass must retain the complete flat
    // descendant closure and increase the aggregate message count by exactly one.
    const nestedOnB = await request(appB.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: importedOnB!.threadId,
        sourceMessages: [
          { threadId: importedOnB!.threadId, seq: importedOnB!.seq },
        ],
        mode: 'HISTORY',
        clientMessageId: randomUUID(),
      });
    expect(nestedOnB.body.code).toBe(BusinessCode.OK);

    let relayedOnA: Awaited<ReturnType<typeof findLatestForwardMessage>>;
    await vi.waitFor(
      async () => {
        relayedOnA = await findLatestForwardMessage(appA, {
          account: 'bob',
          domain: DOM_B,
        });
        expect(relayedOnA?.forwardMessage?.bundle.messageCount).toBe(
          outerMessageCount + 1,
        );
        expect(
          await appA.database.query.forwardBundleDependency.findMany({
            where: eq(
              forwardBundleDependency.parentBundleId,
              relayedOnA!.forwardMessage!.bundleId,
            ),
          }),
        ).toHaveLength(2);
      },
      { timeout: 15_000, interval: 100 },
    );

    const depth4ClientMessageId = randomUUID();
    const nestedOnA = await request(appA.baseUrl)
      .post('/api/v1/send-forward')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: relayedOnA!.threadId,
        sourceMessages: [
          { threadId: relayedOnA!.threadId, seq: relayedOnA!.seq },
        ],
        mode: 'HISTORY',
        clientMessageId: depth4ClientMessageId,
      });
    expect(nestedOnA.body.code).toBe(BusinessCode.FORWARD_MAX_DEPTH_EXCEEDED);
    expect(
      await countMessages(
        appA,
        eq(message.clientMessageId, depth4ClientMessageId),
      ),
    ).toBe(0);

    const depth3Bundle = relayedOnA!.forwardMessage!.bundleId;
    expect(
      await appA.database.query.forwardBundle.findFirst({
        where: eq(forwardBundle.id, depth3Bundle),
      }),
    ).toBeDefined();
  }, 120_000);

  it('Step 2: a federated image localizes on the peer (media round-trip, same-origin)', async () => {
    // alice uploads an image on appA (fixture) → a CAS url. Sent as an IMAGE message whose content
    // embeds the URL shape extractDigestEntries scans for the digest and declared size.
    const { url, digest } = await sendFederatedImage(
      await makePng(Math.floor(Math.random() * 256), 16),
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

    const { url, size, digest } = await sendFederatedImage(imageBytes);

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
    const peer = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
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

  it('resolves the exact profile revision carried by a later message', async () => {
    const before = await appA.database.query.account.findFirst({
      where: eq(account.id, aliceLocalIdA),
      columns: { defaultProfileRev: true },
    });
    expect(before).toBeDefined();
    await uploadAvatar(appA, tokenA, png2);
    const source = await appA.database.query.account.findFirst({
      where: eq(account.id, aliceLocalIdA),
      columns: { defaultProfileRev: true },
    });
    expect(source!.defaultProfileRev).toBeGreaterThan(
      before!.defaultProfileRev,
    );
    expect(
      await appB.database.query.profileTable.findFirst({
        where: and(
          and(
            eq(profileTable.account, aliceAddressOnB.account),
            eq(profileTable.domain, aliceAddressOnB.domain),
            eq(profileTable.profileNamespaceId, aliceAddressOnB.namespaceId),
          ),
          eq(profileTable.profileRev, source!.defaultProfileRev),
        ),
      }),
    ).toBeUndefined();

    const marker = `profile-rev-${randomUUID()}`;
    const sent = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        content: marker,
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(sent.body.code).toBe(BusinessCode.OK);

    const materialized = await vi.waitFor(
      async () => {
        const profile = await appB.database.query.profileTable.findFirst({
          where: and(
            and(
              eq(profileTable.account, aliceAddressOnB.account),
              eq(profileTable.domain, aliceAddressOnB.domain),
              eq(profileTable.profileNamespaceId, aliceAddressOnB.namespaceId),
            ),
            eq(profileTable.profileRev, source!.defaultProfileRev),
          ),
        });
        expect(profile).toBeDefined();
        return profile!;
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(materialized).toMatchObject({
      profileRev: source!.defaultProfileRev,
    });
    expect(materialized?.avatar).toMatch(
      /^\/uploads\/avatars\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|gif|webp)$/,
    );
  });

  it('removes the legacy client peer-profile sync endpoint', async () => {
    const res = await request(appB.baseUrl)
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: 999 });
    expect(res.status).toBe(404);
  });

  it('local profile edits only advance the default profile pointer', async () => {
    const beforeUser = await appA.database.query.account.findFirst({
      where: eq(account.id, aliceLocalIdA),
      columns: { defaultProfileRev: true },
    });
    const beforeAccount = await appA.database.query.account.findFirst({
      where: eq(account.id, aliceLocalIdA),
      columns: { clientStateFeedEndId: true },
    });
    expect(beforeUser).toBeDefined();
    expect(beforeAccount).toBeDefined();

    const res = await request(appA.baseUrl)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Alice Renamed', bio: 'Updated profile' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    const afterUser = await appA.database.query.account.findFirst({
      where: eq(account.id, aliceLocalIdA),
      columns: { defaultProfileRev: true },
    });
    const afterAccount = await appA.database.query.account.findFirst({
      where: eq(account.id, aliceLocalIdA),
      columns: { clientStateFeedEndId: true },
    });
    expect(afterUser!.defaultProfileRev).toBe(
      beforeUser!.defaultProfileRev + 1,
    );
    expect(afterAccount!.clientStateFeedEndId).toBe(
      beforeAccount!.clientStateFeedEndId,
    );
    expect(
      await appA.database.query.profileTable.findFirst({
        where: and(
          and(
            eq(profileTable.account, 'alice'),
            eq(profileTable.domain, 'local'),
            eq(profileTable.profileNamespaceId, 0),
          ),
          eq(profileTable.profileRev, afterUser!.defaultProfileRev),
        ),
      }),
    ).toMatchObject({
      displayName: 'Alice Renamed',
      bio: 'Updated profile',
    });
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
      .send({
        groupId: groupThreadA,
        users: [{ account: 'bob', domain: DOM_B }],
      });
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
              eq(
                relationshipIntent.authorAccount,
                relationship.groupEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relationship.groupEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relationship.memberEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relationship.memberEndpoint.namespaceId,
              ),
              eq(relationshipIntent.status, 'REQUESTED'),
            ),
          });
        expect(pendingInvite).toBeDefined();
      },
      { timeout: 5000 },
    );

    const publishedGroupInvite =
      await appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.account, groupAccount),
          eq(peerStateFeed.subjectAccount, 'bob'),
          eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });
    expect(publishedGroupInvite?.body).toMatchObject({
      status: 'REQUESTED',
      profileRev: expect.any(Number),
    });
    const invitedGroupProfile = await request(appB.baseUrl)
      .get('/api/v1/test/signed-s2s-get')
      .query({
        peerDomain: DOM_A,
        path: `/s2s/v1/profiles/${encodeFederationResourceComponent(groupAccount)}?rev=${String((publishedGroupInvite!.body as { profileRev: number }).profileRev)}`,
      });
    expect(invitedGroupProfile.body.status).toBe(200);
    expect(invitedGroupProfile.body.body).toMatchObject({
      code: BusinessCode.OK,
      data: {
        account: groupAccount,
        domain: DOM_A,
        displayName: 'fed-group',
        bio: '',
        profileRev: (publishedGroupInvite!.body as { profileRev: number })
          .profileRev,
      },
    });

    // Local acceptance updates the relationship state. The remote host later publishes the
    // authoritative member roster through GROUP_META; mirrors do not derive AccountThreadState.
    const accept = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: mirrorB.id });
    expect(accept.status).toBe(200);
    expect(accept.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appB.database, accept.body);
    const outboundJoin = await appB.database.query.peerStateFeed.findFirst({
      where: and(
        eq(peerStateFeed.peerDomain, DOM_A),
        eq(peerStateFeed.account, 'bob'),
        eq(peerStateFeed.subjectAccount, groupAccount),
        eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
      ),
    });
    expect(outboundJoin?.body).toMatchObject({
      status: 'ACCEPTED',
      messageEndSeq: expect.any(Number),
      tombstoneEndSeq: expect.any(Number),
    });
    await vi.waitFor(
      async () => {
        const epoch = await appA.database.query.identityNamespace.findFirst({
          where: eq(identityNamespace.domain, DOM_B),
        });
        expect(epoch?.stateFeedPulledThrough ?? 0n).toBeGreaterThanOrEqual(
          outboundJoin!.feedId,
        );
      },
      { timeout: 5000, interval: 100 },
    );
    const originMembership = await findGroupRelationship(
      appA.database,
      trdA!.groupId,
      bobAddressOnA,
    );
    const originMembershipRows =
      await appA.database.query.relationshipIntent.findMany({
        where: or(
          and(
            eq(
              relationshipIntent.authorAccount,
              originMembership.groupEndpoint.account,
            ),
            eq(
              relationshipIntent.authorNamespaceId,
              originMembership.groupEndpoint.namespaceId,
            ),
            eq(
              relationshipIntent.receiverAccount,
              originMembership.memberEndpoint.account,
            ),
            eq(
              relationshipIntent.receiverNamespaceId,
              originMembership.memberEndpoint.namespaceId,
            ),
          ),
          and(
            eq(
              relationshipIntent.authorAccount,
              originMembership.memberEndpoint.account,
            ),
            eq(
              relationshipIntent.authorNamespaceId,
              originMembership.memberEndpoint.namespaceId,
            ),
            eq(
              relationshipIntent.receiverAccount,
              originMembership.groupEndpoint.account,
            ),
            eq(
              relationshipIntent.receiverNamespaceId,
              originMembership.groupEndpoint.namespaceId,
            ),
          ),
        ),
      });
    expect(originMembershipRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorAccount: originMembership.groupEndpoint.account,
          authorNamespaceId: originMembership.groupEndpoint.namespaceId,
          status: 'ACCEPTED',
        }),
        expect.objectContaining({
          authorAccount: originMembership.memberEndpoint.account,
          authorNamespaceId: originMembership.memberEndpoint.namespaceId,
          status: 'ACCEPTED',
        }),
      ]),
    );
    expect(originMembership.pair?.active).toBe(true);

    // The origin (appA) records bob on its canonical roster (handleGroupAccept). Poll for it.
    await vi.waitFor(
      async () => {
        const bobOnA = await findCurrentGroupMemberByAddress(
          appA,
          groupThreadA,
          { account: 'bob', domain: DOM_B },
        );
        expect(bobOnA).toBeDefined(); // bob is an active member on the origin roster

        const bobOnMirror = await findCurrentGroupMemberByAddress(
          appB,
          mirrorB.id,
          { account: 'bob', domain: 'local' },
        );
        expect(bobOnMirror).toBeDefined();
      },
      { timeout: 5000 },
    );

    // The authoritative roster/profile is published only after membership becomes active.
    // The mirror consumes the Group Meta coordinate from the combined thread head.
    await vi.waitFor(
      async () => {
        const [originMeta, publishedHead, mirrorProfile] = await Promise.all([
          appA.database.query.groupMeta.findFirst({
            where: eq(groupMeta.threadId, trdA!.groupId),
          }),
          appA.database.query.peerStateFeed.findFirst({
            where: and(
              eq(peerStateFeed.peerDomain, DOM_B),
              eq(peerStateFeed.account, groupAccount),
              eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
            ),
          }),
          appB.database.query.groupMeta.findFirst({
            where: eq(groupMeta.threadId, mirrorB.groupId),
          }),
        ]);
        expect(publishedHead?.body).toMatchObject({
          groupMetaFeedEndId: originMeta!.metaEndId,
        });
        expect(mirrorProfile?.profileRev).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 },
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
            authorAccount: relationshipIntent.authorAccount,
            authorNamespaceId: relationshipIntent.authorNamespaceId,
            status: relationshipIntent.status,
            expiresAt: relationshipIntent.expiresAt,
          })
          .from(relationshipIntent)
          .where(
            or(
              and(
                eq(
                  relationshipIntent.authorAccount,
                  relationship.firstEndpoint.account,
                ),
                eq(
                  relationshipIntent.authorNamespaceId,
                  relationship.firstEndpoint.namespaceId,
                ),
                eq(
                  relationshipIntent.receiverAccount,
                  relationship.secondEndpoint.account,
                ),
                eq(
                  relationshipIntent.receiverNamespaceId,
                  relationship.secondEndpoint.namespaceId,
                ),
              ),
              and(
                eq(
                  relationshipIntent.authorAccount,
                  relationship.secondEndpoint.account,
                ),
                eq(
                  relationshipIntent.authorNamespaceId,
                  relationship.secondEndpoint.namespaceId,
                ),
                eq(
                  relationshipIntent.receiverAccount,
                  relationship.firstEndpoint.account,
                ),
                eq(
                  relationshipIntent.receiverNamespaceId,
                  relationship.firstEndpoint.namespaceId,
                ),
              ),
            ),
          );
        expect(confirmedMemberships).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              authorAccount: relationship.groupEndpoint.account,
              authorNamespaceId: relationship.groupEndpoint.namespaceId,
              status: 'ACCEPTED',
              expiresAt: null,
            }),
            expect.objectContaining({
              authorAccount: relationship.memberEndpoint.account,
              authorNamespaceId: relationship.memberEndpoint.namespaceId,
              status: 'ACCEPTED',
              expiresAt: null,
            }),
          ]),
        );
      },
      { timeout: 5000, interval: 100 },
    );

    const originAcknowledgement =
      await appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.account, groupAccount),
          eq(peerStateFeed.subjectAccount, 'bob'),
          eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });
    expect(originAcknowledgement?.body).toMatchObject({
      status: 'ACCEPTED',
      messageEndSeq: expect.any(Number),
      tombstoneEndSeq: expect.any(Number),
    });

    // The origin commits the join notice with the acceptance. Depending on
    // whether the mirror's initial full snapshot lands before or after this
    // MEMBER_UPSERT, it either establishes a silent baseline or later observes one
    // delta join notice. Neither path may replay the notice twice.
    await vi.waitFor(
      async () => {
        const mirrorMeta = await appB.database.query.groupMeta.findFirst({
          where: eq(groupMeta.threadId, mirrorB.id),
        });
        expect(mirrorMeta?.metaRecoveryThroughId).toBeNull();
        expect(mirrorMeta?.metaProcessedThroughId).toBeGreaterThan(0);
        const joined = await appA.database
          .select({ id: message.id })
          .from(message)
          .where(
            and(
              eq(message.threadId, groupThreadA),
              eq(message.contentType, ContentType.SYSTEM),
              sql`${message.content}::text like '%GROUP_JOINED%'`,
              sql`${message.content}::text like '%bob%'`,
            ),
          );
        expect(joined).toHaveLength(1);
      },
      { timeout: 5000, interval: 100 },
    );
    const mirrorHistoricalJoins = await appB.database
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.threadId, mirrorB.id),
          eq(message.contentType, ContentType.SYSTEM),
          sql`${message.content}::text like '%GROUP_JOINED%'`,
          sql`${message.content}::text like '%bob%'`,
        ),
      );
    expect(mirrorHistoricalJoins.length).toBeLessThanOrEqual(1);

    // alice sends through the origin hub; the mirror commits one client thread head and wakes bob.
    const beforeGroupFeed = await appB.database.query.account.findFirst({
      where: eq(account.id, bobLocalIdB),
      columns: { threadFeedEndId: true },
    });
    expect(beforeGroupFeed).toBeDefined();
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
      // The message lands on bob's mirror with a receiver-local sequence.
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
      await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'THREAD_FEED_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { threadFeedEndId?: unknown }).threadFeedEndId ===
            'number' &&
          (data as { threadFeedEndId: number }).threadFeedEndId >
            beforeGroupFeed!.threadFeedEndId,
        10_000,
      );
      await vi.waitFor(
        async () => {
          const head = await appB.database.query.accountThreadState.findFirst({
            where: and(
              eq(accountThreadState.accountId, bobLocalIdB),
              eq(accountThreadState.threadId, mirrorB.id),
            ),
          });
          expect(head?.messageEndSeq).toBeGreaterThanOrEqual(helloGroupSeq);
        },
        { timeout: 10_000, interval: 100 },
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
    const { id: erinLocalIdB, token: tokenErin } = await registerAndLogin(
      appB,
      'erin-join-projection',
      'Erin',
    );
    const diagnosticReset = await request(appA.baseUrl).post(
      '/api/v1/test/feed-drain-diagnostics/reset',
    );
    expect(diagnosticReset.status).toBe(201);
    const apply = await request(appB.baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${tokenErin}`)
      .send({
        account: firstGroupAccount,
        domain: DOM_A,
        displayName: 'fed-group',
        note: 'federated application',
      });
    expect(apply.body.code, JSON.stringify(apply.body)).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appB.database, apply.body);

    const projected = await vi.waitFor(
      async () => {
        const row = await appA.database.query.groupRequestProjection.findFirst({
          where: and(
            eq(groupRequestProjection.threadId, firstGroupThreadA),
            eq(groupRequestProjection.memberAccount, 'erin-join-projection'),
            eq(groupRequestProjection.memberDomain, DOM_B),
            eq(
              groupRequestProjection.memberNamespaceId,
              await requireActiveNamespaceId(appA, DOM_B),
            ),
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
        account: projected.memberAccount,
        domain: projected.memberDomain,
      });
    expect(rejected.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appA.database, rejected.body);
    await vi.waitFor(
      async () => {
        expect(
          await appA.database.query.groupRequestProjection.findFirst({
            where: and(
              eq(groupRequestProjection.threadId, firstGroupThreadA),
              eq(groupRequestProjection.memberAccount, 'erin-join-projection'),
              eq(groupRequestProjection.memberDomain, DOM_B),
              eq(groupRequestProjection.direction, 'APPLICATION'),
            ),
          }),
        ).toMatchObject({ status: 'REJECTED' });
      },
      { timeout: 5000, interval: 100 },
    );

    // Renew only after the rejection and the member-owned revoke converge.
    // The renewed request is a new revision from the revoked direction.
    await vi.waitFor(
      async () => {
        const mirror = await findGroupThreadByAccount(appB, firstGroupAccount);
        expect(mirror).toBeDefined();
        const relation = await findGroupRelationship(
          appB.database,
          mirror!.id,
          erinLocalIdB,
        );
        const intents = await appB.database.query.relationshipIntent.findMany({
          where: or(
            and(
              eq(
                relationshipIntent.authorAccount,
                relation.groupEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relation.groupEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relation.memberEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relation.memberEndpoint.namespaceId,
              ),
            ),
            and(
              eq(
                relationshipIntent.authorAccount,
                relation.memberEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relation.memberEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relation.groupEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relation.groupEndpoint.namespaceId,
              ),
            ),
          ),
        });
        expect(intents).toHaveLength(2);
        expect(intents.every((intent) => intent.status === 'REVOKED')).toBe(
          true,
        );
        const origin = await findGroupRelationship(
          appA.database,
          firstGroupThreadA,
          {
            account: 'erin-join-projection',
            domain: DOM_B,
            namespaceId: await requireActiveNamespaceId(appA, DOM_B),
          },
        );
        const originIntents =
          await appA.database.query.relationshipIntent.findMany({
            where: or(
              and(
                eq(
                  relationshipIntent.authorAccount,
                  origin.groupEndpoint.account,
                ),
                eq(
                  relationshipIntent.authorNamespaceId,
                  origin.groupEndpoint.namespaceId,
                ),
                eq(
                  relationshipIntent.receiverAccount,
                  origin.memberEndpoint.account,
                ),
                eq(
                  relationshipIntent.receiverNamespaceId,
                  origin.memberEndpoint.namespaceId,
                ),
              ),
              and(
                eq(
                  relationshipIntent.authorAccount,
                  origin.memberEndpoint.account,
                ),
                eq(
                  relationshipIntent.authorNamespaceId,
                  origin.memberEndpoint.namespaceId,
                ),
                eq(
                  relationshipIntent.receiverAccount,
                  origin.groupEndpoint.account,
                ),
                eq(
                  relationshipIntent.receiverNamespaceId,
                  origin.groupEndpoint.namespaceId,
                ),
              ),
            ),
          });
        expect(
          originIntents.every((intent) => intent.status === 'REVOKED'),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    const renewed = await request(appB.baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${tokenErin}`)
      .send({
        account: firstGroupAccount,
        domain: DOM_A,
        displayName: 'fed-group',
        note: 'renewed application',
      });
    expect(renewed.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appB.database, renewed.body);
    const renewedProjection = await vi.waitFor(
      async () => {
        const row = await appA.database.query.groupRequestProjection.findFirst({
          where: and(
            eq(groupRequestProjection.threadId, firstGroupThreadA),
            eq(groupRequestProjection.memberAccount, 'erin-join-projection'),
            eq(groupRequestProjection.memberDomain, DOM_B),
            eq(
              groupRequestProjection.memberNamespaceId,
              await requireActiveNamespaceId(appA, DOM_B),
            ),
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
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${tokenErin}`)
      .send({ account: firstGroupAccount, domain: DOM_A });
    expect(revoked.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appB.database, revoked.body);
    await vi.waitFor(
      async () => {
        const row = await appA.database.query.groupRequestProjection.findFirst({
          where: and(
            eq(groupRequestProjection.threadId, firstGroupThreadA),
            eq(groupRequestProjection.memberAccount, 'erin-join-projection'),
            eq(groupRequestProjection.memberDomain, DOM_B),
            eq(groupRequestProjection.direction, 'APPLICATION'),
          ),
        });
        expect(row).toMatchObject({ status: 'WITHDRAWN' });
        // feedId numbers the application; concluding that application flips
        // its status without allocating another request number.
        expect(row!.feedId).toBe(renewedProjection.feedId);
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
    await establishFederatedFriendship({
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
    daveAddressOnA = {
      account: 'dave',
      domain: DOM_B,
      namespaceId: await requireActiveNamespaceId(appA, DOM_B),
    };
    // The group-invite friend gate keys on an active P2P thread alice↔dave on appB — wait for it.
    await vi.waitFor(
      async () => {
        expect(
          await findActiveP2pParticipant(appB, daveLocalIdB),
        ).not.toBeNull();
        expect(
          await findActiveP2pParticipant(appA, daveAddressOnA),
        ).not.toBeNull();
        expect(
          await findActiveP2pBetween(appA, aliceLocalIdA, daveAddressOnA),
        ).toBeDefined();
      },
      { timeout: 5000, interval: 100 },
    );

    // Force the next GROUP_META_HEAD to perform a full rebuild and seed one receiver-only current
    // member. The authoritative full snapshot must mark that absent member as departed while retaining
    // its source-scoped identity for already materialized data.
    const namespaceAOnB = await requireActiveNamespaceId(appB, DOM_A);
    await appB.database.insert(profileTable).values({
      account: 'stale-roster-member',
      domain: 'stale.test',
      publisherNamespaceId: namespaceAOnB,
      profileNamespaceId: namespaceAOnB,
      profileRev: 1,
      displayName: 'Stale roster member',
    });
    await appB.database.insert(groupMetaMemberFeed).values({
      threadId: firstMirrorGroupBId,
      feedId: 2_000_000_000,
      memberAccount: 'stale-roster-member',
      memberDomain: 'stale.test',
      operation: 'MEMBER_UPSERT',
      body: { role: GroupRole.MEMBER, profileRev: 1 },
    });
    await appB.database
      .delete(groupMeta)
      .where(eq(groupMeta.threadId, firstMirrorGroupBId));

    // Invite dave to the SAME group bob is in; appB adds dave to the EXISTING mirror thread.
    const groupInviteDave = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        groupId: firstGroupThreadA,
        users: [{ account: 'dave', domain: DOM_B }],
      });
    expect(groupInviteDave.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTasks(appA.database, groupInviteDave.body);
    expect(
      groupInviteDave.body.data.invited,
      JSON.stringify(groupInviteDave.body),
    ).toContainEqual({ account: 'dave', domain: DOM_B });
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          firstMirrorGroupBId,
          daveLocalIdB,
        );
        const pending = await appB.database.query.relationshipIntent.findFirst({
          where: and(
            eq(
              relationshipIntent.authorAccount,
              relationship.groupEndpoint.account,
            ),
            eq(
              relationshipIntent.authorNamespaceId,
              relationship.groupEndpoint.namespaceId,
            ),
            eq(
              relationshipIntent.receiverAccount,
              relationship.memberEndpoint.account,
            ),
            eq(
              relationshipIntent.receiverNamespaceId,
              relationship.memberEndpoint.namespaceId,
            ),
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
    await waitForAcceptedDurableTask(appB.database, daveAccept.body);

    // dave is now on the SAME mirror thread as bob (the shared-mirror property).
    await vi.waitFor(
      async () => {
        expect(
          await findCurrentGroupMemberByAddress(appB, firstMirrorBId, {
            account: 'dave',
            domain: 'local',
          }),
        ).toMatchObject({ domain: 'local', namespaceId: 0 });
      },
      { timeout: 5000 },
    );

    // Joining a federated mirror is two-phase: B authors USER→GROUP, then A activates it and returns
    // an authoritative GROUP_META. Do not treat B's first observed participant row as convergence;
    // require the origin roster and then the mirror roster to agree before exercising message fan-out.
    await vi.waitFor(
      async () => {
        expect(
          await findCurrentGroupMemberByAddress(appA, firstGroupThreadA, {
            account: 'dave',
            domain: DOM_B,
          }),
        ).toBeDefined();
      },
      { timeout: 5000 },
    );
    await vi.waitFor(
      async () => {
        const daveOnMirror = await findCurrentGroupMemberByAddress(
          appB,
          firstMirrorBId,
          { account: 'dave', domain: 'local' },
        );
        expect(daveOnMirror).toMatchObject({ domain: 'local', namespaceId: 0 });
        const staleMember = await findCurrentGroupMemberByAddress(
          appB,
          firstMirrorBId,
          { account: 'stale-roster-member', domain: 'stale.test' },
        );
        expect(
          staleMember,
          'full group-meta rebuild must remove a receiver-only member fact',
        ).toBeUndefined();
        expect(
          await appB.database.query.profileTable.findFirst({
            where: and(
              eq(profileTable.account, 'stale-roster-member'),
              eq(profileTable.domain, 'stale.test'),
              eq(profileTable.profileNamespaceId, namespaceAOnB),
              eq(profileTable.profileRev, 1),
            ),
          }),
          'full group-meta rebuild must retain historical exact profiles',
        ).toBeDefined();
        // This deliberate full rebuild establishes Dave in the roster
        // baseline, so it does not replay his earlier join notice.
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, firstMirrorBId),
              eq(message.contentType, ContentType.SYSTEM),
              sql`${message.content}::text like '%GROUP_JOINED%'`,
              sql`${message.content}::text like '%dave%'`,
            ),
          }),
        ).toBeUndefined();
      },
      { timeout: 5000 },
    );

    const [originGroup] = await appA.database
      .select({ groupId: messageThread.id })
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
          daveAddressOnA,
        );
        const [pair, intents] = await Promise.all([
          relationship.pair,
          appA.database.query.relationshipIntent.findMany({
            where: or(
              and(
                eq(
                  relationshipIntent.authorAccount,
                  relationship.groupEndpoint.account,
                ),
                eq(
                  relationshipIntent.authorNamespaceId,
                  relationship.groupEndpoint.namespaceId,
                ),
                eq(
                  relationshipIntent.receiverAccount,
                  relationship.memberEndpoint.account,
                ),
                eq(
                  relationshipIntent.receiverNamespaceId,
                  relationship.memberEndpoint.namespaceId,
                ),
              ),
              and(
                eq(
                  relationshipIntent.authorAccount,
                  relationship.memberEndpoint.account,
                ),
                eq(
                  relationshipIntent.authorNamespaceId,
                  relationship.memberEndpoint.namespaceId,
                ),
                eq(
                  relationshipIntent.receiverAccount,
                  relationship.groupEndpoint.account,
                ),
                eq(
                  relationshipIntent.receiverNamespaceId,
                  relationship.groupEndpoint.namespaceId,
                ),
              ),
            ),
          }),
        ]);
        expect(
          { pair, intents },
          'origin must finish both directed relationship facts before shared-mirror delivery',
        ).toMatchObject({ pair: { active: true } });
      },
      { timeout: 15_000, interval: 100 },
    );

    const [bobFeedBeforeShared, daveFeedBeforeShared] = await Promise.all([
      appB.database.query.account.findFirst({
        where: eq(account.id, bobLocalIdB),
        columns: { threadFeedEndId: true },
      }),
      appB.database.query.account.findFirst({
        where: eq(account.id, daveLocalIdB),
        columns: { threadFeedEndId: true },
      }),
    ]);
    expect(bobFeedBeforeShared).toBeDefined();
    expect(daveFeedBeforeShared).toBeDefined();
    // Both local members of the mirror receive independent throttled feed wakes.
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
          const head = await appA.database.query.peerStateFeed.findFirst({
            where: and(
              eq(peerStateFeed.peerDomain, DOM_B),
              eq(peerStateFeed.account, firstGroupAccount),
              eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
            ),
          });
          expect(head?.body).toMatchObject({
            messageEndSeq: sharedSend.body.data.seq,
          });
        },
        { timeout: 5000, interval: 100 },
      );
      // 'hi both' is pulled into the shared mirror and advances both client feed projections.
      const hiBoth = await vi.waitFor(
        async () => {
          const [
            msg,
            sourceStateCursor,
            receiverStateCursor,
            receiverThreadState,
          ] = await Promise.all([
            appB.database.query.message.findFirst({
              where: and(
                eq(message.threadId, firstMirrorBId),
                eq(message.content, textContent('hi both')),
              ),
            }),
            appA.database.query.identityNamespace.findFirst({
              where: eq(identityNamespace.domain, DOM_B),
            }),
            appB.database.query.identityNamespace.findFirst({
              where: eq(identityNamespace.domain, DOM_A),
            }),
            appB.database.query.federationThreadSyncState.findFirst({
              where: eq(federationThreadSyncState.threadId, firstMirrorBId),
            }),
          ]);
          if (!msg) {
            throw new Error(
              `shared-mirror receiver cursor snapshot: ${JSON.stringify(
                {
                  sourceStateAllocatedThrough:
                    sourceStateCursor?.stateFeedEndId?.toString(),
                  receiverStateCommittedThrough:
                    receiverStateCursor?.stateFeedPulledThrough?.toString(),
                  receiverMessageTarget: receiverThreadState?.messageTargetSeq,
                  receiverMessageProcessedThrough:
                    receiverThreadState?.messageProcessedThroughSeq,
                },
                (_key, value) =>
                  typeof value === 'bigint' ? value.toString() : value,
              )}`,
            );
          }
          return msg!;
        },
        { timeout: 30_000, interval: 100 },
      );
      const [bobRelationship, daveRelationship] = await Promise.all([
        findGroupRelationship(appB.database, firstMirrorGroupBId, bobLocalIdB),
        findGroupRelationship(appB.database, firstMirrorGroupBId, daveLocalIdB),
      ]);
      expect(bobRelationship.pair?.active).toBe(true);
      expect(daveRelationship.pair?.active).toBe(true);
      const isFeedWakeAfter =
        (after: number) => (event: string, data: unknown) =>
          event === 'THREAD_FEED_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { threadFeedEndId?: unknown }).threadFeedEndId ===
            'number' &&
          (data as { threadFeedEndId: number }).threadFeedEndId > after;
      await Promise.all([
        bobEvents
          .waitFor(
            isFeedWakeAfter(bobFeedBeforeShared!.threadFeedEndId),
            30_000,
          )
          .catch((error) => {
            throw new Error(
              `bob did not receive shared-mirror feed wake: ${(error as Error).message}`,
            );
          }),
        daveEvents
          .waitFor(
            isFeedWakeAfter(daveFeedBeforeShared!.threadFeedEndId),
            30_000,
          )
          .catch((error) => {
            throw new Error(
              `dave did not receive shared-mirror feed wake: ${(error as Error).message}`,
            );
          }),
      ]);
      for (const userId of [bobLocalIdB, daveLocalIdB]) {
        await vi.waitFor(
          async () => {
            const head = await appB.database.query.accountThreadState.findFirst(
              {
                where: and(
                  eq(accountThreadState.accountId, userId),
                  eq(accountThreadState.threadId, firstMirrorBId),
                ),
              },
            );
            expect(head?.messageEndSeq).toBeGreaterThanOrEqual(hiBoth.seq);
          },
          { timeout: 10_000, interval: 100 },
        );
      }
    } finally {
      await readerBob.cancel();
      await readerDave.cancel();
    }
  }, 60_000);

  it('a mirror leave closes USER→GROUP and still delivers the boundary SYSTEM message', async () => {
    const leave = await request(appB.baseUrl)
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${tokenDave}`)
      .send({ groupId: firstMirrorBId });
    expect(leave.status).toBe(200);
    expect(leave.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appB.database, leave.body);

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
              eq(
                relationshipIntent.authorAccount,
                relationship.memberEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relationship.memberEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relationship.groupEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relationship.groupEndpoint.namespaceId,
              ),
            ),
          });
        expect(joinDirection?.status).toBe('REVOKED');

        const pair = relationship.pair;
        expect(pair?.active).toBe(false);

        const originMember = await findCurrentGroupMemberByAddress(
          appA,
          firstGroupThreadA,
          { account: 'dave', domain: DOM_B },
        );
        expect(originMember).toBeUndefined();

        const boundaryMessage = await appA.database.query.message.findFirst({
          where: and(
            eq(message.threadId, firstGroupThreadA),
            eq(message.contentType, ContentType.SYSTEM),
            sql`${message.content}::text like '%GROUP_LEFT%'`,
          ),
          orderBy: desc(message.seq),
        });
        expect(boundaryMessage).toMatchObject({
          creatorAccount: '$system',
          creatorDomain: 'local',
        });
        const mirrorLeft = await appB.database.query.message.findMany({
          where: and(
            eq(message.threadId, firstMirrorBId),
            eq(message.contentType, ContentType.SYSTEM),
            sql`(${message.content}::jsonb ->> 'type') = 'GROUP_LEFT'`,
            sql`(${message.content}::jsonb -> 'member' ->> 'account') = 'dave'`,
          ),
        });
        expect(mirrorLeft).toHaveLength(1);
        expect(mirrorLeft[0]).toMatchObject({
          creatorAccount: '$system',
          creatorDomain: 'local',
        });
        expect(
          await appB.database.query.accountThreadState.findFirst({
            where: and(
              eq(accountThreadState.accountId, daveLocalIdB),
              eq(accountThreadState.threadId, firstMirrorBId),
            ),
          }),
        ).toMatchObject({ messageVisibleThroughSeq: mirrorLeft[0]!.seq });
        expect(
          await findCurrentGroupMemberByAddress(appB, firstMirrorBId, {
            account: 'dave',
            domain: 'local',
          }),
          'group-meta MEMBER_DEPART must remove the member from the current roster',
        ).toBeUndefined();
      },
      { timeout: 5000, interval: 100 },
    );
  });

  it('a member who rejoins a still-subscribed shared mirror can see messages from the gap', async () => {
    expect(
      await appA.database.query.threadAudience.findFirst({
        where: and(
          eq(threadAudience.targetDomain, DOM_B),
          eq(threadAudience.threadId, firstGroupThreadA),
        ),
      }),
      'another member from the peer still keeps its shared audience open',
    ).toBeDefined();
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
        const head = await appA.database.query.peerStateFeed.findFirst({
          where: and(
            eq(peerStateFeed.peerDomain, DOM_B),
            eq(peerStateFeed.account, firstGroupAccount),
            eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          ),
        });
        expect(head?.body).toMatchObject({
          messageEndSeq: duringDaveGap.body.data.seq,
        });
      },
      { timeout: 5000, interval: 100 },
    );
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
      { timeout: 40_000, interval: 150 },
    );

    const reinvite = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        groupId: firstGroupThreadA,
        users: [{ account: 'dave', domain: DOM_B }],
      });
    expect(reinvite.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTasks(appA.database, reinvite.body);
    expect(
      reinvite.body.data.invited,
      JSON.stringify(reinvite.body),
    ).toContainEqual({ account: 'dave', domain: DOM_B });
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
              eq(
                relationshipIntent.authorAccount,
                relationship.groupEndpoint.account,
              ),
              eq(
                relationshipIntent.authorNamespaceId,
                relationship.groupEndpoint.namespaceId,
              ),
              eq(
                relationshipIntent.receiverAccount,
                relationship.memberEndpoint.account,
              ),
              eq(
                relationshipIntent.receiverNamespaceId,
                relationship.memberEndpoint.namespaceId,
              ),
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
    await waitForAcceptedDurableTask(appB.database, rejoin.body);
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
    await appA.database
      .insert(systemSetting)
      .values({
        key: FEDERATION_HISTORY_ACCESS_SETTING_KEY,
        value: 'false',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value: 'false', updatedAt: new Date() },
      });
    // Leave dave first so bob's later leave is the last member from appB.
    const daveLeaveAgain = await request(appB.baseUrl)
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${tokenDave}`)
      .send({ groupId: firstMirrorBId });
    expect(daveLeaveAgain.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appB.database, daveLeaveAgain.body);
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
        { timeout: 40_000, interval: 150 },
      );

      const bobLeave = await request(appB.baseUrl)
        .post('/api/v1/group/leave')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: firstMirrorBId });
      expect(bobLeave.body.code).toBe(BusinessCode.OK);
      await waitForAcceptedDurableTask(appB.database, bobLeave.body);
      await vi.waitFor(
        async () => {
          const [bobOnOrigin, originAudience, bobOnMirror] = await Promise.all([
            findCurrentGroupMemberByAddress(appA, firstGroupThreadA, {
              account: 'bob',
              domain: DOM_B,
            }),
            appA.database.query.threadAudience.findFirst({
              where: and(
                eq(threadAudience.targetDomain, DOM_B),
                eq(threadAudience.threadId, firstGroupThreadA),
              ),
            }),
            findCurrentGroupMemberByAddress(appB, firstMirrorBId, {
              account: 'bob',
              domain: 'local',
            }),
          ]);
          expect(bobOnOrigin).toBeUndefined();
          expect(originAudience).toBeUndefined();
          // The departed account is no longer authorized, but its mirror does not need a terminal
          // Group Meta notification. The retained replica may therefore still contain its last
          // MEMBER_UPSERT; current access is determined by the relationship state, not this projection.
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

    const headBeforeGap = await appA.database.query.peerStateFeed.findFirst({
      where: and(
        eq(peerStateFeed.peerDomain, DOM_B),
        eq(peerStateFeed.account, firstGroupAccount),
        eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
      ),
    });
    expect(headBeforeGap).toBeUndefined();
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
    const headAfterGap = await appA.database.query.peerStateFeed.findFirst({
      where: and(
        eq(peerStateFeed.peerDomain, DOM_B),
        eq(peerStateFeed.account, firstGroupAccount),
        eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
      ),
    });
    expect(headAfterGap).toBeUndefined();
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
      .send({
        groupId: firstGroupThreadA,
        users: [{ account: 'bob', domain: DOM_B }],
      });
    expect(reinviteBob.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTasks(appA.database, reinviteBob.body);
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          firstMirrorGroupBId,
          bobLocalIdB,
        );
        const invite = await appB.database.query.relationshipIntent.findFirst({
          where: and(
            eq(
              relationshipIntent.authorAccount,
              relationship.groupEndpoint.account,
            ),
            eq(
              relationshipIntent.authorNamespaceId,
              relationship.groupEndpoint.namespaceId,
            ),
            eq(
              relationshipIntent.receiverAccount,
              relationship.memberEndpoint.account,
            ),
            eq(
              relationshipIntent.receiverNamespaceId,
              relationship.memberEndpoint.namespaceId,
            ),
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
    await waitForAcceptedDurableTask(appB.database, bobRejoin.body);
    await vi.waitFor(
      async () => {
        const [originAudience, mirrorAudience, localState, bobOnMirror] =
          await Promise.all([
            appA.database.query.threadAudience.findFirst({
              where: and(
                eq(threadAudience.targetDomain, DOM_B),
                eq(threadAudience.threadId, firstGroupThreadA),
              ),
            }),
            appB.database.query.threadAudience.findFirst({
              where: eq(threadAudience.threadId, firstMirrorBId),
            }),
            appB.database.query.accountThreadState.findFirst({
              where: and(
                eq(accountThreadState.accountId, bobLocalIdB),
                eq(accountThreadState.threadId, firstMirrorBId),
              ),
            }),
            findCurrentGroupMemberByAddress(appB, firstMirrorBId, {
              account: 'bob',
              domain: 'local',
            }),
          ]);
        expect(originAudience).toBeDefined();
        expect(mirrorAudience).toBeUndefined();
        expect(localState).toBeDefined();
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
    // Sink B→A relays so the origin cannot observe the leave — a transport-level
    // partition with no process lifecycle involved.
    proxy.blockRelays(true);
    try {
      const leave = await request(appB.baseUrl)
        .post('/api/v1/group/leave')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: firstMirrorBId });
      expect(leave.body.code).toBe(BusinessCode.OK);
      await waitForAcceptedDurableTask(appB.database, leave.body);
      expect(
        await appB.database.query.accountThreadState.findFirst({
          where: and(
            eq(accountThreadState.threadId, firstMirrorBId),
            eq(accountThreadState.accountId, bobLocalIdB),
          ),
        }),
      ).toMatchObject({ messageVisibleThroughSeq: expect.any(Number) });
      expect(
        (
          await findGroupRelationship(
            appB.database,
            firstMirrorGroupBId,
            bobLocalIdB,
          )
        ).pair,
      ).toMatchObject({ active: false });

      // A fresh addressed request replaces the unserved leave on the compacted
      // directional key. The local server can author it even though the origin
      // still believes Bob is a member.
      const rejoin = await request(appB.baseUrl)
        .post('/api/v1/relationship/request')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          account: firstGroupAccount,
          domain: DOM_A,
          displayName: 'fed-group',
        });
      expect(rejoin.body.code).toBe(BusinessCode.OK);
      await waitForAcceptedDurableTask(appB.database, rejoin.body);
      const relationship = await findGroupRelationship(
        appB.database,
        firstMirrorGroupBId,
        bobLocalIdB,
      );
      const pending = await appB.database.query.relationshipIntent.findFirst({
        where: and(
          eq(
            relationshipIntent.authorAccount,
            relationship.memberEndpoint.account,
          ),
          eq(
            relationshipIntent.authorNamespaceId,
            relationship.memberEndpoint.namespaceId,
          ),
          eq(
            relationshipIntent.receiverAccount,
            relationship.groupEndpoint.account,
          ),
          eq(
            relationshipIntent.receiverNamespaceId,
            relationship.groupEndpoint.namespaceId,
          ),
        ),
      });
      // The observed group-side ACCEPTED immediately satisfies this request
      // locally; the origin still needs to confirm that relationship state.
      expect(pending?.status).toBe('ACCEPTED');
    } finally {
      proxy.blockRelays(false);
    }
    // The partition degraded B's view of the origin; one resolve drives the
    // Health round that restores availability before origin-facing pushes resume.
    await resolveFederatedCard(appB, tokenB, 'alice', DOM_A).catch(() => {});

    await vi.waitFor(
      async () => {
        const [originMember, mirrorMember] = await Promise.all([
          findCurrentGroupMemberByAddress(appA, firstGroupThreadA, {
            account: 'bob',
            domain: DOM_B,
          }),
          findCurrentGroupMemberByAddress(appB, firstMirrorBId, {
            account: 'bob',
            domain: 'local',
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
            eq(
              relationshipIntent.authorAccount,
              relationship.memberEndpoint.account,
            ),
            eq(
              relationshipIntent.authorNamespaceId,
              relationship.memberEndpoint.namespaceId,
            ),
            eq(
              relationshipIntent.receiverAccount,
              relationship.groupEndpoint.account,
            ),
            eq(
              relationshipIntent.receiverNamespaceId,
              relationship.groupEndpoint.namespaceId,
            ),
          ),
        });
        expect(join?.status).toBe('ACCEPTED');
        expect(relationship.pair?.active).toBe(true);
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
      .send({
        groupId: originThreadId,
        users: [{ account: 'dave', domain: DOM_B }],
      });
    expect(invited.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTasks(appA.database, invited.body);
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

    // The origin has an inactive relationship anchor but no effective
    // group-authored invitation. A stale or dishonest mirror-side invitation
    // lets Bob author a signed ACK; the origin must reject this mismatch and
    // publish its own REVOKED conclusion without activating the pair.
    await appA.database.insert(relationshipPair).values({
      kind: 'GROUP_MEMBER',
      endpointAType: 'GROUP',
      endpointAAccount: groupAccount,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: 'bob',
      endpointBNamespaceId: bobAddressOnA.namespaceId,
      threadId: originThreadId,
      active: false,
    });
    const requestedAt = new Date();
    const [dishonestPair] = await appB.database
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'USER',
        endpointAAccount: 'bob',
        endpointANamespaceId: 0,
        endpointBType: 'GROUP',
        endpointBAccount: mirror.group.account,
        endpointBNamespaceId: mirror.group.namespaceId,
        threadId: mirror.id,
        active: false,
        updatedAt: requestedAt,
      })
      .onConflictDoUpdate({
        target: [
          relationshipPair.endpointAType,
          relationshipPair.endpointAAccount,
          relationshipPair.endpointBType,
          relationshipPair.endpointBAccount,
          relationshipPair.endpointBNamespaceId,
        ],
        set: { threadId: mirror.id, updatedAt: requestedAt },
      })
      .returning({ id: relationshipPair.id });
    await appB.database.insert(relationshipIntent).values({
      authorAccount: mirror.group.account,
      authorNamespaceId: mirror.group.namespaceId,
      receiverAccount: 'bob',
      receiverNamespaceId: 0,
      profileNamespaceId: 0,
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
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
    await waitForAcceptedDurableTask(appB.database, accepted.body);

    const outboundAcceptance =
      await appB.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_A),
          eq(peerStateFeed.account, 'bob'),
          eq(peerStateFeed.subjectAccount, groupAccount),
          eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        ),
      });
    expect(outboundAcceptance?.body).toMatchObject({ status: 'ACCEPTED' });
    await vi.waitFor(
      async () => {
        const epoch = await appA.database.query.identityNamespace.findFirst({
          where: eq(identityNamespace.domain, DOM_B),
        });
        expect(epoch?.stateFeedPulledThrough ?? 0n).toBeGreaterThanOrEqual(
          outboundAcceptance!.feedId,
        );
      },
      { timeout: 10_000, interval: 100 },
    );

    await vi.waitFor(
      async () => {
        const origin = await findGroupRelationship(
          appA.database,
          originThread!.groupId,
          bobAddressOnA,
        );
        expect(origin.pair).toBeDefined();
        const denial = await appA.database.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.authorAccount, origin.groupEndpoint.account),
            eq(
              relationshipIntent.authorNamespaceId,
              origin.groupEndpoint.namespaceId,
            ),
            eq(
              relationshipIntent.receiverAccount,
              origin.memberEndpoint.account,
            ),
            eq(
              relationshipIntent.receiverNamespaceId,
              origin.memberEndpoint.namespaceId,
            ),
          ),
        });
        expect(denial?.status).toBe('REVOKED');
      },
      { timeout: 10_000, interval: 100 },
    );

    await vi.waitFor(
      async () => {
        const [invite, join] = await Promise.all([
          appB.database.query.relationshipIntent.findFirst({
            where: and(
              eq(relationshipIntent.authorAccount, mirror.group.account),
              eq(
                relationshipIntent.authorNamespaceId,
                mirror.group.namespaceId,
              ),
              eq(relationshipIntent.receiverAccount, 'bob'),
              eq(relationshipIntent.receiverNamespaceId, 0),
            ),
          }),
          appB.database.query.relationshipIntent.findFirst({
            where: and(
              eq(relationshipIntent.authorAccount, 'bob'),
              eq(relationshipIntent.authorNamespaceId, 0),
              eq(relationshipIntent.receiverAccount, mirror.group.account),
              eq(
                relationshipIntent.receiverNamespaceId,
                mirror.group.namespaceId,
              ),
            ),
          }),
        ]);
        expect(invite).toMatchObject({
          status: 'REVOKED',
          note: '',
        });
        expect(join?.status).toBe('REVOKED');
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
      bobAddressOnA,
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
      bobAddressOnA,
    );
    const oldThreadB = await findActiveP2pBetween(
      appB,
      bobLocalIdB,
      aliceAddressOnB,
    );
    expect(oldThreadA).toBeDefined();
    expect(oldThreadB).toBeDefined();

    // Sink B→A relays so B cannot consume A's feed: the message projection below
    // stays unconsumed. Unfriend removes that projection; REVOKED carries no feed
    // boundary or message content.
    proxy.blockRelays(true);
    onTestFinished(() => {
      proxy.blockRelays(false);
    });
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

    // Message and deletion ends share one compacted THREAD_CONTENT_HEAD. The last send must publish
    // that stable key before revocation proves the key is removed as a unit.
    await vi.waitFor(async () => {
      const head = await appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.account, 'alice'),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          eq(peerStateFeed.subjectAccount, 'bob'),
        ),
      });
      expect(head?.body).toMatchObject({
        messageEndSeq: lastBeforeDelete.body.data.seq,
        tombstoneEndSeq: expect.any(Number),
      });
    });

    const res = await request(appA.baseUrl)
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    // The unfriend commits synchronously, including the boundary head item
    // this test reads from the outbound feed right after.
    expect(res.body.data).toEqual({ status: 'OK' });
    expect(
      await appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.account, 'alice'),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          eq(peerStateFeed.subjectAccount, 'bob'),
        ),
      }),
    ).toBeUndefined();

    // appA tore it down — the P2P thread is soft-left (no active thread between alice and bob's stub).
    const threadA = await findActiveP2pParticipant(appA, bobAddressOnA);
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
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        account: 'bob',
        domain: DOM_B,
        displayName: 'Bob',
        note: 'revive from alice',
      });
    expect(revive.body.code).toBe(BusinessCode.OK);
    expect(revive.body.data).toMatchObject({ status: 'OK' });
    expect(
      await findActiveP2pBetween(appA, aliceLocalIdA, bobAddressOnA),
    ).toEqual(oldThreadA);

    proxy.blockRelays(false);
    // The partition degraded B's view of the origin; one resolve drives the
    // Health round that restores availability before B pulls the pending
    // projection.
    await resolveFederatedCard(appB, tokenB, 'alice', DOM_A);

    await vi.waitFor(
      async () => {
        expect(
          await findActiveP2pBetween(appB, aliceAddressOnB, bobLocalIdB),
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
          await findActiveP2pBetween(appA, aliceLocalIdA, bobAddressOnA),
        ).toEqual(oldThreadA);
        expect(
          await findActiveP2pBetween(appB, bobLocalIdB, aliceAddressOnB),
        ).toEqual(oldThreadB);
      },
      { timeout: 40_000, interval: 150 },
    );

    const [resumedAudience, peerBeforeContinue] = await Promise.all([
      appA.database.query.threadAudience.findFirst({
        where: and(
          eq(threadAudience.threadId, oldThreadA!.threadId),
          eq(threadAudience.targetDomain, DOM_B),
        ),
      }),
      appA.database.query.identityNamespace.findFirst({
        where: and(
          eq(identityNamespace.domain, DOM_B),
          eq(identityNamespace.active, true),
        ),
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
      const head = await appA.database.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.peerDomain, DOM_B),
          eq(peerStateFeed.account, 'alice'),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          eq(peerStateFeed.subjectAccount, 'bob'),
        ),
      });
      expect(head?.body).toMatchObject({
        messageEndSeq: continued.body.data.seq,
      });
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
      bobAddressOnA,
    );
    const threadB = await findActiveP2pBetween(
      appB,
      bobLocalIdB,
      aliceAddressOnB,
    );
    expect(threadA).toBeDefined();
    expect(threadB).toBeDefined();

    const response = await request(appA.baseUrl)
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(response.body.code).toBe(BusinessCode.OK);
    expect(response.body.data).toEqual({ status: 'OK' });

    await vi.waitFor(
      async () => {
        expect(
          await findActiveP2pBetween(appB, bobLocalIdB, aliceAddressOnB),
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
          creatorAccount: '$system',
          creatorDomain: 'local',
        });
        const participant =
          await appB.database.query.accountThreadState.findFirst({
            where: and(
              eq(accountThreadState.threadId, threadB!.threadId),
              eq(accountThreadState.accountId, bobLocalIdB),
            ),
          });
        expect(participant?.messageVisibleThroughSeq).toBe(boundary!.seq);
        expect(participant?.messageEndSeq).toBeGreaterThanOrEqual(
          boundary!.seq,
        );
      },
      { timeout: 40_000, interval: 150 },
    );
  }, 60_000);

  it('rejects an inbound state wake-up signed by an untrusted domain', async () => {
    // evil.local: a real Ed25519 key, but never init'd → no identity namespace.
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
    // fetch's json() is typed unknown; the S2S error envelope is { code, ... }.
    const json = (await res.json()) as { code: number };
    expect(json.code).toBe(BusinessCode.FEDERATION_RECOGNITION_REQUIRED);
  });

  // ─── trust lifecycle: degrade on failure → re-handshake → halt ───────────────────────────────
  // These run after the friend-flow tests; aaa↔bbb are still mutually trusted (unfriending above is
  // local-only and does not degrade). They drive the state machine through real signed S2S traffic:
  // a one-shot proxy 503 forces a transport failure → markTransportDegraded; the next Health allows
  // recovery; markBlocked → resolve surfaces FEDERATION_PEER_BLOCKED.

  it('keeps a peer available when a newer successful contact supersedes a delayed HTTP 503', async () => {
    expect(
      await resolveFederatedCard(appB, tokenB, 'alice', DOM_A),
    ).toMatchObject({
      event: 'resolved',
    });
    const before = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(before?.trustLevel).toBe('available');
    proxy.blockServiceUnavailable(true);
    proxy.armServiceUnavailable('/s2s/v1/accounts/unreachable');
    try {
      const failing = resolveFederatedCard(appB, tokenB, 'unreachable', DOM_A);
      await vi.waitFor(
        () => expect(proxy.blockedServiceUnavailableCount()).toBe(1),
        { timeout: 15_000, interval: 20 },
      );
      expect(
        await resolveFederatedCard(appB, tokenB, 'alice', DOM_A),
      ).toMatchObject({
        event: 'resolved',
      });
      proxy.blockServiceUnavailable(false);
      expect(await failing).toEqual({
        event: 'failed',
        data: { reason: 'UNREACHABLE' },
      });
      const after = await appB.database.query.identityNamespace.findFirst({
        where: and(
          eq(identityNamespace.domain, DOM_A),
          eq(identityNamespace.active, true),
        ),
      });
      expect(after?.trustLevel).toBe('available');
      expect(after?.lastSuccessAt?.getTime()).toBeGreaterThan(
        before!.lastSuccessAt!.getTime(),
      );
      // No new degradation episode: the namespace keeps the exact failure
      // counters and timestamps it had before the delayed 503 landed.
      expect(after?.degradationCount).toBe(before?.degradationCount);
      expect(after?.degradedAt).toEqual(before?.degradedAt);
      expect(after?.degradationReason).toBe(before?.degradationReason);
    } finally {
      proxy.blockServiceUnavailable(false);
    }
  });

  it('degrades a healthy peer on transport failure while retaining certificates', async () => {
    // The proxy is on B → A, so exercise B's local lifecycle for A without stopping either process.
    expect(
      await resolveFederatedCard(appB, tokenB, 'alice', DOM_A),
    ).toMatchObject({ event: 'resolved' });
    const peerBefore = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(peerBefore?.trustLevel).toBe('available');
    const keysBefore = await appB.database.query.s2SKeyCache.findMany({
      where: eq(s2SKeyCache.domain, DOM_A),
    });
    expect(keysBefore.length).toBeGreaterThan(0);

    // Health succeeds first. Only the following profile request gets a one-shot 503, so resolution
    // fails immediately instead of waiting for its Health-recovery deadline.
    proxy.armServiceUnavailable('/s2s/v1/accounts/unreachable');
    const res = await resolveFederatedCard(appB, tokenB, 'unreachable', DOM_A);
    expect(res).toEqual({ event: 'failed', data: { reason: 'UNREACHABLE' } });

    const peerAfter = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(peerAfter?.trustLevel).toBe('degraded');
    expect(peerAfter?.remoteServiceReachable).toBe(false);
    expect(peerAfter?.degradationCount).toBeGreaterThanOrEqual(1);
    expect(peerAfter?.degradedAt).not.toBeNull();
    expect(peerAfter?.degradationReason).toMatch(/HTTP 503/);

    const keysAfter = await appB.database.query.s2SKeyCache.findMany({
      where: eq(s2SKeyCache.domain, DOM_A),
    });
    expect(keysAfter).toHaveLength(keysBefore.length);
  });

  it('recovers a degraded peer through Health without replacing recognition facts', async () => {
    expect(
      await resolveFederatedCard(appB, tokenB, 'alice', DOM_A),
    ).toMatchObject({ event: 'resolved' });
    const beforeRecovery =
      await appB.database.query.identityNamespace.findFirst({
        where: and(
          eq(identityNamespace.domain, DOM_A),
          eq(identityNamespace.active, true),
        ),
      });
    expect(beforeRecovery?.identityPinnedAt).toBeInstanceOf(Date);
    // The reconnect sweep may already have healed the outage from the preceding test. Put only this
    // local trust edge back into the exact precondition so identity recovery is deterministic.
    await appB.database
      .update(identityNamespace)
      .set({
        trustLevel: 'degraded',
        remoteServiceReachable: false,
        degradedAt: new Date(),
        degradationReason: 'deterministic identity recovery fixture',
      })
      .where(
        and(
          eq(identityNamespace.domain, DOM_A),
          eq(identityNamespace.active, true),
        ),
      );
    const res = await resolveFederatedCard(appB, tokenB, 'alice', DOM_A);
    expect(res.event).toBe('resolved');

    const peer = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(peer?.trustLevel).toBe('available');
    expect(peer?.remoteServiceReachable).toBe(true);
    expect(peer?.degradedAt).toBeNull();
    expect(peer?.degradationReason).toBeNull();
    expect(peer?.identityPinnedAt?.getTime()).toBe(
      beforeRecovery?.identityPinnedAt?.getTime(),
    );
  });

  it('lets a super-admin recover identity loss only after the exact original pin returns', async () => {
    const before = await appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_B),
        eq(identityNamespace.active, true),
      ),
    });
    const beforeOnB = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(before?.trustLevel).toBe('available');
    expect(before?.identityPinnedAt).toBeInstanceOf(Date);
    expect(before?.rootPublicKey).toBeTruthy();
    expect(before?.rootKeyFingerprint).toBeTruthy();

    // This represents the state left by a poisoned DNS answer. The proxy now points at the original
    // appB again, so the explicit admin probe must discard its discovery cache and prove every old pin.
    await appA.database
      .update(identityNamespace)
      .set({
        trustLevel: 'halted',
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: 'e2e simulated transient DNS identity contradiction',
      })
      .where(
        and(
          eq(identityNamespace.domain, DOM_B),
          eq(identityNamespace.active, true),
        ),
      );
    // Both sides may have observed poisoned DNS. A lost peer can still obtain the signed proof with
    // its original key, but serving that proof must not silently restore the responder's trust edge.
    await appB.database
      .update(identityNamespace)
      .set({
        trustLevel: 'halted',
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: 'e2e simulated reciprocal identity contradiction',
      })
      .where(
        and(
          eq(identityNamespace.domain, DOM_A),
          eq(identityNamespace.active, true),
        ),
      );

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

    const after = await appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_B),
        eq(identityNamespace.active, true),
      ),
    });
    expect(after?.trustLevel).toBe('degraded');
    expect(after?.haltedAt).toBeNull();
    expect(after?.haltCode).toBeNull();
    expect(after?.haltReason).toBeNull();
    expect(after?.trustedAt?.getTime()).toBe(before?.trustedAt?.getTime());
    expect(after?.rootPublicKey).toBe(before?.rootPublicKey);
    expect(after?.rootKeyFingerprint).toBe(before?.rootKeyFingerprint);

    const stillLostOnB = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(stillLostOnB?.trustLevel).toBe('halted');

    const recoveredOnB = await request(appB.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_A}/recover-identity`)
      .set('Cookie', adminCookieB)
      .send({ confirmDomain: DOM_A });
    expect(recoveredOnB.status).toBe(200);
    const afterOnB = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(afterOnB?.trustLevel).toBe('degraded');
    expect(afterOnB?.trustedAt?.getTime()).toBe(
      beforeOnB?.trustedAt?.getTime(),
    );
  });

  it('blocks a peer: resolve fails fast with FEDERATION_PEER_BLOCKED + admin reads work', async () => {
    // Admin blocks bbb on appA via the real admin route (→ markBlocked). Then resolve must NOT attempt a
    // handshake — it surfaces FEDERATION_PEER_BLOCKED (distinct from an unreachable peer).
    await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/block`)
      .set('Cookie', adminCookieA)
      .send({ note: 'abuse' });
    const blocked = await appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, DOM_B),
        eq(identityNamespace.active, true),
      ),
    });
    expect(blocked).toMatchObject({
      trustLevel: 'halted',
      haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
    });

    const res = await resolveFederatedCard(appA, tokenA, 'bob', DOM_B);
    expect(res).toEqual({ event: 'failed', data: { reason: 'BLOCKED' } });

    // Admin reads (the admin page's data sources, via their real routes): the list filters by
    // state; the detail endpoint exposes the halt; the namespace list still shows the active
    // identity epoch for the blocked peer.
    const listRes = await request(appA.baseUrl)
      .post('/api/v1/admin/federation/peers')
      .set('Cookie', adminCookieA)
      .send({ skip: 0, take: 10, status: 'halted' });
    expect(
      (listRes.body.data.list as { domain: string }[]).some(
        (p) => p.domain === DOM_B,
      ),
    ).toBe(true);

    const detailRes = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}`)
      .set('Cookie', adminCookieA)
      .send({});
    expect(detailRes.body.data).toMatchObject({
      domain: DOM_B,
      trustLevel: 'halted',
      haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
    });

    const nsRes = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/namespaces`)
      .set('Cookie', adminCookieA)
      .send({});
    const namespaces = nsRes.body.data as { active: boolean }[];
    expect(namespaces.filter((ns) => ns.active)).toHaveLength(1);
  });
});
