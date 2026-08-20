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
  waitForSseEvent,
} from './federation-test-helpers.js';
import { BusinessCode } from '../src/common/business-code.js';
import { SignatureService } from '../src/federation/signature.service.js';
import {
  ContentType,
  GroupRole,
  MessageThreadType,
} from '../src/database/enums.js';
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  federatedPeer,
  federatedFriendRequest,
  federatedPeerEvent,
  federatedPeerReset,
  federationMessageFeedIndex,
  federationTombstoneFeedIndex,
  federationTombstoneServeCursor,
  federationServeCursor,
  forwardBundle,
  forwardBundleDependency,
  forwardMessage,
  friendPair,
  friendRequest,
  groupMembershipPair,
  groupMembershipRequest,
  mediaAsset,
  messageAsset,
  message,
  messageThread,
  s2SKeyCache,
  threadParticipant,
  threadAudience,
  user,
} from '../src/database/schema.js';
import { randomUUID } from 'node:crypto';
import {
  SERVER_GROUP_FULL_REASON,
  SERVER_MAX_GROUP_MEMBERS,
} from '../src/group/group-capacity.js';

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
  let firstMirrorGroupUserBId: number; // mirror-local group identity; scopes directed membership rows
  let firstGroupAccount: string; // its `!account` (groupUser.account) — the on-wire group address
  let tokenDave: string; // dave @ appB — a SECOND local member of the same mirror (shared-mirror fan-out test)
  let daveLocalIdB: number;
  let daveStubIdOnA: number;
  let adminCookieB: string;

  async function findActiveP2pParticipant(app: FedApp, userId: number) {
    return app.database.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.userId, userId),
        isNull(threadParticipant.leftAt),
        sql`exists (select 1 from "MessageThread" mt where mt.id = "threadParticipant"."threadId" and mt.type = 'P2P')`,
      ),
      columns: { threadId: true },
    });
  }

  async function findActiveP2pBetween(
    app: FedApp,
    firstUserId: number,
    secondUserId: number,
  ) {
    const result = await app.database.execute<{ threadId: number }>(sql`
      SELECT first_participant."threadId"
      FROM "ThreadParticipant" first_participant
      JOIN "ThreadParticipant" second_participant
        ON second_participant."threadId" = first_participant."threadId"
      JOIN "MessageThread" thread
        ON thread.id = first_participant."threadId" AND thread.type = 'P2P'
      WHERE first_participant."userId" = ${firstUserId}
        AND second_participant."userId" = ${secondUserId}
        AND first_participant."leftAt" IS NULL
        AND second_participant."leftAt" IS NULL
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

  const textContent = (value: string) => JSON.stringify({ text: value });

  async function findGroupThreadByAccount(app: FedApp, account: string) {
    const [row] = await app.database
      .select({
        id: messageThread.id,
        groupUserId: messageThread.groupUserId,
        pullUntil: messageThread.pullUntil,
        account: user.account,
        domain: user.domain,
      })
      .from(messageThread)
      .innerJoin(user, eq(user.id, messageThread.groupUserId))
      .where(eq(user.account, account))
      .limit(1);
    return row
      ? { ...row, groupUser: { account: row.account, domain: row.domain } }
      : undefined;
  }

  async function findGroupThreadById(app: FedApp, threadId: number) {
    const [row] = await app.database
      .select({ account: user.account, domain: user.domain })
      .from(messageThread)
      .innerJoin(user, eq(user.id, messageThread.groupUserId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    return row ? { groupUser: row } : undefined;
  }

  async function findLatestForwardMessage(app: FedApp, creator: number) {
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
          eq(message.creator, creator),
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
    await appA.database.transaction(async (tx) => {
      const [t] = await tx
        .insert(messageThread)
        .values({ type: MessageThreadType.P2P, updatedAt: new Date() })
        .returning();
      await tx.insert(threadParticipant).values([
        { userId: aliceLocalIdA, threadId: t.id, updatedAt: new Date() },
        { userId: carolLocalIdA, threadId: t.id, updatedAt: new Date() },
      ]);
    });

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
    expect(resolved.event).toBe('resolved');
    expect(resolved.data).toMatchObject({
      relationship: 'NONE',
      user: { id: 0, isForeigner: true, domain: DOM_B },
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

  it('Address request carries PROFILE but creates stubs only after accept', async () => {
    const res = await request(appA.baseUrl)
      .post('/api/v1/invite/federated-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B, note: 'hi from aaa' });
    expect(res.status).toBe(200);
    expect(res.body.code, JSON.stringify(res.body)).toBe(BusinessCode.OK);

    const incoming = await vi.waitFor(
      async () => {
        const row = await appB.database.query.federatedFriendRequest.findFirst({
          where: and(
            eq(federatedFriendRequest.localUserId, bobLocalIdB),
            eq(federatedFriendRequest.remoteAccount, 'alice'),
            eq(federatedFriendRequest.remoteDomain, DOM_A),
            eq(federatedFriendRequest.direction, 'INCOMING'),
          ),
        });
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 5000, interval: 100 },
    );
    expect(
      await appB.database.query.user.findFirst({
        where: and(eq(user.account, 'alice'), eq(user.domain, DOM_A)),
      }),
    ).toBeUndefined();
    expect(incoming.expiresAt).not.toBeNull();
    expect(
      incoming.expiresAt!.getTime() - incoming.requestedAt!.getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);

    const accepted = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ account: 'alice', domain: DOM_A });
    expect(accepted.body.code).toBe(BusinessCode.OK);

    const [aliceStubB, bobStubA] = await vi.waitFor(
      async () => {
        const stubs = await Promise.all([
          appB.database.query.user.findFirst({
            where: and(eq(user.account, 'alice'), eq(user.domain, DOM_A)),
          }),
          appA.database.query.user.findFirst({
            where: and(eq(user.account, 'bob'), eq(user.domain, DOM_B)),
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
          const rows = await app.database
            .select()
            .from(friendRequest)
            .where(
              or(
                and(
                  eq(friendRequest.requesterUserId, localId),
                  eq(friendRequest.targetUserId, peerId),
                ),
                and(
                  eq(friendRequest.requesterUserId, peerId),
                  eq(friendRequest.targetUserId, localId),
                ),
              ),
            );
          expect(rows).toHaveLength(2);
          expect(rows.map((row) => row.note).sort()).toEqual([
            '',
            'hi from aaa',
          ]);
          const pair = await app.database.query.friendPair.findFirst({
            where: and(
              eq(friendPair.userLowId, Math.min(localId, peerId)),
              eq(friendPair.userHighId, Math.max(localId, peerId)),
            ),
          });
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
              eq(message.creator, aliceStubIdOnB),
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
                eq(message.creator, aliceLocalIdA),
              ),
            }),
            appB.database.query.message.findFirst({
              where: and(
                eq(message.content, JSON.stringify({ text: 'hi from alice' })),
                eq(message.creator, aliceStubIdOnB),
              ),
            }),
          ]);
          expect(source?.originSeq).toBe(source?.seq);
          expect(source?.originServerTime?.getTime()).toBe(
            remoteCopy?.createdAt.getTime(),
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
            eq(message.creator, aliceStubIdOnB),
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
            eq(message.creator, bobStubIdOnA),
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
        eq(message.creator, aliceLocalIdA),
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
        importedOnB = await findLatestForwardMessage(appB, aliceStubIdOnB);
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
        const relayed = await findLatestForwardMessage(appA, bobStubIdOnA);
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
      process.cwd(),
      'data',
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
      process.cwd(),
      'data',
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
      process.cwd(),
      'data',
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
    expect(before?.remoteProfileRev).not.toBeNull();
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
    expect(after.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
    expect(after.remoteProfileRev!).toBeGreaterThanOrEqual(
      before!.remoteProfileRev!,
    );
  });

  it('removes the legacy client peer-profile sync endpoint', async () => {
    const res = await request(appB.baseUrl)
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    expect(res.status).toBe(404);
  });

  it('local profile edit advances the shared client state revision', async () => {
    const before = await appA.database.query.user.findFirst({
      where: eq(user.id, carolLocalIdA),
      columns: { threadRevision: true },
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
          event === 'STATE_REV_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { stateRevision?: unknown }).stateRevision ===
            'number' &&
          (data as { stateRevision: number }).stateRevision >
            before!.threadRevision,
      )) as { stateRevision?: number };
      expect(payload.stateRevision).toBeGreaterThan(0);
      const delta = await request(appA.baseUrl)
        .post('/api/v1/user/query-state/delta')
        .set('Authorization', `Bearer ${tokenCarol}`)
        .send({ fromRevision: 0, toRevision: payload.stateRevision });
      expect(delta.status).toBe(200);
      expect(delta.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'PROFILE',
            user: expect.objectContaining({
              id: aliceLocalIdA,
              name: 'Alice Renamed',
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
          event === 'STATE_REV_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { stateRevision?: unknown }).stateRevision ===
            'number',
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

    // The group account (groupUser.account == the group !account) — the on-wire group address.
    const trdA = await findGroupThreadById(appA, groupThreadA);
    expect(trdA?.groupUser?.account).toBeTruthy();
    // appA is the ORIGIN: a local group-user carries the 'local' domain sentinel (isOriginThread checks
    // `=== 'local'`); the real domain is materialized only on the wire (roster/address mapping). The
    // mirror (appB) stores the origin's real domain — asserted below.
    expect(trdA?.groupUser?.domain).toBe('local');
    const groupAccount = trdA!.groupUser!.account;

    // appB mints the mirror + the incoming Invite (handleGroupInvite). Poll for the mirror thread.
    const mirrorB = await vi.waitFor(
      async () => {
        const m = await findGroupThreadByAccount(appB, groupAccount);
        expect(m).toBeDefined();
        expect(m!.groupUser?.domain).toBe(DOM_A); // mirror knows the origin
        return m!;
      },
      { timeout: 5000 },
    );

    // The invite card is delivered to bob LIVE (gap-1 fix). writeInvites now routes the INVITE card
    // through MessageFanoutService.dispatch; its federation leg (notifyOnSend) marks alice's P2P mirror
    // dirty → appB pulls the card → storePulledMessage. Before the fix the card sat undelivered on
    // alice's mirror until a manual chat-open pulled it, so a federated invitee had NO discovery path.
    // Assert the card lands on appB with no nudge from bob (the contentType + the group account on the
    // card body pinpoint it; the `!account` is globally unique).
    await vi.waitFor(
      async () => {
        const card = await appB.database.query.message.findFirst({
          where: and(
            eq(message.contentType, ContentType.INVITE),
            sql`${message.content}::text like ${`%${groupAccount}%`}`,
          ),
        });
        expect(card).toBeDefined();
      },
      { timeout: 5000 },
    );

    // Bob authors only the local USER→GROUP direction. Hold the origin's
    // state-feed confirmation to prove that accepting on a mirror is pending,
    // not optimistic membership.
    proxy.blockStateFeed(true);
    try {
      const accept = await request(appB.baseUrl)
        .post('/api/v1/group/join-request')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: mirrorB.id });
      expect(accept.status).toBe(200);
      expect(accept.body.code).toBe(BusinessCode.OK);
      await vi.waitFor(
        () => expect(proxy.blockedStateFeedCount()).toBeGreaterThan(0),
        { timeout: 5000, interval: 100 },
      );
      const pendingDetail = await request(appB.baseUrl)
        .post('/api/v1/invite/detail')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ inviteId: groupAccount });
      expect(pendingDetail.body.data).toMatchObject({
        joinRequested: true,
        alreadyJoined: false,
      });
      const premature = await appB.database.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.threadId, mirrorB.id),
          eq(threadParticipant.userId, bobLocalIdB),
          isNull(threadParticipant.leftAt),
        ),
      });
      expect(premature).toBeUndefined();
    } finally {
      proxy.blockStateFeed(false);
    }

    // The origin (appA) records bob on its canonical roster (handleGroupAccept). Poll for it.
    await vi.waitFor(
      async () => {
        const bobOnA = await appA.database.query.threadParticipant.findFirst({
          where: and(
            eq(threadParticipant.userId, bobStubIdOnA),
            eq(threadParticipant.threadId, groupThreadA),
          ),
          columns: { leftAt: true },
        });
        expect(bobOnA?.leftAt).toBeNull(); // bob is an active member on the origin roster

        const bobOnMirror =
          await appB.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, bobLocalIdB),
              eq(threadParticipant.threadId, mirrorB.id),
              isNull(threadParticipant.leftAt),
            ),
          });
        expect(bobOnMirror).toBeDefined();
      },
      { timeout: 5000 },
    );

    const confirmedMemberships = await appB.database
      .select({
        direction: groupMembershipRequest.direction,
        status: groupMembershipRequest.status,
        expiresAt: groupMembershipRequest.expiresAt,
      })
      .from(groupMembershipRequest)
      .where(
        and(
          eq(groupMembershipRequest.memberUserId, bobLocalIdB),
          inArray(groupMembershipRequest.direction, ['INVITE', 'JOIN']),
        ),
      );
    expect(confirmedMemberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'INVITE',
          status: 'MEMBER',
          expiresAt: null,
        }),
        expect.objectContaining({
          direction: 'JOIN',
          status: 'MEMBER',
          expiresAt: null,
        }),
      ]),
    );

    // The origin authors exactly one durable confirmation status. It is then
    // pulled onto the mirror like every other group message.
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
    firstMirrorGroupUserBId = mirrorB.groupUserId!;
  }, 60_000);

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
    // mirror is SHARED (MessageThread.groupUserId @unique → one mirror per group, not one per local user).
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
          SELECT mine."threadId" FROM "ThreadParticipant" mine
          JOIN "ThreadParticipant" peer ON peer."threadId" = mine."threadId"
          JOIN "MessageThread" thread ON thread.id = mine."threadId" AND thread.type = 'P2P'
          WHERE mine."userId" = ${aliceLocalIdA} AND peer."userId" = ${daveStubIdOnA}
            AND mine."leftAt" IS NULL AND peer."leftAt" IS NULL
          LIMIT 1
        `);
        expect(pairThread.rows[0]).toBeDefined();
      },
      { timeout: 5000, interval: 100 },
    );

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
        const pending =
          await appB.database.query.groupMembershipRequest.findFirst({
            where: and(
              eq(groupMembershipRequest.memberUserId, daveLocalIdB),
              eq(groupMembershipRequest.direction, 'INVITE'),
              eq(groupMembershipRequest.status, 'REQUESTED'),
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
          await appB.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, daveLocalIdB),
              eq(threadParticipant.threadId, firstMirrorBId),
              isNull(threadParticipant.leftAt),
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
          .select({ leftAt: threadParticipant.leftAt })
          .from(threadParticipant)
          .innerJoin(user, eq(user.id, threadParticipant.userId))
          .where(
            and(
              eq(threadParticipant.threadId, firstGroupThreadA),
              eq(user.account, 'dave'),
              eq(user.domain, DOM_B),
            ),
          )
          .limit(1);
        expect(daveOnOrigin?.leftAt).toBeNull();
      },
      { timeout: 5000 },
    );
    await vi.waitFor(
      async () => {
        const daveOnMirror =
          await appB.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, daveLocalIdB),
              eq(threadParticipant.threadId, firstMirrorBId),
              isNull(threadParticipant.leftAt),
            ),
          });
        expect(daveOnMirror).not.toBeNull();
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

    // Open BOTH SSE streams; alice sends; assert BOTH bob AND dave receive it (the multi-local-member fan).
    const readerBob = await openSse(appB.baseUrl, tokenB);
    const readerDave = await openSse(appB.baseUrl, tokenDave);
    try {
      // `openSse` resolves as soon as the server flushes `: connected`; registration happens
      // immediately after that write in the server process, so across processes the final connection
      // can still have a tiny not-yet-registered window. HELLO is the protocol-level ready barrier.
      await Promise.all([
        waitForSseEvent(readerBob, (event) => event === 'HELLO'),
        waitForSseEvent(readerDave, (event) => event === 'HELLO'),
      ]);
      const sendStartedAt = Date.now();
      // Start consuming both streams before the send. Waiting for the database first leaves a test-only
      // race where the short SSE frame can already have passed through one undrained response body.
      const bobEvent = waitForSseEvent(
        readerBob,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === firstMirrorBId &&
          ((data as { ts?: number }).ts ?? 0) >= sendStartedAt,
      ).catch((error) => {
        throw new Error(
          `bob did not receive shared-mirror message: ${(error as Error).message}`,
        );
      });
      const daveEvent = waitForSseEvent(
        readerDave,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === firstMirrorBId &&
          ((data as { ts?: number }).ts ?? 0) >= sendStartedAt,
      ).catch((error) => {
        throw new Error(
          `dave did not receive shared-mirror message: ${(error as Error).message}`,
        );
      });
      await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: firstGroupThreadA,
          content: 'hi both',
          contentType: 'PURE_TEXT',
        });
      // 'hi both' is pulled into the SHARED mirror; capture its receiver-local seq once, then assert the
      // identity-only NEW_MESSAGE signal { threadId, seq, ts } reached BOTH local members — the fan must
      // iterate every active local member of the one mirror thread, not just the first.
      const hiBoth = await vi.waitFor(
        async () => {
          const msg = await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, firstMirrorBId),
              eq(message.content, textContent('hi both')),
            ),
          });
          expect(msg).toBeDefined();
          return msg!;
        },
        { timeout: 5000 },
      );
      const activeLocalRecipients = await appB.database
        .select({ userId: threadParticipant.userId })
        .from(threadParticipant)
        .innerJoin(user, eq(user.id, threadParticipant.userId))
        .where(
          and(
            eq(threadParticipant.threadId, firstMirrorBId),
            isNull(threadParticipant.leftAt),
            eq(user.domain, 'local'),
          ),
        );
      expect(activeLocalRecipients.map((row) => row.userId).sort()).toEqual(
        [bobLocalIdB, daveLocalIdB].sort(),
      );
      const [bobSignal, daveSignal] = (await Promise.all([
        bobEvent,
        daveEvent,
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
        const joinDirection =
          await appB.database.query.groupMembershipRequest.findFirst({
            where: and(
              eq(groupMembershipRequest.groupUserId, firstMirrorGroupUserBId),
              eq(groupMembershipRequest.memberUserId, daveLocalIdB),
              eq(groupMembershipRequest.direction, 'JOIN'),
            ),
          });
        expect(joinDirection?.status).toBe('NOT_MEMBER');

        const pair = await appB.database.query.groupMembershipPair.findFirst({
          where: and(
            eq(groupMembershipPair.groupUserId, firstMirrorGroupUserBId),
            eq(groupMembershipPair.memberUserId, daveLocalIdB),
          ),
        });
        expect(pair?.active).toBe(false);

        const originMember =
          await appA.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, daveStubIdOnA),
              eq(threadParticipant.threadId, firstGroupThreadA),
            ),
          });
        expect(originMember?.leftAt).not.toBeNull();

        const boundaryMessage = await appA.database.query.message.findFirst({
          where: and(
            eq(message.threadId, firstGroupThreadA),
            eq(message.creator, daveStubIdOnA),
            eq(message.contentType, ContentType.SYSTEM),
            sql`${message.content}::text like '%GROUP_LEFT%'`,
          ),
        });
        expect(boundaryMessage).toBeDefined();
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
        const requestRow =
          await appB.database.query.groupMembershipRequest.findFirst({
            where: and(
              eq(groupMembershipRequest.groupUserId, firstMirrorGroupUserBId),
              eq(groupMembershipRequest.memberUserId, daveLocalIdB),
              eq(groupMembershipRequest.direction, 'INVITE'),
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
        const dave = await appB.database.query.threadParticipant.findFirst({
          where: and(
            eq(threadParticipant.userId, daveLocalIdB),
            eq(threadParticipant.threadId, firstMirrorBId),
          ),
        });
        expect(dave?.leftAt).toBeNull();
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
        const daveOnOrigin =
          await appA.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, daveStubIdOnA),
              eq(threadParticipant.threadId, firstGroupThreadA),
            ),
          });
        expect(daveOnOrigin?.leftAt).not.toBeNull();
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
            appA.database.query.threadParticipant.findFirst({
              where: and(
                eq(threadParticipant.userId, bobStubIdOnA),
                eq(threadParticipant.threadId, firstGroupThreadA),
              ),
            }),
            appA.database.query.threadAudience.findFirst({
              where: and(
                eq(threadAudience.targetDomain, DOM_B),
                eq(threadAudience.threadId, firstGroupThreadA),
              ),
            }),
            appB.database.query.threadParticipant.findFirst({
              where: and(
                eq(threadParticipant.userId, bobLocalIdB),
                eq(threadParticipant.threadId, firstMirrorBId),
              ),
            }),
          ]);
          expect(bobOnOrigin?.leftAt).not.toBeNull();
          expect(originAudience).toBeUndefined();
          expect(bobOnMirror?.leftAt).not.toBeNull();
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
        const invite =
          await appB.database.query.groupMembershipRequest.findFirst({
            where: and(
              eq(groupMembershipRequest.memberUserId, bobLocalIdB),
              eq(groupMembershipRequest.direction, 'INVITE'),
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
          appB.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, bobLocalIdB),
              eq(threadParticipant.threadId, firstMirrorBId),
            ),
          }),
        ]);
        expect(originAudience).toBeDefined();
        expect(localAudience).toBeDefined();
        expect(bobOnMirror?.leftAt).toBeNull();
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
            eq(threadParticipant.userId, bobLocalIdB),
            isNull(threadParticipant.leftAt),
          ),
        }),
      ).toBeUndefined();

      // JOIN replaces the unserved leave on the compacted directional key.
      // The local server must accept it even though the origin still believes
      // Bob is a member, and must wait for a fresh origin GROUP_META.
      const rejoin = await request(appB.baseUrl)
        .post('/api/v1/group/join-request')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: firstMirrorBId });
      expect(rejoin.body.code).toBe(BusinessCode.OK);
      const pending = await request(appB.baseUrl)
        .post('/api/v1/invite/detail')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ inviteId: firstGroupAccount });
      expect(pending.body.data).toMatchObject({
        joinRequested: true,
        alreadyJoined: false,
      });
    } finally {
      await appA.restart();
    }

    await vi.waitFor(
      async () => {
        const [originMember, mirrorMember] = await Promise.all([
          appA.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.threadId, firstGroupThreadA),
              eq(threadParticipant.userId, bobStubIdOnA),
              isNull(threadParticipant.leftAt),
            ),
          }),
          appB.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.threadId, firstMirrorBId),
              eq(threadParticipant.userId, bobLocalIdB),
              isNull(threadParticipant.leftAt),
            ),
          }),
        ]);
        expect(originMember).toBeDefined();
        expect(mirrorMember).toBeDefined();
        const detail = await request(appB.baseUrl)
          .post('/api/v1/invite/detail')
          .set('Authorization', `Bearer ${tokenB}`)
          .send({ inviteId: firstGroupAccount });
        expect(detail.body.data).toMatchObject({
          joinRequested: false,
          alreadyJoined: true,
        });
      },
      { timeout: 5000, interval: 150 },
    );
  }, 60_000);

  it('rejects a federated join at the origin capacity and clears the mirror pending state', async () => {
    const created = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'full-fed-group' });
    expect(created.body.code).toBe(BusinessCode.OK);
    const originThreadId = created.body.data.threadId as number;
    const invited = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: originThreadId, userIds: [bobStubIdOnA] });
    expect(invited.body.code).toBe(BusinessCode.OK);
    const originThread = await findGroupThreadById(appA, originThreadId);
    const groupAccount = originThread!.groupUser.account;
    const mirror = await vi.waitFor(
      async () => {
        const row = await findGroupThreadByAccount(appB, groupAccount);
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 5000, interval: 100 },
    );

    // The owner is already member #1. Fill the origin roster to its local
    // 999-person policy without encoding that number in any wire payload.
    const suffix = randomUUID().slice(0, 8);
    const fillers = await appA.database
      .insert(user)
      .values(
        Array.from({ length: SERVER_MAX_GROUP_MEMBERS - 1 }, (_, index) => ({
          account: `cap-${suffix}-${index}`,
          name: `capacity ${index}`,
          domain: 'local',
          isForeigner: false,
          updatedAt: new Date(),
        })),
      )
      .returning({ id: user.id });
    await appA.database.insert(threadParticipant).values(
      fillers.map((filler) => ({
        threadId: originThreadId,
        userId: filler.id,
        role: GroupRole.MEMBER,
        updatedAt: new Date(),
      })),
    );

    proxy.blockStateFeed(true);
    try {
      const accepted = await request(appB.baseUrl)
        .post('/api/v1/group/join-request')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: mirror.id });
      expect(accepted.body.code).toBe(BusinessCode.OK);
      await vi.waitFor(
        () => expect(proxy.blockedStateFeedCount()).toBeGreaterThan(0),
        { timeout: 5000, interval: 100 },
      );
      const pending = await request(appB.baseUrl)
        .post('/api/v1/invite/detail')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ inviteId: groupAccount });
      expect(pending.body.data).toMatchObject({
        joinRequested: true,
        alreadyJoined: false,
      });
    } finally {
      proxy.blockStateFeed(false);
    }

    await vi.waitFor(
      async () => {
        const detail = await request(appB.baseUrl)
          .post('/api/v1/invite/detail')
          .set('Authorization', `Bearer ${tokenB}`)
          .send({ inviteId: groupAccount });
        expect(detail.body.data).toMatchObject({
          status: 'REVOKED',
          joinRequested: false,
          alreadyJoined: false,
          note: SERVER_GROUP_FULL_REASON,
        });
        const mirrorParticipant =
          await appB.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.threadId, mirror.id),
              eq(threadParticipant.userId, bobLocalIdB),
              isNull(threadParticipant.leftAt),
            ),
          });
        expect(mirrorParticipant).toBeUndefined();
      },
      { timeout: 5000, interval: 100 },
    );
    const [originCount] = await appA.database
      .select({ value: count() })
      .from(threadParticipant)
      .where(
        and(
          eq(threadParticipant.threadId, originThreadId),
          isNull(threadParticipant.leftAt),
        ),
      );
    expect(Number(originCount.value)).toBe(SERVER_MAX_GROUP_MEMBERS);
    expect(
      await appA.database.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.threadId, originThreadId),
          eq(threadParticipant.userId, bobStubIdOnA),
          isNull(threadParticipant.leftAt),
        ),
      }),
    ).toBeUndefined();
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
          tombstoneEndSeq: 1n,
        })
        .onConflictDoUpdate({
          target: [
            federationTombstoneFeedIndex.peerDomain,
            federationTombstoneFeedIndex.threadId,
          ],
          set: { feedId: head!.feedId, tombstoneEndSeq: 1n },
        });
    });

    const res = await request(appA.baseUrl)
      .post('/api/v1/user/delete-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ userId: bobStubIdOnA });
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
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ toUserId: bobStubIdOnA, note: 'revive from alice' });
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
      { timeout: 5000, interval: 100 },
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
      { timeout: 5000, interval: 100 },
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
      { timeout: 5000, interval: 100 },
    );
  });

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
      origin: `${DOM_A}-evil`,
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

  it('recovers a degraded peer through Healthy without replacing recognition facts', async () => {
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

  // This destructive lifecycle now has its own isolated fixture in federation-reset.e2e-spec.ts.
  it.skip('destructively resets identity-lost peer data and permits one fresh init without inheriting authorization (covered independently)', async () => {
    // Make this destructive lifecycle test independent of the preceding network-degradation test. A restart
    // also gives the in-memory bbb fixture a new physical key, matching the same-domain replacement case
    // that reset is designed to permit only after all old authorization has been removed.
    await appB.restart();

    const affectedBefore = await appA.database.execute<{
      id: number;
      federationVersion: number;
    }>(sql`
      SELECT DISTINCT mt.id, mt."federationVersion"
      FROM "MessageThread" mt
      LEFT JOIN "ThreadParticipant" tp ON tp."threadId" = mt.id
      LEFT JOIN "User" participant ON participant.id = tp."userId"
      LEFT JOIN "User" group_user ON group_user.id = mt."groupUserId"
      LEFT JOIN "Message" m ON m."threadId" = mt.id
      LEFT JOIN "User" creator ON creator.id = m.creator
      WHERE (participant.domain = ${DOM_B} AND participant."isForeigner" = true)
         OR (group_user.domain = ${DOM_B} AND group_user."isForeigner" = true)
         OR (creator.domain = ${DOM_B} AND creator."isForeigner" = true)
      ORDER BY mt.id
    `);
    expect(affectedBefore.rows.length).toBeGreaterThan(0);

    // Identity mismatch handling normally writes this state. Setting it directly keeps this test focused
    // on the destructive admin workflow rather than manufacturing a second process identity.
    await appA.database
      .update(federatedPeer)
      .set({
        trustLevel: 'halted',
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: 'e2e simulated identity mismatch',
      })
      .where(eq(federatedPeer.domain, DOM_B));

    const preview = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/reset-preview`)
      .set('Cookie', adminCookieA)
      .send();
    expect(preview.status).toBe(200);
    expect(preview.body.data.affectedThreadCount).toBe(
      affectedBefore.rows.length,
    );

    const started = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/reset`)
      .set('Cookie', adminCookieA)
      .send({ confirmDomain: DOM_B });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({
      domain: DOM_B,
      status: 'reset_in_progress',
      affectedThreadCount: affectedBefore.rows.length,
    });

    await vi.waitFor(
      async () => {
        const peer = await appA.database.query.federatedPeer.findFirst({
          where: eq(federatedPeer.domain, DOM_B),
        });
        const tombstone =
          await appA.database.query.federatedPeerReset.findFirst({
            where: eq(federatedPeerReset.domain, DOM_B),
          });
        expect(peer).toBeUndefined();
        expect(tombstone?.reinitPending).toBe(true);
      },
      { timeout: 5000, interval: 100 },
    );

    const affectedIds = affectedBefore.rows.map((row) => row.id);
    const shells = await appA.database
      .select({
        id: messageThread.id,
        federationTruncated: messageThread.federationTruncated,
        federationVersion: messageThread.federationVersion,
        groupUserId: messageThread.groupUserId,
      })
      .from(messageThread)
      .where(inArray(messageThread.id, affectedIds));
    expect(shells).toHaveLength(affectedIds.length);
    for (const shell of shells) {
      const before = affectedBefore.rows.find((row) => row.id === shell.id)!;
      expect(shell.federationTruncated).toBe(true);
      expect(shell.federationVersion).toBe(before.federationVersion + 1);
      expect(shell.groupUserId).toBeNull();
    }

    const remainingResult = await appA.database.execute<{
      users: number;
      participants: number;
      messages: number;
      deleteRevisions: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM "User"
          WHERE domain = ${DOM_B} AND "isForeigner" = true) AS users,
        (SELECT count(*)::int FROM "ThreadParticipant"
          WHERE "threadId" IN (${sql.join(
            affectedIds.map((id) => sql`${id}`),
            sql`, `,
          )})) AS participants,
        (SELECT count(*)::int FROM "Message"
          WHERE "threadId" IN (${sql.join(
            affectedIds.map((id) => sql`${id}`),
            sql`, `,
          )})) AS messages,
        (SELECT count(*)::int FROM "ThreadRevision"
          WHERE "threadId" IN (${sql.join(
            affectedIds.map((id) => sql`${id}`),
            sql`, `,
          )})
            AND direction = 'DELETE') AS "deleteRevisions"
    `);
    const remaining = remainingResult.rows[0];
    expect(remaining).toMatchObject({
      users: 0,
      participants: 0,
      messages: 0,
    });
    expect(remaining.deleteRevisions).toBeGreaterThan(0);

    const rejoined = await establishFederatedFriendship({
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
      note: 'post-reset request',
    });
    expect(rejoined.remoteStubIdOnLocal).not.toBe(bobStubIdOnA);

    const [rejoinedPeer, consumedReset] = await Promise.all([
      appA.database.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, DOM_B),
      }),
      appA.database.query.federatedPeerReset.findFirst({
        where: eq(federatedPeerReset.domain, DOM_B),
      }),
    ]);
    expect(rejoinedPeer?.trustLevel).toBe('available');
    expect(consumedReset?.reinitPending).toBe(false);

    const inheritedParticipants = await appA.database
      .select({ threadId: threadParticipant.threadId })
      .from(threadParticipant)
      .where(
        and(
          eq(threadParticipant.userId, rejoined.remoteStubIdOnLocal),
          inArray(threadParticipant.threadId, affectedIds),
        ),
      );
    expect(inheritedParticipants).toHaveLength(0);
  });
});
