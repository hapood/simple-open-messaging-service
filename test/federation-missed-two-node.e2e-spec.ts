import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import {
  fileSyncProgress,
  federatedPeer,
  federationThreadSyncState,
  mediaAsset,
  message,
  messageAsset,
  pendingMedia,
  quotaDailyUsage,
  relationshipPair,
  threadMember,
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
  establishFederatedFriendship,
  getAdminCookie,
  registerAndLogin,
  uploadAvatar,
} from './federation-test-helpers.js';

describe('federation durable missed transport (two nodes)', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let tokenB: string;
  let aliceIdA: number;
  let bobIdB: number;
  let bobStubIdA: number;
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

    const friendship = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: aliceIdA,
      remoteUserId: bobIdB,
      localToken: tokenA,
      remoteToken: tokenB,
      localAccount: 'missedalice',
      remoteAccount: 'missedbob',
      localDomain: FED_DOMAIN_A,
      remoteDomain: FED_DOMAIN_B,
      note: 'durable missed e2e',
    });
    bobStubIdA = friendship.remoteStubIdOnLocal;
    aliceStubIdB = friendship.localStubIdOnRemote;
    await vi.waitFor(
      async () => {
        const active = await appB.database.query.threadMember.findFirst({
          where: and(eq(threadMember.userId, aliceStubIdB)),
        });
        expect(active).toBeDefined();
        const activeOnA = await appA.database.query.threadMember.findFirst({
          where: and(eq(threadMember.userId, bobStubIdA)),
        });
        expect(activeOnA).toBeDefined();
      },
      { timeout: 5000, interval: 100 },
    );
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  afterEach(() => {
    proxy?.blockGetFile(false);
    proxy?.blockStateFeed(false);
  });

  it('delivers through the state-feed and forward thread-round pipeline', async () => {
    const bobThread = await appB.database.query.threadMember.findFirst({
      where: and(eq(threadMember.userId, aliceStubIdB)),
    });
    expect(bobThread).toBeDefined();

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

    await vi.waitFor(
      async () => {
        const received = await appA.database.query.message.findFirst({
          where: eq(
            message.content,
            JSON.stringify({ text: 'durable missed only' }),
          ),
        });
        expect(received).toBeDefined();
        expect(received!.localState).toBe('READY');

        const syncState =
          await appA.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, received!.threadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_B),
            ),
          });
        expect(syncState?.messageTargetSeq).toBe(received!.originSeq);
        expect(syncState?.messageProcessedThroughSeq).toBe(
          syncState?.messageTargetSeq,
        );
      },
      { timeout: 5000 },
    );

    expect(aliceIdA).toBeGreaterThan(0);
  });

  it('recovers a persisted inbound media download after the receiver process restarts', async () => {
    const bobStub = await appA.database.query.user.findFirst({
      where: and(eq(user.account, 'missedbob'), eq(user.domain, FED_DOMAIN_B)),
    });
    expect(bobStub).toBeDefined();
    const aliceThread = await appA.database.query.threadMember.findFirst({
      where: and(eq(threadMember.userId, bobStub!.id)),
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

    // Remove appA's shard and let the proxy fixture model its remote CAS response.
    proxy.setGetFileFixture(digest, bytes);
    await unlink(
      join(appA.dataDir, 'cas', digest.slice(0, 2), digest.slice(2, 4), digest),
    );
    proxy.blockGetFile(true);
    // Deliberately taking B offline makes A's circuit breaker mark it degraded. Restore transport health in
    // the fixture before B starts, so B's startup HWM reconciliation is accepted by A. The test target
    // is crash recovery, not breaker backoff.
    await appA.database
      .update(federatedPeer)
      .set({
        trustLevel: 'available',
        degradedAt: null,
        degradationReason: null,
      })
      .where(eq(federatedPeer.domain, FED_DOMAIN_B));
    proxy.clearRequestLog();
    await appB.start();
    await vi.waitFor(
      () => {
        const signedGets = proxy
          .requestLog()
          .filter(
            (entry) =>
              entry.method === 'GET' &&
              entry.path.startsWith('/s2s/v1/') &&
              !entry.path.startsWith('/s2s/v1/health'),
          );
        expect(signedGets[0]).toMatchObject({
          path: expect.stringMatching(/^\/s2s\/v1\/state-feed\?/),
          status: 200,
        });
        const dataGets = signedGets;
        expect(
          dataGets[0]?.status,
          `first signed data GET: ${JSON.stringify(dataGets[0])}`,
        ).toBe(200);
        expect(
          dataGets.some(
            (entry) =>
              entry.path.startsWith('/s2s/v1/messages?') &&
              entry.status === 200,
          ),
        ).toBe(true);
        expect(signedGets.some((entry) => entry.status === 401)).toBe(false);
      },
      { timeout: 5000, interval: 100 },
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
        const stagedMessage = await appB.database.query.message.findFirst({
          where: eq(message.id, pending!.messageId!),
        });
        expect(stagedMessage?.localState).toBe('STUB');
        const syncState =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, stagedMessage!.threadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(syncState?.messageProcessedThroughSeq).toBeGreaterThanOrEqual(
          stagedMessage!.originSeq!,
        );
        const progress = await appB.database.query.fileSyncProgress.findFirst({
          where: eq(fileSyncProgress.batchId, batchId),
        });
        expect(progress?.status).toBe('DOWNLOADING');
        expect(proxy.blockedGetFileCount()).toBeGreaterThan(0);
      },
      { timeout: 5000 },
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
      { timeout: 5000 },
    );

    try {
      proxy.blockGetFile(false);
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
              eq(message.creatorAccount, 'missedalice'),
              eq(message.creatorDomain, FED_DOMAIN_A),
              eq(message.contentType, 'IMAGE'),
            ),
            orderBy: (row, { desc }) => [desc(row.id)],
          });
          expect(received).toBeDefined();
          expect(received!.localState).toBe('READY');
          expect(
            await appB.database.query.pendingMedia.findFirst({
              where: eq(pendingMedia.batchId, batchId),
            }),
          ).toBeUndefined();
        },
        { timeout: 5000 },
      );
    } finally {
      proxy.blockGetFile(false);
      proxy.setGetFileFixture(digest, null);
    }
  }, 60_000);

  it('automatically resumes a quota-paused media download after an admin grants a one-time allowance', async () => {
    const bobStub = await appA.database.query.user.findFirst({
      where: and(eq(user.account, 'missedbob'), eq(user.domain, FED_DOMAIN_B)),
    });
    expect(bobStub).toBeDefined();
    const aliceThread = await appA.database.query.threadMember.findFirst({
      where: and(eq(threadMember.userId, bobStub!.id)),
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
      join(appA.dataDir, 'cas', digest.slice(0, 2), digest.slice(2, 4), digest),
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
        const stagedMessage = await appB.database.query.message.findFirst({
          where: eq(message.id, pending!.messageId!),
        });
        expect(stagedMessage?.localState).toBe('STUB');
        const syncState =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, stagedMessage!.threadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(syncState?.messageProcessedThroughSeq).toBeGreaterThanOrEqual(
          stagedMessage!.originSeq!,
        );
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
      { timeout: 5000 },
    );

    const continued = await request(appB.baseUrl)
      .post(`/api/v1/admin/quota/nodes/${FED_DOMAIN_A}/continue`)
      .set('Cookie', adminCookie)
      .send({ addFile: 1 });
    expect(continued.body.code).toBe(BusinessCode.OK);
    expect(continued.body.data.tripped).toBe(false);

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
            eq(message.creatorAccount, 'missedalice'),
            eq(message.creatorDomain, FED_DOMAIN_A),
            eq(message.contentType, 'IMAGE'),
          ),
          orderBy: (row, { desc }) => [desc(row.id)],
        });
        expect(received).toBeDefined();
        expect(received!.localState).toBe('READY');
        expect(
          await appB.database.query.pendingMedia.findFirst({
            where: eq(pendingMedia.batchId, batchId),
          }),
        ).toBeUndefined();
      },
      { timeout: 5000 },
    );
    proxy.setGetFileFixture(digest, null);
  }, 60_000);

  it('converges a delayed-state unfriend and immediate re-add through current facts', async () => {
    const [memberOnA, memberOnB] = await Promise.all([
      appA.database.query.threadMember.findFirst({
        where: eq(threadMember.userId, bobStubIdA),
      }),
      appB.database.query.threadMember.findFirst({
        where: eq(threadMember.userId, aliceStubIdB),
      }),
    ]);
    expect(memberOnA).toBeDefined();
    expect(memberOnB).toBeDefined();

    const before = await vi.waitFor(
      async () => {
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, memberOnB!.threadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state).toBeDefined();
        expect(state!.messageProcessedThroughSeq).toBe(state!.messageTargetSeq);
        return state!;
      },
      { timeout: 10_000, interval: 100 },
    );

    proxy.blockStateFeed(true);
    const hiddenText = 'p2p-hidden-across-unfriend';
    const hidden = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: memberOnA!.threadId,
        content: hiddenText,
        contentType: 'PURE_TEXT',
        clientMessageId: randomUUID(),
      });
    expect(hidden.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      () => expect(proxy.blockedStateFeedCount()).toBeGreaterThan(0),
      { timeout: 10_000, interval: 100 },
    );

    const removed = await request(appA.baseUrl)
      .post('/api/v1/user/delete-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'missedbob', domain: FED_DOMAIN_B });
    expect(removed.body.code).toBe(BusinessCode.OK);
    const restored = await request(appA.baseUrl)
      .post('/api/v1/invite/federated-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        account: 'missedbob',
        domain: FED_DOMAIN_B,
        displayName: 'Missed Bob',
        note: 'restore after compacted revoke',
      });
    expect(restored.body.code).toBe(BusinessCode.OK);
    proxy.blockStateFeed(false);

    await vi.waitFor(
      async () => {
        const [pair, state] = await Promise.all([
          appB.database.query.relationshipPair.findFirst({
            where: and(
              eq(relationshipPair.threadId, memberOnB!.threadId),
              eq(relationshipPair.active, true),
            ),
          }),
          appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, memberOnB!.threadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          }),
        ]);
        expect(pair).toBeDefined();
        // The blocked compacted feed exposes only the final active fact. Since
        // this consumer never observes an effective inactive transition, it
        // must not invent a local authorization epoch change.
        expect(state!.authorizationEpoch).toBe(before.authorizationEpoch);
        expect(state).toMatchObject({
          deletionRecoveryThroughSeq: null,
          deletionRecoveryMaxMessageSeq: null,
        });
      },
      { timeout: 30_000, interval: 100 },
    );
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, memberOnB!.threadId),
          eq(message.content, JSON.stringify({ text: hiddenText })),
        ),
      }),
    ).toBeUndefined();

    const liveText = 'p2p-after-re-add';
    const live = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: memberOnA!.threadId,
        content: liveText,
        contentType: 'PURE_TEXT',
        clientMessageId: randomUUID(),
      });
    expect(live.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, memberOnB!.threadId),
              eq(message.content, JSON.stringify({ text: liveText })),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 90_000);
});
