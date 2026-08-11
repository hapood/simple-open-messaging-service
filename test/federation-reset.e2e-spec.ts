import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  bootFederationPair,
  FED_DOMAIN_B,
  truncateFederationDbs,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import { getAdminCookie, registerAndLogin } from './federation-test-helpers.js';
import { BusinessCode } from '../src/common/business-code.js';
import { MessageThreadType } from '../src/database/enums.js';
import {
  federatedPeer,
  federatedPeerReset,
  message,
  messageThread,
  threadParticipant,
  threadRevision,
} from '../src/database/schema.js';

describe('Federation destructive reset', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let aliceId: number;
  let oldBobStubId: number;
  let adminCookieA: string;
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
    await registerAndLogin(appB, 'reset-bob', 'Reset Bob');
    adminCookieA = await getAdminCookie(appA, 'reset-admin');

    const resolved = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'reset-bob', domain: FED_DOMAIN_B });
    expect(resolved.status).toBe(200);
    expect(resolved.body.code).toBe(BusinessCode.OK);
    oldBobStubId = resolved.body.data.id;

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
      await tx.insert(threadRevision).values({
        userId: aliceId,
        threadId: thread.id,
        direction: 'ADD',
        revision: 0,
      });
      await tx.insert(message).values({
        seq: 0,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'removed by federation reset' }),
        threadId: thread.id,
        creator: oldBobStubId,
        updatedAt: new Date(),
        originSeq: 0,
      });
    });

    await appB.restart();
    await appA.database
      .update(federatedPeer)
      .set({
        trustLevel: 'identity_lost',
        identityLostAt: new Date(),
        identityLostReason: 'e2e simulated identity mismatch',
      })
      .where(eq(federatedPeer.domain, FED_DOMAIN_B));
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
    expect(preview.body.data.affectedThreadCount).toBe(1);

    const started = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/peers/${FED_DOMAIN_B}/reset`)
      .set('Cookie', adminCookieA)
      .send({ confirmDomain: FED_DOMAIN_B });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({
      domain: FED_DOMAIN_B,
      status: 'reset_in_progress',
      affectedThreadCount: 1,
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
      { timeout: 20_000, interval: 100 },
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
        deleteRevisions: number;
        liveAddRevisions: number;
        peerAudiences: number;
        serveCursors: number;
      }>(
        sql`
      SELECT
        (SELECT count(*)::int FROM "User"
          WHERE domain = ${FED_DOMAIN_B} AND "isForeigner" = true) AS users,
        (SELECT count(*)::int FROM "ThreadParticipant"
          WHERE "threadId" = ${affectedThreadId}) AS participants,
        (SELECT count(*)::int FROM "Message"
          WHERE "threadId" = ${affectedThreadId}) AS messages,
        (SELECT count(*)::int FROM "ThreadRevision"
          WHERE "threadId" = ${affectedThreadId}
            AND direction = 'DELETE') AS "deleteRevisions",
        (SELECT count(*)::int FROM "ThreadRevision"
          WHERE "threadId" = ${affectedThreadId}
            AND direction = 'ADD' AND "isDelete" = false) AS "liveAddRevisions",
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
      deleteRevisions: 1,
      liveAddRevisions: 0,
      peerAudiences: 0,
      serveCursors: 0,
    });

    const rejoin = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'reset-bob', domain: FED_DOMAIN_B });
    expect(rejoin.status).toBe(200);
    expect(rejoin.body.code).toBe(BusinessCode.OK);
    expect(rejoin.body.data.id).not.toBe(oldBobStubId);

    const [rejoinedPeer, consumedReset] = await Promise.all([
      appA.database.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, FED_DOMAIN_B),
      }),
      appA.database.query.federatedPeerReset.findFirst({
        where: eq(federatedPeerReset.domain, FED_DOMAIN_B),
      }),
    ]);
    expect(rejoinedPeer?.trustLevel).toBe('trusted');
    expect(consumedReset?.reinitPending).toBe(false);

    const inheritedParticipants = await appA.database
      .select({ threadId: threadParticipant.threadId })
      .from(threadParticipant)
      .where(
        and(
          eq(threadParticipant.userId, rejoin.body.data.id),
          inArray(threadParticipant.threadId, [affectedThreadId]),
        ),
      );
    expect(inheritedParticipants).toHaveLength(0);
  });
});
