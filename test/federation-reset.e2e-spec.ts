import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  truncateFederationDbs,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  establishFederatedFriendship,
  getAdminCookie,
  registerAndLogin,
} from './federation-test-helpers.js';
import { BusinessCode } from '../src/common/business-code.js';
import { MessageThreadType } from '../src/database/enums.js';
import {
  federatedPeer,
  federatedPeerReset,
  message,
  messageThread,
  threadParticipant,
} from '../src/database/schema.js';

describe('Federation destructive reset', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let tokenB: string;
  let aliceId: number;
  let bobId: number;
  let oldBobStubId: number;
  let adminCookieA: string;
  let adminCookieB: string;
  let affectedThreadId: number;
  let affectedThreadVersion: number;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    await truncateFederationDbs(appA, appB);

    ({ id: aliceId, token: tokenA } = await registerAndLogin(
      appA,
      'reset-alice',
      'Reset Alice',
    ));
    const bob = await registerAndLogin(appB, 'reset-bob', 'Reset Bob');
    bobId = bob.id;
    tokenB = bob.token;
    adminCookieA = await getAdminCookie(appA, 'reset-admin');
    adminCookieB = await getAdminCookie(appB, 'reset-admin');
    const friendship = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: aliceId,
      remoteUserId: bob.id,
      localToken: tokenA,
      remoteToken: bob.token,
      localAccount: 'reset-alice',
      remoteAccount: 'reset-bob',
      localDomain: FED_DOMAIN_A,
      remoteDomain: FED_DOMAIN_B,
    });
    oldBobStubId = friendship.remoteStubIdOnLocal;

    await appA.database.transaction(async (tx) => {
      const [thread] = await tx
        .insert(messageThread)
        .values({ type: MessageThreadType.P2P, updatedAt: new Date() })
        .returning({
          id: messageThread.id,
          federationVersion: messageThread.federationVersion,
        });
      affectedThreadId = thread.id;
      affectedThreadVersion = thread.federationVersion;
      await tx.insert(threadParticipant).values([
        {
          userId: aliceId,
          threadId: thread.id,
          updatedAt: new Date(),
        },
        {
          userId: oldBobStubId,
          threadId: thread.id,
          updatedAt: new Date(),
        },
      ]);
      await tx.insert(message).values({
        seq: 1,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'removed by federation reset' }),
        threadId: thread.id,
        creator: oldBobStubId,
        updatedAt: new Date(),
        originSeq: 1,
      });
    });

    await appB.restart();
    await appA.database
      .update(federatedPeer)
      .set({
        trustLevel: 'halted',
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: 'e2e simulated identity mismatch',
      })
      .where(eq(federatedPeer.domain, FED_DOMAIN_B));
    // Fatal recognition is a bilateral administrative boundary. Make the
    // remote half explicit instead of racing the asynchronous reverse
    // Recognize callback that would normally halt it.
    await appB.database
      .update(federatedPeer)
      .set({
        trustLevel: 'halted',
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: 'e2e simulated reciprocal identity mismatch',
      })
      .where(eq(federatedPeer.domain, FED_DOMAIN_A));
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('cleans old authorization and permits a fresh identity without inheritance', async () => {
    const preview = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${FED_DOMAIN_B}/reset-preview`)
      .set('Cookie', adminCookieA)
      .send();
    expect(preview.status).toBe(200);
    expect(preview.body.data.affectedThreadCount).toBe(2);

    const started = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${FED_DOMAIN_B}/reset`)
      .set('Cookie', adminCookieA)
      .send({ confirmDomain: FED_DOMAIN_B });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({
      domain: FED_DOMAIN_B,
      status: 'reset_in_progress',
      affectedThreadCount: 2,
    });

    await vi.waitFor(
      async () => {
        const [peer, tombstone] = await Promise.all([
          appA.database.query.federatedPeer.findFirst({
            where: eq(federatedPeer.domain, FED_DOMAIN_B),
          }),
          appA.database.query.federatedPeerReset.findFirst({
            where: eq(federatedPeerReset.domain, FED_DOMAIN_B),
          }),
        ]);
        expect(peer).toBeUndefined();
        expect(tombstone?.reinitPending).toBe(true);
      },
      { timeout: 5000, interval: 100 },
    );

    // A fatal identity incident is bilateral: B has also halted A after the
    // reverse Recognize received A's conflict response. A local reset cannot
    // silently clear B's administrative boundary, so explicitly reset B too
    // before attempting a fresh relationship.
    const remoteStarted = await request(appB.baseUrl)
      .post(`/api/v1/admin/federation/peers/${FED_DOMAIN_A}/reset`)
      .set('Cookie', adminCookieB)
      .send({ confirmDomain: FED_DOMAIN_A });
    expect(remoteStarted.status).toBe(200);
    await vi.waitFor(
      async () => {
        const peer = await appB.database.query.federatedPeer.findFirst({
          where: eq(federatedPeer.domain, FED_DOMAIN_A),
        });
        expect(peer).toBeUndefined();
      },
      { timeout: 5000, interval: 100 },
    );

    const shell = await appA.database.query.messageThread.findFirst({
      where: eq(messageThread.id, affectedThreadId),
    });
    expect(shell).toMatchObject({
      federationTruncated: true,
      federationVersion: affectedThreadVersion + 1,
      groupUserId: null,
    });

    const [remaining] = await appA.database
      .execute<{
        users: number;
        participants: number;
        messages: number;
        peerAudiences: number;
        serveCursors: number;
      }>(
        sql`
      SELECT
        (SELECT count(*)::int FROM "User"
          WHERE domain = ${FED_DOMAIN_B} AND domain <> 'local') AS users,
        (SELECT count(*)::int FROM "ThreadParticipant"
          WHERE "threadId" = ${affectedThreadId}) AS participants,
        (SELECT count(*)::int FROM "Message"
          WHERE "threadId" = ${affectedThreadId}) AS messages,
        (SELECT count(*)::int FROM "ThreadAudience"
          WHERE "targetDomain" = ${FED_DOMAIN_B}) AS "peerAudiences",
        (SELECT count(*)::int FROM "FederationServeCursor"
          WHERE "peerDomain" = ${FED_DOMAIN_B}) AS "serveCursors"
    `,
      )
      .then((result) => result.rows);
    expect(remaining).toMatchObject({
      users: 0,
      participants: 0,
      messages: 0,
      peerAudiences: 0,
      serveCursors: 0,
    });

    const rejoin = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: aliceId,
      remoteUserId: bobId,
      localToken: tokenA,
      remoteToken: tokenB,
      localAccount: 'reset-alice',
      remoteAccount: 'reset-bob',
      localDomain: FED_DOMAIN_A,
      remoteDomain: FED_DOMAIN_B,
      note: 'post-reset request',
    });
    expect(rejoin.remoteStubIdOnLocal).not.toBe(oldBobStubId);

    const [rejoinedPeer, consumedReset] = await Promise.all([
      appA.database.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, FED_DOMAIN_B),
      }),
      appA.database.query.federatedPeerReset.findFirst({
        where: eq(federatedPeerReset.domain, FED_DOMAIN_B),
      }),
    ]);
    expect(rejoinedPeer?.trustLevel).toBe('available');
    expect(consumedReset?.reinitPending).toBe(false);

    const inheritedParticipants = await appA.database
      .select({ threadId: threadParticipant.threadId })
      .from(threadParticipant)
      .where(
        and(
          eq(threadParticipant.userId, rejoin.remoteStubIdOnLocal),
          inArray(threadParticipant.threadId, [affectedThreadId]),
        ),
      );
    expect(inheritedParticipants).toHaveLength(0);
  }, 120_000);
});
