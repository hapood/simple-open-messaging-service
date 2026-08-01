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
  registerAndLogin,
  getAdminCookie,
  openSse,
  waitForSseEvent,
} from './federation-test-helpers.js';
import { BusinessCode } from '../src/common/business-code.js';
import { SignatureService } from '../src/federation/signature.service.js';
import { ContentType, MessageThreadType } from '../src/database/enums.js';
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  federatedPeer,
  federatedPeerEvent,
  forwardBundle,
  forwardBundleDependency,
  forwardMessage,
  invite,
  mediaAsset,
  mediaMessage,
  message,
  messageThread,
  s2SKeyCache,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { randomUUID } from 'node:crypto';

/**
 * Federation e2e — two full SOMS apps (aaa.local + bbb.local) in one process, making real signed HTTP
 * requests to each other over loopback. Exercises the full S2S chain: signOutbound → fetch → Fastify
 * preParsing raw-body capture → content-digest + signature verify → init handshake → friend flows →
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
  let firstGroupAccount: string; // its `!account` (groupUser.account) — the on-wire group address
  let tokenDave: string; // dave @ appB — a SECOND local member of the same mirror (shared-mirror fan-out test)
  let daveLocalIdB: number;

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

  async function countPendingInvites(
    app: FedApp,
    firstUserId: number,
    secondUserId: number,
  ): Promise<number> {
    const [row] = await app.database
      .select({ count: sql<number>`count(*)::int` })
      .from(invite)
      .where(
        and(
          eq(invite.kind, 'FRIEND'),
          eq(invite.status, 'PENDING'),
          or(
            and(
              eq(invite.fromUserId, firstUserId),
              eq(invite.toUserId, secondUserId),
            ),
            and(
              eq(invite.fromUserId, secondUserId),
              eq(invite.toUserId, firstUserId),
            ),
          ),
        ),
      );
    return row.count;
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
        depth: forwardBundle.depth,
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
            bundle: { depth: row.depth },
          },
        }
      : undefined;
  }

  beforeAll(async () => {
    // Force tiny media chunks so a modest fixture file spans multiple Range requests — exercises the
    // resumable multi-chunk transport without allocating a multi-MB blob. Set BEFORE boot so the config
    // (loaded at FederationService field-init in each subprocess) picks it up.
    process.env.SOMS_MEDIA_CHUNK_BYTES = '64';
    // Boot appA (aaa.local) + appB (bbb.local) in SEPARATE processes on SEPARATE databases. Each app is
    // its own Node process (isolated global state — Passport's `local` strategy etc. are per-app, not
    // cross-app leaks) + its own DB (a group's groupUser.account is @unique per DB). A transparent S2S proxy
    // sits on appB→appA (for the resume test's fault injection). bootFederationPair asserts the DBs differ.
    ({ appA, appB, proxy } = await bootFederationPair());
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
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('init handshake establishes mutual trust on resolve', async () => {
    // alice@appA resolves bob@bbb.local → triggers ensurePeerTrusted(bbb.local) → mutual init.
    const res = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data.isForeigner).toBe(true);
    expect(res.body.data.domain).toBe(DOM_B);
    bobStubIdOnA = res.body.data.id;

    // appA now trusts bbb.local.
    const peerA = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(peerA?.trustLevel).toBe('trusted');
    // appB auto-accepted the init → trusts aaa.local (mutual).
    const peerB = await appB.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_A),
    });
    expect(peerB?.trustLevel).toBe('trusted');
  });

  it('friend.request carries the profile and localizes the avatar on the receiver', async () => {
    const res = await request(appA.baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ toUserId: bobStubIdOnA, note: 'hi from aaa' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appB created a stub of alice with a localized avatar (saved through saveAvatars → /uploads/).
    const aliceStubB = await appB.database.query.user.findFirst({
      where: and(eq(user.account, 'alice'), eq(user.domain, DOM_A)),
    });
    expect(aliceStubB).toBeDefined();
    expect(aliceStubB!.isForeigner).toBe(true);
    expect(aliceStubB!.avatar).toMatch(/^\/uploads\/.+-(512)\.webp$/);
    aliceStubIdOnB = aliceStubB!.id;

    // appB has a PENDING FRIEND Invite from alice's stub (the S2S delivery created it + armed the badge).
    const inviteB = await appB.database.query.invite.findFirst({
      where: and(
        eq(invite.kind, 'FRIEND'),
        eq(invite.status, 'PENDING'),
        eq(invite.fromUserId, aliceStubIdOnB),
      ),
    });
    expect(inviteB).toBeDefined();
    expect(inviteB!.toUserId).not.toBe(aliceStubIdOnB); // addressed to bob (local), not the stub

    // Crossed-request edge: before accepting Alice's request, Bob independently adds Alice. Both
    // nodes temporarily hold one incoming + one outgoing PENDING row for the pair.
    const reverse = await request(appB.baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ toUserId: aliceStubIdOnB, note: 'hi back from bbb' });
    expect(reverse.status).toBe(200);
    expect(reverse.body.code).toBe(BusinessCode.OK);

    const pendingA = await countPendingInvites(
      appA,
      aliceLocalIdA,
      bobStubIdOnA,
    );
    const pendingB = await countPendingInvites(
      appB,
      bobLocalIdB,
      aliceStubIdOnB,
    );
    expect(pendingA).toBe(2);
    expect(pendingB).toBe(2);
  });

  it('friend.approve (no profile) creates the P2P thread on both servers', async () => {
    // appB accepts the inbound invite from alice's stub by its id.
    const inv = await appB.database.query.invite.findFirst({
      where: and(
        eq(invite.kind, 'FRIEND'),
        eq(invite.status, 'PENDING'),
        eq(invite.fromUserId, aliceStubIdOnB),
      ),
    });
    expect(inv).toBeDefined();
    const res = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ inviteId: inv!.id.toString() });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appB (approver side): invite ACCEPTED + an active P2P thread with alice's stub.
    const invB = await appB.database.query.invite.findFirst({
      where: and(
        eq(invite.kind, 'FRIEND'),
        eq(invite.fromUserId, aliceStubIdOnB),
      ),
    });
    expect(invB?.status).toBe('ACCEPTED');
    const threadB = await findActiveP2pParticipant(appB, aliceStubIdOnB);
    expect(threadB).toBeDefined();

    // appA (requester side): received friend.approve → its own P2P thread + outgoing invite ACCEPTED.
    const invA = await appA.database.query.invite.findFirst({
      where: and(
        eq(invite.kind, 'FRIEND'),
        eq(invite.fromUserId, aliceLocalIdA),
        eq(invite.toUserId, bobStubIdOnA),
      ),
    });
    expect(invA?.status).toBe('ACCEPTED');
    expect(await countPendingInvites(appA, aliceLocalIdA, bobStubIdOnA)).toBe(
      0,
    );
    expect(await countPendingInvites(appB, bobLocalIdB, aliceStubIdOnB)).toBe(
      0,
    );
    const threadA = await findActiveP2pParticipant(appA, bobStubIdOnA);
    expect(threadA).toBeDefined();

    // appA's stub of bob also has a localized avatar (pulled at resolve time, pre-request).
    const bobStubA = await appA.database.query.user.findFirst({
      where: eq(user.id, bobStubIdOnA),
    });
    expect(bobStubA?.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
  });

  // ─── Step 2: cross-server 1:1 messages + media ───────────────────────────────
  // alice@appA ↔ bob@appB are now APPROVED with a P2P thread on each server. These exercise the
  // coalesced hint-map push → active-pull pipeline: a send marks the outbound map dirty → a debounced
  // /new-msg-map push → the peer drains pendingPulls → /messages pull → idempotent store + SSE.

  /** Resolve alice's P2P thread on appA (the thread she sends into). A friend relationship == a
   *  shared active P2P thread, so look it up via the bob stub's active participant row. */
  async function alicesThreadIdOnA(): Promise<number> {
    const p = await findActiveP2pParticipant(appA, bobStubIdOnA);
    if (!p?.threadId) throw new Error('alice↔bob thread missing on appA');
    return p.threadId;
  }

  async function sendFederatedImage(bytes: Buffer, dimension: number) {
    const clientMessageId = randomUUID();
    const stage = await request(appA.baseUrl)
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        contentType: 'IMAGE',
        clientMessageId,
        meta: { w: dimension, h: dimension },
      });
    expect(stage.body.code).toBe(BusinessCode.OK);
    const upload = await request(appA.baseUrl)
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', bytes, 'federated.png')
      .field('w', String(dimension))
      .field('h', String(dimension));
    expect(upload.body.code).toBe(BusinessCode.OK);
    const { url, size } = upload.body.data as { url: string; size: number };
    const digest = url
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '');
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
          expect(msg!.originSeq).toBe(0); // alice's first message → originSeq 0 (0-indexed), copied verbatim
          bobLocalThreadId = msg!.threadId;
          bobLocalSeq = msg!.seq;
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
      forwardMessage: { bundleId: string; bundle: { depth: number } } | null;
    } | null = null;
    await vi.waitFor(
      async () => {
        importedOnB = await findLatestForwardMessage(appB, aliceStubIdOnB);
        expect(importedOnB?.forwardMessage?.bundle.depth).toBe(1);
      },
      { timeout: 8000 },
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
        clientMessageId: clientMessageIdB,
      });
    expect(nested.status).toBe(200);
    expect(nested.body.code).toBe(BusinessCode.OK);

    await vi.waitFor(
      async () => {
        const relayed = await findLatestForwardMessage(appA, bobStubIdOnA);
        expect(relayed?.forwardMessage?.bundle.depth).toBe(2);
        const closure =
          await appA.database.query.forwardBundleDependency.findMany({
            where: eq(
              forwardBundleDependency.parentBundleId,
              relayed!.forwardMessage!.bundleId,
            ),
          });
        expect(closure).toHaveLength(1);
      },
      { timeout: 8000 },
    );
  }, 30_000);

  it('Step 2: pull-on-open is idempotent (a re-sync stores no duplicate)', async () => {
    const before = await countMessages(
      appB,
      eq(message.creator, aliceStubIdOnB),
    );
    // sync-peer-profile triggers pull-on-open (§4.4) — fire-and-forget; the originSeq unique index
    // absorbs the re-pull as a no-op (the message is already at the cursor).
    await request(appB.baseUrl)
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    // Let the async pull settle, then assert nothing duplicated.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await countMessages(
      appB,
      eq(message.creator, aliceStubIdOnB),
    );
    expect(after).toBe(before);
  });

  it('GET /s2s/messages/before — backward paging (serve-only path; driven via the test probe)', async () => {
    // /messages/before is the BACKWARD twin of /messages. SOMS is forward-only (no internal caller), so
    // drive it directly: appB's test probe signs a GET as appB → appA serves alice's messages with
    // originSeq < beforeSeq, OLDEST-FIRST (desc query + reverse). Seeds 3 fresh alice→bob messages for a
    // deterministic page, then asserts the /before-specific delta vs the e2e'd forward serve: the `<`
    // filter, the desc→reverse oldest-first ordering, hasMore (both ways), latestSeq, + the
    // beforeSeq<0 (no-upper-bound) branch. (Per design-review B3: the shared gate/query/message-map is
    // covered by the forward e2e; this covers only the backward delta.)
    const threadId = await alicesThreadIdOnA();
    for (const c of ['mb-1', 'mb-2', 'mb-3']) {
      const r = await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ threadId, content: c, contentType: 'PURE_TEXT' });
      expect(r.body.code).toBe(BusinessCode.OK);
    }
    // alice's messages on appA (the serving side), originSeq ascending. Includes the 3 seeded + any from
    // earlier Step-2 tests — all are < (max+1), so the assertions hold regardless of the prior count.
    const rows = await appA.database.query.message.findMany({
      where: and(
        eq(message.threadId, threadId),
        eq(message.creator, aliceLocalIdA),
      ),
      orderBy: message.originSeq,
      columns: { originSeq: true },
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const allSeqs = rows.map((r) => r.originSeq ?? 0);
    const maxSeq = allSeqs[allSeqs.length - 1];

    // Drive appA's /s2s/messages/before as appB (the requester) via the test probe.
    const before = async (beforeSeq: number, take: number) =>
      (await fetch(
        `http://127.0.0.1:${appB.port}/api/v1/test/signed-s2s-get?peerDomain=${DOM_A}&path=${encodeURIComponent(
          `/api/v1/s2s/messages/before?fromAccount=alice&fromDomain=${DOM_A}&toAccount=bob&toDomain=${DOM_B}&beforeSeq=${beforeSeq}&take=${take}`,
        )}`,
      ).then((r) => r.json())) as {
        status: number;
        body: {
          code: number;
          message: string;
          data: {
            messages: { originSeq: number }[];
            latestSeq: number;
            hasMore: boolean;
          };
        };
      };

    // (1) beforeSeq < 0 → no upper bound: every message, OLDEST-FIRST (the desc→reverse output — a
    //     missing reverse would surface as descending), hasMore false, latestSeq = alice's MAX originSeq.
    //     The s2s success body is an ApiResult envelope { code, message, data } (since S2sController
    //     dropped @Raw); the test probe relays it verbatim, so the payload is under body.data.
    const pageAll = await before(-1, 50);
    expect(pageAll.status).toBe(200);
    expect(pageAll.body.data.messages.map((m) => m.originSeq)).toEqual(allSeqs);
    expect(pageAll.body.data.hasMore).toBe(false);
    expect(pageAll.body.data.latestSeq).toBe(maxSeq);

    // (2) beforeSeq = maxSeq + 1, take 2 → the 2 highest ([secondMax, max], oldest-first), hasMore true
    //     (≥3 messages sit below maxSeq+1). Confirms the strict `<` filter + subset paging + hasMore.
    const pageTwo = await before(maxSeq + 1, 2);
    expect(pageTwo.status).toBe(200);
    expect(pageTwo.body.data.messages.map((m) => m.originSeq)).toEqual([
      allSeqs[allSeqs.length - 2],
      maxSeq,
    ]);
    expect(pageTwo.body.data.hasMore).toBe(true);
    expect(pageTwo.body.data.latestSeq).toBe(maxSeq);
  }, 30_000);

  it('Step 2: pull-on-open recovers a message missing on the peer (resilience backstop)', async () => {
    // alice sends; the push delivers it to appB (stored under alice's STUB as the creator — appB's own
    // copy in its own thread, distinct from appA's copy in appA's thread, even though both apps share
    // the per-fork test database).
    await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        content: 'recover me',
        contentType: 'PURE_TEXT',
      });
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.content, JSON.stringify({ text: 'recover me' })),
              eq(message.creator, aliceStubIdOnB),
            ),
          }),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );
    // Simulate a message appB never stored (a lost push / a store that failed after the pull): wipe ONLY
    // appB's copy — scoped by creator so appA's own copy (creator = alice's local id) survives to be
    // re-pulled. The cursor (MAX originSeq for alice's stub on appB) drops, so pull-on-open sees the gap.
    await appB.database
      .delete(message)
      .where(
        and(
          eq(message.content, JSON.stringify({ text: 'recover me' })),
          eq(message.creator, aliceStubIdOnB),
        ),
      );
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.content, JSON.stringify({ text: 'recover me' })),
          eq(message.creator, aliceStubIdOnB),
        ),
      }),
    ).toBeUndefined();

    // bob opens the thread → pull-on-open re-derives the cursor + re-fetches the gap from appA — the
    // §4.4 backstop that makes a lost push non-fatal.
    await request(appB.baseUrl)
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.content, JSON.stringify({ text: 'recover me' })),
              eq(message.creator, aliceStubIdOnB),
            ),
          }),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );
  });

  it('Step 2: a federated image localizes on the peer (media round-trip, same-origin)', async () => {
    // alice uploads an image on appA (fixture) → a CAS url. Sent as an IMAGE message whose content
    // embeds the url (the shape extractDigestEntries scans for the digest + ext).
    const { url, digest } = await sendFederatedImage(
      await makePng(Math.floor(Math.random() * 256)),
      16,
    );

    // The message pulls, then localizeMedia fetches the digest via /get_file + stores it in appB's CAS
    // (byte-identical → same shard path) + writes the MediaMessage authz row. Poll for both.
    await vi.waitFor(
      async () => {
        const asset = await appB.database.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        expect(asset).toBeDefined();
        expect(asset!.refs).toBeGreaterThan(0);
        const mm = await appB.database.query.mediaMessage.findFirst({
          where: eq(mediaMessage.digest, digest),
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
      'uploads',
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    await expect(stat(abs)).resolves.toBeDefined();
  });

  it('Step 2: a federated file localizes over multiple Range chunks (resumable transport)', async () => {
    // A 48x48 PNG spans several 64-byte chunks (chunk size forced small in beforeAll). The file can ONLY
    // localize if appB fetches /get_file as a sequence of signed Range GETs + reassembles them — so a
    // byte-exact result here PROVES the multi-chunk path (no need to count /get_file calls).
    const { url, size, digest } = await sendFederatedImage(
      await makePng(77, 48),
      48,
    );

    // appB (its own DB) has never seen this asset → localizeMedia fetches it over /get_file + writes a
    // MediaAsset + MediaMessage row. (No shared-DB dedup to defeat: appA's row is in _a, appB's in _b.)
    await vi.waitFor(
      async () => {
        const asset = await appB.database.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        expect(asset).toBeDefined();
        expect(asset!.refs).toBeGreaterThan(0);
        const mm = await appB.database.query.mediaMessage.findFirst({
          where: eq(mediaMessage.digest, digest),
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
      'uploads',
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    const onDisk = await readFile(abs);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(digest);
    expect(onDisk.length).toBe(size);
  });

  it('Step 2: a dropped /get_file chunk resumes from its offset (no demote, byte-exact)', async () => {
    const imageBytes = await makePng(190, 48);

    // Arm the S2S proxy (on appB→appA) to truncate the FIRST /get_file `bytes=0-` response mid-stream —
    // a simulated network drop. appB must discard the partial unit + re-request the SAME range (resume),
    // NOT demote appA. The proxy preserves the signed Host, so signatures still verify at appA.
    proxy.armGetFileTruncation();

    const { url, size, digest } = await sendFederatedImage(imageBytes, 48);

    await vi.waitFor(
      async () => {
        const asset = await appB.database.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        expect(asset).toBeDefined();
        expect(asset!.refs).toBeGreaterThan(0);
      },
      { timeout: 8000 },
    );

    // Resume proven: the first-range /get_file was issued ≥2 times through the proxy (the initial call
    // that got truncated + the retry that succeeded) → appB re-requested the SAME range, not restarted.
    expect(proxy.firstRangeGetFileCount()).toBeGreaterThanOrEqual(2);
    // A mid-body stall is a stream glitch, not a trust failure → appB must still trust appA.
    const peer = await appB.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_A),
    });
    expect(peer?.trustLevel).toBe('trusted');

    // Integrity: the resumed file re-hashes to the digest (no gap/duplicate from the drop + retry).
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const nodePath = await import('node:path');
    const abs = nodePath.join(
      process.cwd(),
      'data',
      'uploads',
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    const onDisk = await readFile(abs);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(digest);
    expect(onDisk.length).toBe(size);
  });

  it('/revision probe re-pulls a changed avatar', async () => {
    const before = await appB.database.query.user.findFirst({
      where: eq(user.id, aliceStubIdOnB),
    });
    expect(before?.remoteProfileRev).not.toBeNull();
    const avatarBefore = before!.avatar;

    // alice changes her avatar on appA → profileRev bumps (multipart upload — the real path).
    await uploadAvatar(appA, tokenA, png2);

    // bob@appB opens the chat → sync-peer-profile ACKs immediately; the federated probe + re-pull run
    // ASYNC (fire-and-forget). Poll for the re-localized avatar + advanced remoteProfileRev.
    const sync = await request(appB.baseUrl)
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    expect(sync.status).toBe(200);
    expect(sync.body.code).toBe(BusinessCode.OK);

    const after = await vi.waitFor(
      async () => {
        const a = await appB.database.query.user.findFirst({
          where: eq(user.id, aliceStubIdOnB),
        });
        expect(a?.avatar).not.toBe(avatarBefore); // re-pulled to the new avatar
        return a!;
      },
      { timeout: 8000 },
    );
    expect(after.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
    expect(after.remoteProfileRev!).toBeGreaterThanOrEqual(
      before!.remoteProfileRev!,
    );
  });

  it('sync-peer-profile is ACK-only (no payload) and no-ops when the stub is fresh', async () => {
    // After the re-pull above, the stub is fresh (remoteProfileRev == appA's profileRev). The signal-only
    // design ALWAYS returns ACK with NO profile payload; a fresh stub triggers no async re-pull.
    const before = await appB.database.query.user.findFirst({
      where: eq(user.id, aliceStubIdOnB),
      columns: { avatar: true, remoteProfileRev: true },
    });
    expect(before).toBeDefined();
    const avatarBefore = before!.avatar;

    const res = await request(appB.baseUrl)
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        userId: aliceStubIdOnB,
        sinceProfileRev: before!.remoteProfileRev!,
      });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data).toBeFalsy(); // ACK-only — no profile payload on the wire

    // Fresh stub → the async federated probe finds nothing newer → no re-localize. Give the async probe a
    // moment to (not) re-pull, then confirm the avatar is untouched.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await appB.database.query.user.findFirst({
      where: eq(user.id, aliceStubIdOnB),
      columns: { avatar: true },
    });
    expect(after?.avatar).toBe(avatarBefore);
  });

  it('local profile edit fans PEER_PROFILE_UPDATED to every approved peer', async () => {
    // alice (@appA) edits her name → notifyPeersOfProfileUpdate → each approved P2P peer gets a
    // PEER_PROFILE_UPDATED SIGNAL ({ userId }) via SSE. carol is alice's LOCAL approved peer on appA (a
    // foreign stub holds no SSE connection), so read carol's real SSE stream for the frame.
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
          event === 'PEER_PROFILE_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { userId?: number }).userId === aliceLocalIdA,
      )) as { userId?: number };
      // Signal-only: the payload carries just { userId } — the client HTTP-pulls the fresh profile itself
      // (the project's SSE-signal-only convention). No profile fields on the wire.
      expect(payload.userId).toBe(aliceLocalIdA);
    } finally {
      await reader.cancel();
    }
  });

  it("federated re-localization fans PEER_PROFILE_UPDATED to the stub's local friends (catch-up)", async () => {
    // bob (@appB) is the local friend of the alice stub on appB. When the stub is re-localized (alice
    // changes her avatar on appA, then bob@appB's sync-peer-profile probes + re-localizes), the stub's
    // local friends get the push without each probing independently — the only way federated peers
    // benefit from the push (no S2S profile-push; federation is pull-based).
    // Stale the stub again (distinct avatar bytes → a newer revision on appA) via the real upload route.
    await uploadAvatar(appA, tokenA, await makePng(180));

    // Read bob's real SSE stream — he's the stub's local friend, so the re-localization pushes to him.
    const reader = await openSse(appB.baseUrl, tokenB);
    try {
      await request(appB.baseUrl)
        .post('/api/v1/user/sync-peer-profile')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ userId: aliceStubIdOnB });
      // The re-localization is ASYNC (syncForeignUserIfStale is fire-and-forget); the SIGNAL ({ userId })
      // fires once localizeForeignProfile completes. waitForSseEvent polls until it lands.
      await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'PEER_PROFILE_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { userId?: number }).userId === aliceStubIdOnB,
      );
    } finally {
      await reader.cancel();
    }
  });

  // ─── Step 3 Phase B: cross-server group messaging (origin-hub) ────────────────
  it('Step 3: federated group — invite → accept → origin-hub message delivery', async () => {
    // alice@appA creates a group and invites bob@appB (a federated friend). writeInvites sends the
    // cross-server invite (peer mints the mirror + Invite) AND writes the GROUP_INVITE card into alice's
    // P2P mirror (it flows to bob via the Step-2 pull). The card + the accept key on the group `!account`.
    const create = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'fed-group', inviteUserIds: [bobStubIdOnA] });
    expect(create.status).toBe(200);
    expect(create.body.code).toBe(BusinessCode.OK);
    const groupThreadA = create.body.data.threadId as number;

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
      { timeout: 8000 },
    );

    // bob accepts via the group account (the federated-stable card identity). appB's acceptInvite
    // resolves the pending Invite by (toUser=bob, thread.groupUser.account) + notifies the origin.
    const accept = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ inviteId: groupAccount });
    expect(accept.status).toBe(200);
    expect([
      BusinessCode.OK,
      BusinessCode.FEDERATION_DELIVERY_FAILED,
    ]).toContain(accept.body.code);

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
      },
      { timeout: 5000 },
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
        { timeout: 8000 },
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
  }, 60_000);

  it('Step 3: group chat-open recovers messages the mirror fell behind on (open-message backstop)', async () => {
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
      { timeout: 8000 },
    );

    // Simulate the stuck state (a hint the debounce dropped / a lost push): the mirror's pull never
    // advanced for these two. Wipe them AND regress pullUntil to BEFORE open-recover-1. Groups use a
    // STORED cursor in the ORIGIN's thread-seq space (the global per-thread order — NOT originSeq, which is
    // per-author), so a deletion alone would NOT self-heal (unlike P2P's derived MAX). We regress the
    // cursor explicitly — the exact real stuck condition — reading open-recover-1's origin thread seq from
    // appA (the authority), since appB's stored copy carries only its OWN local seq + the per-author originSeq.
    const recover1OriginSeq = (await appA.database.query.message.findFirst({
      where: and(
        eq(message.threadId, firstGroupThreadA),
        eq(message.content, textContent('open-recover-1')),
      ),
      columns: { seq: true },
    }))!.seq;
    await appB.database
      .delete(message)
      .where(
        and(
          eq(message.threadId, firstMirrorBId),
          inArray(message.content, [
            textContent('open-recover-1'),
            textContent('open-recover-2'),
          ]),
        ),
      );
    await appB.database
      .update(messageThread)
      .set({ pullUntil: recover1OriginSeq - 1 })
      .where(eq(messageThread.id, firstMirrorBId));
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, firstMirrorBId),
          eq(message.content, textContent('open-recover-1')),
        ),
      }),
    ).toBeUndefined();

    // bob opens the group chat → /group/sync-meta → syncGroupMessagesOnOpen → force-pull (bypasses the
    // receiver debounce) → re-fetches both. Without the #1 fix, these would stay stuck on the origin
    // until some OTHER message re-triggered a push.
    await request(appB.baseUrl)
      .post('/api/v1/group/sync-meta')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: firstMirrorBId });
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
      { timeout: 8000 },
    );
  }, 60_000);

  it('Step 3: two local members on the same mirror both receive an origin message (shared mirror)', async () => {
    // The untested topology path: TWO local members (bob + dave) on appB's SAME mirror thread. A pulled
    // message must SSE-fan to EVERY local active member (storePulledMessage's recipient loop), and the
    // mirror is SHARED (MessageThread.groupUserId @unique → one mirror per group, not one per local user).
    // Friend gate for the group invite: befriend alice↔dave (resolve → request → dave accepts).
    const resolveDave = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'dave', domain: DOM_B });
    expect(resolveDave.body.code).toBe(BusinessCode.OK);
    const daveStubA = resolveDave.body.data.id as number;

    await request(appA.baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ toUserId: daveStubA, note: 'hi dave' });
    const daveFriendInv = await vi.waitFor(
      async () => {
        const inv = await appB.database.query.invite.findFirst({
          where: and(
            eq(invite.kind, 'FRIEND'),
            eq(invite.status, 'PENDING'),
            eq(invite.toUserId, daveLocalIdB),
          ),
        });
        expect(inv).toBeDefined();
        return inv!;
      },
      { timeout: 5000 },
    );
    await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenDave}`)
      .send({ inviteId: daveFriendInv.id.toString() });
    // The group-invite friend gate keys on an active P2P thread alice↔dave on appB — wait for it.
    await vi.waitFor(
      async () => {
        expect(
          await findActiveP2pParticipant(appB, daveLocalIdB),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );

    // Invite dave to the SAME group bob is in; appB adds dave to the EXISTING mirror thread.
    await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: firstGroupThreadA, userIds: [daveStubA] });
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.invite.findFirst({
            where: and(
              eq(invite.kind, 'GROUP'),
              eq(invite.status, 'PENDING'),
              eq(invite.toUserId, daveLocalIdB),
              eq(invite.threadId, firstMirrorBId),
            ),
          }),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );
    const daveAccept = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenDave}`)
      .send({ inviteId: firstGroupAccount });
    expect([
      BusinessCode.OK,
      BusinessCode.FEDERATION_DELIVERY_FAILED,
    ]).toContain(daveAccept.body.code);

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

    // Open BOTH SSE streams; alice sends; assert BOTH bob AND dave receive it (the multi-local-member fan).
    const readerBob = await openSse(appB.baseUrl, tokenB);
    const readerDave = await openSse(appB.baseUrl, tokenDave);
    try {
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
        { timeout: 8000 },
      );
      await waitForSseEvent(
        readerBob,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === firstMirrorBId &&
          (data as { seq?: number }).seq === hiBoth.seq,
      );
      await waitForSseEvent(
        readerDave,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === firstMirrorBId &&
          (data as { seq?: number }).seq === hiBoth.seq,
      );
    } finally {
      await readerBob.cancel();
      await readerDave.cancel();
    }
  }, 60_000);

  it('Step 3: a mirror member leaving propagates to the origin roster (pull-reject dissolution, no demote)', async () => {
    // Precondition: bob's stub is ACTIVE on the origin's canonical roster for the first group.
    const bobOnABefore = await appA.database.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.userId, bobStubIdOnA),
        eq(threadParticipant.threadId, firstGroupThreadA),
      ),
      columns: { leftAt: true },
    });
    expect(bobOnABefore?.leftAt).toBeNull();

    // bob @ appB leaves the group. appB soft-leaves him on the mirror + notifyGroupLeave pushes a per-author
    // hint to the origin. The origin pulls bob's author-messages from appB; appB's per-author gate sees bob
    // is no longer active → answers HTTP 410 GONE (FEDERATION_GROUP_AUTHOR_LEFT) → the origin soft-leaves
    // bob's stub on its canonical roster + bumps the group meta. 410 is a resource response, NOT a peer
    // failure → appA must NOT demote bbb. (bob authored no messages in this group → pushed latestSeq = 0,
    // origin cursor = -1 → 0 > -1 → the probe fires.)
    const leave = await request(appB.baseUrl)
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: firstMirrorBId });
    expect(leave.status).toBe(200);
    expect(leave.body.code).toBe(BusinessCode.OK);

    // appB soft-left bob on the mirror thread (the local side of the leave — synchronous).
    const bobLocalB = await appB.database.query.user.findFirst({
      where: and(eq(user.account, 'bob'), eq(user.domain, 'local')),
      columns: { id: true },
    });
    expect(bobLocalB).toBeDefined();
    await vi.waitFor(
      async () => {
        const bobOnB = await appB.database.query.threadParticipant.findFirst({
          where: and(
            eq(threadParticipant.userId, bobLocalB!.id),
            eq(threadParticipant.threadId, firstMirrorBId),
          ),
          columns: { leftAt: true },
        });
        expect(bobOnB?.leftAt).not.toBeNull();
      },
      { timeout: 5000 },
    );

    // The origin dissolved bob's stub from its canonical roster (pull-reject → soft-leave). This is the
    // end-to-end proof: a leave on the mirror reached the origin over the message-pull channel.
    await vi.waitFor(
      async () => {
        const bobOnAAfter =
          await appA.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, bobStubIdOnA),
              eq(threadParticipant.threadId, firstGroupThreadA),
            ),
            columns: { leftAt: true },
          });
        expect(bobOnAAfter?.leftAt).not.toBeNull();
      },
      { timeout: 8000 },
    );

    // Regression guard for the core hazard: the 410 GONE (FEDERATION_GROUP_AUTHOR_LEFT) outcome must NOT
    // demote the peer. (Before this change, a left author yielded HTTP 403 → getSigned demoted → the trust
    // broke.)
    const peer = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
      columns: { trustLevel: true },
    });
    expect(peer?.trustLevel).toBe('trusted');
  }, 60_000);

  it('Step 3: sinceSeq seeds pullUntil — a new member starts from invite-time, not full history', async () => {
    // alice creates a group, sends a message (pre-invite history), THEN invites bob. The invite carries
    // sinceSeq = the origin curSeq at invite time (= 0, after the pre-invite seq-0 message), so bob's
    // mirror seeds pullUntil = 0 → bob never pulls seq 0 (the pre-invite message). A later (seq 1)
    // message IS delivered. (Now exercisable: appB has its own mirror on a separate DB.)
    const create = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'fed-group-seq', inviteUserIds: [] }); // bob invited separately below
    expect(create.body.code).toBe(BusinessCode.OK);
    const groupThreadA = create.body.data.threadId as number;

    // Pre-invite message → origin seq 0, curSeq becomes 0 BEFORE the invite ⇒ sinceSeq = 0.
    const pre = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: groupThreadA,
        content: 'before-bob-joined',
        contentType: 'PURE_TEXT',
      });
    expect(pre.body.code).toBe(BusinessCode.OK);

    // Invite bob — the invite carries sinceSeq = origin curSeq = 0.
    const invite = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: groupThreadA, userIds: [bobStubIdOnA] });
    expect(invite.body.code).toBe(BusinessCode.OK);

    const groupAccount = (await findGroupThreadById(appA, groupThreadA))!
      .groupUser.account;

    // bob's mirror is created with pullUntil seeded to sinceSeq = 0 (past the pre-invite seq 0).
    const mirrorB = await vi.waitFor(
      async () => {
        const m = await findGroupThreadByAccount(appB, groupAccount);
        expect(m).toBeDefined();
        expect(m!.pullUntil).toBe(0); // seeded past the pre-invite message
        return m!;
      },
      { timeout: 5000 },
    );

    // bob accepts (the origin records him on the canonical roster).
    const accept = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ inviteId: groupAccount });
    expect([
      BusinessCode.OK,
      BusinessCode.FEDERATION_DELIVERY_FAILED,
    ]).toContain(accept.body.code);

    // A post-invite message (origin seq 1) → appB pulls seq > 0 → gets this, NOT seq 0.
    const post = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: groupThreadA,
        content: 'after-invite',
        contentType: 'PURE_TEXT',
      });
    expect(post.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        const got = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirrorB.id),
            eq(message.content, textContent('after-invite')),
          ),
        });
        expect(got).toBeDefined();
      },
      { timeout: 8000 },
    );

    // The pre-invite message (seq 0) was NEVER pulled — pullUntil was seeded past it.
    const leaked = await appB.database.query.message.findFirst({
      where: and(
        eq(message.threadId, mirrorB.id),
        eq(message.content, textContent('before-bob-joined')),
      ),
    });
    expect(leaked).toBeUndefined();
  }, 60_000);

  it('unfriend is local-only (no S2S fan-out; peer learns lazily)', async () => {
    const res = await request(appA.baseUrl)
      .post('/api/v1/user/delete-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ userId: bobStubIdOnA });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appA tore it down — the P2P thread is soft-left (no active thread between alice and bob's stub).
    const threadA = await findActiveP2pParticipant(appA, bobStubIdOnA);
    expect(threadA).toBeUndefined();

    // appB is UNCHANGED — no S2S notification was sent. The active P2P thread still stands; appB only
    // learns lazily about the severance (Step 2 send-reject, resolveFriendshipThread → 403).
    const threadB = await findActiveP2pParticipant(appB, aliceStubIdOnB);
    expect(threadB).toBeDefined();
  });

  it('rejects an inbound invite signed by an untrusted domain', async () => {
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
      id: '01TEST00000000000000000000',
      origin: `${DOM_A}-evil`,
      kind: 'FRIEND',
      from: { account: 'mallory', domain: `${DOM_A}-evil` },
      to: { account: 'x', domain: `${DOM_A}-evil` },
      ts: 0,
    });
    const headers = evilSig.signOutbound({
      method: 'POST',
      path: '/api/v1/s2s/invite',
      authority,
      body,
    });

    const res = await fetch(`http://${authority}/api/v1/s2s/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe(BusinessCode.FEDERATION_PEER_NOT_TRUSTED);
  });

  // ─── trust lifecycle: demote on failure → re-handshake → block ───────────────────────────────
  // These run after the friend-flow tests; aaa↔bbb are still mutually trusted (unfriending above is
  // local-only and does not demote). They drive the state machine through real signed S2S traffic:
  // a dead loopback URL forces a network failure → markDemoted; restoring it → ensurePeerTrusted
  // re-handshakes → markTrusted; markBlocked → resolve surfaces FEDERATION_PEER_BLOCKED.

  it('demotes a trusted peer when a signed op fails (network), logs the event + purges keys', async () => {
    // Precondition: aaa still trusts bbb, and bbb's signing keys are cached on aaa (fetched at init).
    const peerBefore = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(peerBefore?.trustLevel).toBe('trusted');
    const keysBefore = await appA.database.query.s2SKeyCache.findMany({
      where: eq(s2SKeyCache.domain, DOM_B),
    });
    expect(keysBefore.length).toBeGreaterThan(0);

    // STOP appB → appA's resolve → fetchRemoteUser signed GET to bbb.local refuses connection (a real
    // ECONNREFUSED from a dead process, not a faked dead loopback URL) → markDemoted(DOM_B).
    await appB.stop();
    const res = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.FEDERATION_DELIVERY_FAILED);

    // aaa demoted bbb: state flipped, count bumped, demoted event logged, keys purged.
    const peerAfter = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(peerAfter?.trustLevel).toBe('demoted');
    expect(peerAfter?.demotionCount).toBe(1);
    expect(peerAfter?.demotedAt).not.toBeNull();
    expect(peerAfter?.demoteReason).toContain('network/timeout');

    const demotedEvent = await appA.database.query.federatedPeerEvent.findFirst(
      {
        where: and(
          eq(federatedPeerEvent.domain, DOM_B),
          eq(federatedPeerEvent.type, 'demoted'),
        ),
      },
    );
    expect(demotedEvent).toBeDefined();
    expect(demotedEvent!.reason).toContain('network/timeout');

    const keysAfter = await appA.database.query.s2SKeyCache.findMany({
      where: eq(s2SKeyCache.domain, DOM_B),
    });
    expect(keysAfter.length).toBe(0);

    // Restart appB (same port, same DB) for the re-handshake test below.
    await appB.restart();
  });

  it('re-handshakes a demoted peer back to trusted on the next resolve (self-healing)', async () => {
    // alice@appA resolves bob@bbb.local once more → ensurePeerTrusted sees `demoted` → re-runs the init
    // handshake → markTrusted flips back to trusted + logs a `trusted` event AFTER the demoted one.
    const res = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    const peer = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, DOM_B),
    });
    expect(peer?.trustLevel).toBe('trusted');
    expect(peer?.demotedAt).toBeNull();
    expect(peer?.demoteReason).toBeNull();

    // peerEvents (via the real admin route) is newest-first, so the most recent transition is types[0] —
    // after a re-handshake that must be `trusted` (trust re-established), the timeline still has the demote.
    const eventsRes = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${DOM_B}/events`)
      .set('Cookie', adminCookieA)
      .send({ take: 50 });
    const types = (eventsRes.body.data as { type: string }[]).map(
      (e) => e.type,
    );
    expect(types[0]).toBe('trusted');
    expect(types).toContain('demoted');
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
    expect(blocked?.trustLevel).toBe('blocked');

    const res = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.FEDERATION_PEER_BLOCKED);

    // Admin reads (the admin page's data sources, via their real routes): the list filters by state; the
    // timeline (newest-first) carries the full discovered → trusted → demoted → trusted → blocked process.
    const listRes = await request(appA.baseUrl)
      .post('/api/v1/admin/federation/peers')
      .set('Cookie', adminCookieA)
      .send({ skip: 0, take: 10, status: 'blocked' });
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
    expect(types).toContain('demoted');
    expect(types[0]).toBe('blocked');
  });
});
