import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq, isNull } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import {
  discoveryTarget,
  fileSyncProgress,
  federatedPeer,
  federationPullCursor,
  invite,
  mediaAsset,
  message,
  messageAsset,
  pendingMedia,
  quotaDailyUsage,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  makePng,
  truncateFederationDbs,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  getAdminCookie,
  openSse,
  registerAndLogin,
  uploadAvatar,
  waitForSseEvent,
} from './federation-test-helpers.js';

describe('federation durable missed transport (two nodes)', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let tokenB: string;
  let aliceIdA: number;
  let bobIdB: number;
  let aliceStubIdB: number;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    await truncateFederationDbs(appA, appB);
    ({ id: aliceIdA, token: tokenA } = await registerAndLogin(
      appA,
      'missedalice',
      'Missed Alice',
    ));
    ({ id: bobIdB, token: tokenB } = await registerAndLogin(
      appB,
      'missedbob',
      'Missed Bob',
    ));
    await uploadAvatar(appA, tokenA, await makePng(31));
    await uploadAvatar(appB, tokenB, await makePng(63));

    const resolved = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'missedbob', domain: FED_DOMAIN_B });
    expect(resolved.body.code).toBe(BusinessCode.OK);

    const requested = await request(appA.baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ toUserId: resolved.body.data.id, note: 'durable missed e2e' });
    expect(requested.body.code).toBe(BusinessCode.OK);

    const aliceStub = await appB.database.query.user.findFirst({
      where: and(
        eq(user.account, 'missedalice'),
        eq(user.domain, FED_DOMAIN_A),
      ),
    });
    expect(aliceStub).toBeDefined();
    aliceStubIdB = aliceStub!.id;
    const incoming = await appB.database.query.invite.findFirst({
      where: and(
        eq(invite.kind, 'FRIEND'),
        eq(invite.fromUserId, aliceStubIdB),
        eq(invite.toUserId, bobIdB),
        eq(invite.status, 'PENDING'),
      ),
    });
    expect(incoming).toBeDefined();
    const accepted = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ inviteId: incoming!.id.toString() });
    expect(accepted.body.code).toBe(BusinessCode.OK);
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('delivers through the HWM + /missed pipeline', async () => {
    const bobThread = await appB.database.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.userId, aliceStubIdB),
        isNull(threadParticipant.leftAt),
      ),
    });
    expect(bobThread).toBeDefined();

    const reader = await openSse(appA.baseUrl, tokenA);
    try {
      const sent = await request(appB.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          threadId: bobThread!.threadId,
          content: 'durable missed only',
          contentType: 'PURE_TEXT',
          clientMessageId: randomUUID(),
        });
      expect(sent.body.code).toBe(BusinessCode.OK);

      let localThreadId = 0;
      let localSeq = -1;
      await vi.waitFor(
        async () => {
          const received = await appA.database.query.message.findFirst({
            where: eq(
              message.content,
              JSON.stringify({ text: 'durable missed only' }),
            ),
          });
          expect(received).toBeDefined();
          localThreadId = received!.threadId;
          localSeq = received!.seq;

          const source = await appB.database.query.discoveryTarget.findFirst({
            where: and(
              eq(discoveryTarget.targetDomain, FED_DOMAIN_A),
              isNull(discoveryTarget.localUserId),
            ),
          });
          const pulled =
            await appA.database.query.federationPullCursor.findFirst({
              where: eq(federationPullCursor.peerDomain, FED_DOMAIN_B),
            });
          expect(source?.allocatedThrough).toBeGreaterThan(0n);
          expect(pulled?.remoteHwm).toBe(source?.allocatedThrough);
        },
        { timeout: 10_000 },
      );

      await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === localThreadId &&
          (data as { seq?: number }).seq === localSeq,
      );
      expect(aliceIdA).toBeGreaterThan(0);
    } finally {
      await reader.cancel();
    }
  });

  it('recovers a persisted inbound media download after the receiver process restarts', async () => {
    const bobStub = await appA.database.query.user.findFirst({
      where: and(eq(user.account, 'missedbob'), eq(user.domain, FED_DOMAIN_B)),
    });
    expect(bobStub).toBeDefined();
    const aliceThread = await appA.database.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.userId, bobStub!.id),
        isNull(threadParticipant.leftAt),
      ),
    });
    expect(aliceThread).toBeDefined();

    const bytes = await makePng(147, 48);
    const clientMessageId = randomUUID();
    await appB.stop();
    const staged = await request(appA.baseUrl)
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: aliceThread!.threadId,
        contentType: 'IMAGE',
        clientMessageId,
      });
    expect(staged.body.code).toBe(BusinessCode.OK);
    const uploaded = await request(appA.baseUrl)
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', bytes, 'restart-recovery.png')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'IMAGE');
    expect(uploaded.body.code).toBe(BusinessCode.OK);
    const url = (uploaded.body.data as { url: string }).url;
    const digest = url.split('/').pop()!;

    // The two subprocesses share the test workspace. Remove the shared shard and let the proxy model
    // appA's physically separate CAS; production nodes naturally have separate storage roots.
    proxy.setGetFileFixture(digest, bytes);
    await unlink(
      join(
        process.cwd(),
        'data',
        'cas',
        digest.slice(0, 2),
        digest.slice(2, 4),
        digest,
      ),
    );
    proxy.blockGetFile(true);
    // Deliberately taking B offline makes A's circuit breaker demote it. Restore transport health in
    // the fixture before B starts, so B's startup HWM reconciliation is accepted by A. The test target
    // is crash recovery, not breaker backoff.
    await appA.database
      .update(federatedPeer)
      .set({ trustLevel: 'trusted', demotedAt: null, demoteReason: null })
      .where(eq(federatedPeer.domain, FED_DOMAIN_B));
    await appB.start();

    let batchId = '';
    await vi.waitFor(
      async () => {
        const pending = await appB.database.query.pendingMedia.findFirst({
          where: and(
            eq(pendingMedia.direction, 'INBOUND'),
            eq(pendingMedia.originDomain, FED_DOMAIN_A),
          ),
          orderBy: (row, { desc }) => [desc(row.createdAt)],
        });
        expect(pending).toBeDefined();
        batchId = pending!.batchId;
        const progress = await appB.database.query.fileSyncProgress.findFirst({
          where: eq(fileSyncProgress.batchId, batchId),
        });
        expect(progress?.status).toBe('DOWNLOADING');
        expect(proxy.blockedGetFileCount()).toBeGreaterThan(0);
      },
      { timeout: 20_000 },
    );

    await appB.stop();
    expect(
      (
        await appB.database.query.fileSyncProgress.findFirst({
          where: eq(fileSyncProgress.batchId, batchId),
        })
      )?.status,
    ).toBe('DOWNLOADING');
    await appB.start();
    await vi.waitFor(
      () => expect(proxy.blockedGetFileCount()).toBeGreaterThan(0),
      { timeout: 10_000 },
    );

    const reader = await openSse(appB.baseUrl, tokenB);
    try {
      proxy.blockGetFile(false);
      let receivedThreadId = 0;
      let receivedSeq = -1;
      await vi.waitFor(
        async () => {
          const asset = await appB.database.query.mediaAsset.findFirst({
            where: and(
              eq(mediaAsset.digest, digest),
              eq(mediaAsset.isDeleted, false),
            ),
          });
          expect(asset).toBeDefined();
          const authorization =
            await appB.database.query.messageAsset.findFirst({
              where: eq(messageAsset.digest, digest),
            });
          expect(authorization).toBeDefined();
          const received = await appB.database.query.message.findFirst({
            where: and(
              eq(message.creator, aliceStubIdB),
              eq(message.contentType, 'IMAGE'),
            ),
            orderBy: (row, { desc }) => [desc(row.id)],
          });
          expect(received).toBeDefined();
          receivedThreadId = received!.threadId;
          receivedSeq = received!.seq;
          expect(
            await appB.database.query.pendingMedia.findFirst({
              where: eq(pendingMedia.batchId, batchId),
            }),
          ).toBeUndefined();
        },
        { timeout: 10_000 },
      );
      await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === receivedThreadId &&
          (data as { seq?: number }).seq === receivedSeq,
      );
    } finally {
      proxy.blockGetFile(false);
      proxy.setGetFileFixture(digest, null);
      await reader.cancel();
    }
  }, 60_000);

  it('automatically resumes a quota-paused media download after an admin grants a one-time allowance', async () => {
    const bobStub = await appA.database.query.user.findFirst({
      where: and(eq(user.account, 'missedbob'), eq(user.domain, FED_DOMAIN_B)),
    });
    expect(bobStub).toBeDefined();
    const aliceThread = await appA.database.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.userId, bobStub!.id),
        isNull(threadParticipant.leftAt),
      ),
    });
    expect(aliceThread).toBeDefined();

    const today = new Date();
    const quotaDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const usedFiles =
      (
        await appB.database.query.quotaDailyUsage.findFirst({
          where: and(
            eq(quotaDailyUsage.domain, FED_DOMAIN_A),
            eq(quotaDailyUsage.date, quotaDate),
            eq(quotaDailyUsage.category, 'files'),
          ),
        })
      )?.count ?? 0;
    const adminCookie = await getAdminCookie(appB, 'quota-resume-admin');
    const limited = await request(appB.baseUrl)
      .post(`/api/v1/admin/quota/nodes/${FED_DOMAIN_A}`)
      .set('Cookie', adminCookie)
      .send({ dailyFileLimit: usedFiles });
    expect(limited.body.code).toBe(BusinessCode.OK);

    const bytes = await makePng(211, 52);
    const clientMessageId = randomUUID();
    const staged = await request(appA.baseUrl)
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: aliceThread!.threadId,
        contentType: 'IMAGE',
        clientMessageId,
      });
    expect(staged.body.code).toBe(BusinessCode.OK);
    const uploaded = await request(appA.baseUrl)
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-client-message-id', clientMessageId)
      .attach('file', bytes, 'quota-resume.png')
      .field('partId', randomUUID())
      .field('position', '0')
      .field('intent', 'IMAGE');
    expect(uploaded.body.code).toBe(BusinessCode.OK);
    const digest = (uploaded.body.data as { url: string }).url
      .split('/')
      .pop()!;
    proxy.setGetFileFixture(digest, bytes);
    await unlink(
      join(
        process.cwd(),
        'data',
        'cas',
        digest.slice(0, 2),
        digest.slice(2, 4),
        digest,
      ),
    );

    let batchId = '';
    await vi.waitFor(
      async () => {
        const pending = await appB.database.query.pendingMedia.findFirst({
          where: and(
            eq(pendingMedia.direction, 'INBOUND'),
            eq(pendingMedia.originDomain, FED_DOMAIN_A),
          ),
          orderBy: (row, { desc }) => [desc(row.createdAt)],
        });
        expect(pending).toBeDefined();
        batchId = pending!.batchId;
        const progress = await appB.database.query.fileSyncProgress.findFirst({
          where: eq(fileSyncProgress.batchId, batchId),
        });
        expect(progress?.status).toBe('PENDING');
        expect(progress?.errorKind).toBe('QUOTA_PAUSED');
        expect(
          await appB.database.query.messageAsset.findFirst({
            where: eq(messageAsset.digest, digest),
          }),
        ).toBeUndefined();
      },
      { timeout: 15_000 },
    );

    const reader = await openSse(appB.baseUrl, tokenB);
    try {
      const continued = await request(appB.baseUrl)
        .post(`/api/v1/admin/quota/nodes/${FED_DOMAIN_A}/continue`)
        .set('Cookie', adminCookie)
        .send({ addFile: 1 });
      expect(continued.body.code).toBe(BusinessCode.OK);
      expect(continued.body.data.tripped).toBe(false);

      let receivedThreadId = 0;
      let receivedSeq = -1;
      await vi.waitFor(
        async () => {
          expect(
            await appB.database.query.mediaAsset.findFirst({
              where: and(
                eq(mediaAsset.digest, digest),
                eq(mediaAsset.isDeleted, false),
              ),
            }),
          ).toBeDefined();
          expect(
            await appB.database.query.messageAsset.findFirst({
              where: eq(messageAsset.digest, digest),
            }),
          ).toBeDefined();
          const received = await appB.database.query.message.findFirst({
            where: and(
              eq(message.creator, aliceStubIdB),
              eq(message.contentType, 'IMAGE'),
            ),
            orderBy: (row, { desc }) => [desc(row.id)],
          });
          expect(received).toBeDefined();
          receivedThreadId = received!.threadId;
          receivedSeq = received!.seq;
          expect(
            await appB.database.query.pendingMedia.findFirst({
              where: eq(pendingMedia.batchId, batchId),
            }),
          ).toBeUndefined();
        },
        { timeout: 15_000 },
      );
      await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === receivedThreadId &&
          (data as { seq?: number }).seq === receivedSeq,
      );
    } finally {
      proxy.setGetFileFixture(digest, null);
      await reader.cancel();
    }
  }, 60_000);
});
