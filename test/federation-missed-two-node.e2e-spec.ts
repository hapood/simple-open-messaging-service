import type { NamespacedAddress } from '../src/common/client-identity.js';
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
  federationThreadSyncState,
  mediaAsset,
  message,
  messageAsset,
  pendingMedia,
  relationshipPair,
  identityNamespace,
} from '../src/database/schema.js';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  makePng,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  establishFederatedFriendship,
  getAdminCookie,
  registerAndLogin,
  uploadAvatar,
} from './federation-test-helpers.js';
import { findP2PRelationship } from './seed.js';

describe('federation durable missed transport (two nodes)', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let tokenB: string;
  let aliceIdA: number;
  let bobIdB: number;
  let bobAddressOnA: NamespacedAddress;
  let aliceAddressOnB: NamespacedAddress;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
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

    await establishFederatedFriendship({
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
    bobAddressOnA = {
      account: 'missedbob',
      domain: FED_DOMAIN_B,
      namespaceId: (await appA.database.query.identityNamespace.findFirst({
        where: eq(identityNamespace.domain, FED_DOMAIN_B),
      }))!.id,
    };
    aliceAddressOnB = {
      account: 'missedalice',
      domain: FED_DOMAIN_A,
      namespaceId: (await appB.database.query.identityNamespace.findFirst({
        where: eq(identityNamespace.domain, FED_DOMAIN_A),
      }))!.id,
    };
    await vi.waitFor(
      async () => {
        const [relationshipOnA, relationshipOnB] = await Promise.all([
          findP2PRelationship(appA.database, aliceIdA, bobAddressOnA),
          findP2PRelationship(appB.database, bobIdB, aliceAddressOnB),
        ]);
        expect(relationshipOnA.pair).toMatchObject({ active: true });
        expect(relationshipOnB.pair).toMatchObject({ active: true });
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
    const bobRelationship = await findP2PRelationship(
      appB.database,
      bobIdB,
      aliceAddressOnB,
    );
    expect(bobRelationship.pair).toMatchObject({ active: true });

    const sent = await request(appB.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: bobRelationship.pair!.threadId!,
        content: '{"text":"durable missed only"}',
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
    const aliceRelationship = await findP2PRelationship(
      appA.database,
      aliceIdA,
      bobAddressOnA,
    );
    expect(aliceRelationship.pair).toMatchObject({ active: true });

    const bytes = await makePng(147, 48);
    const clientMessageId = randomUUID();
    await appB.stop();
    const staged = await request(appA.baseUrl)
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: aliceRelationship.pair!.threadId!,
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
      .update(identityNamespace)
      .set({
        trustLevel: 'available',
        degradedAt: null,
        degradationReason: null,
      })
      .where(
        and(
          eq(identityNamespace.domain, FED_DOMAIN_B),
          eq(identityNamespace.active, true),
        ),
      );
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
        expect(stagedMessage?.content).toContain('/uploads/msg-assets/');
        expect(stagedMessage?.content).not.toContain('?threadId=');
        const syncState =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, stagedMessage!.threadId),
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
              eq(message.publisherNamespaceId, aliceAddressOnB.namespaceId),
              eq(message.profileNamespaceId, 0),
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
          ).toMatchObject({
            status: 'ready',
            anyFailed: false,
            failReason: null,
          });
        },
        { timeout: 5000 },
      );
    } finally {
      proxy.blockGetFile(false);
      proxy.setGetFileFixture(digest, null);
    }
  }, 60_000);

  it('automatically resumes a quota-paused media download after an admin grants a one-time allowance', async () => {
    const aliceRelationship = await findP2PRelationship(
      appA.database,
      aliceIdA,
      bobAddressOnA,
    );
    expect(aliceRelationship.pair).toMatchObject({ active: true });

    const peer = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, FED_DOMAIN_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(peer?.id).toBeTruthy();
    const adminCookie = await getAdminCookie(appB, 'quota-resume-admin');
    const quotaResponse = await request(appB.baseUrl)
      .post('/api/v1/admin/quota/nodes')
      .set('Cookie', adminCookie)
      .send({});
    expect(quotaResponse.body.code).toBe(BusinessCode.OK);
    const usedFiles = quotaResponse.body.data.find(
      (node: { namespaceId: number }) => node.namespaceId === peer!.id,
    ).usage.files.count;
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
        threadId: aliceRelationship.pair!.threadId!,
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
            eq(message.publisherNamespaceId, aliceAddressOnB.namespaceId),
            eq(message.profileNamespaceId, 0),
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
        ).toMatchObject({
          status: 'ready',
          anyFailed: false,
          failReason: null,
        });
      },
      { timeout: 5000 },
    );
    proxy.setGetFileFixture(digest, null);
  }, 60_000);

  it('converges a delayed-state unfriend and immediate re-add through current facts', async () => {
    const [relationshipOnA, relationshipOnB] = await Promise.all([
      findP2PRelationship(appA.database, aliceIdA, bobAddressOnA),
      findP2PRelationship(appB.database, bobIdB, aliceAddressOnB),
    ]);
    expect(relationshipOnA.pair).toMatchObject({ active: true });
    expect(relationshipOnB.pair).toMatchObject({ active: true });
    const threadOnA = relationshipOnA.pair!.threadId!;
    const threadOnB = relationshipOnB.pair!.threadId!;

    const before = await vi.waitFor(
      async () => {
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(eq(federationThreadSyncState.threadId, threadOnB)),
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
        threadId: threadOnA,
        content: JSON.stringify({ text: hiddenText }),
        contentType: 'PURE_TEXT',
        clientMessageId: randomUUID(),
      });
    expect(hidden.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      () => expect(proxy.blockedStateFeedCount()).toBeGreaterThan(0),
      { timeout: 10_000, interval: 100 },
    );

    const removed = await request(appA.baseUrl)
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ threadId: threadOnA });
    expect(removed.body.code).toBe(BusinessCode.OK);
    // The revocation commits synchronously now; its peer feed item parks in
    // the blocked outbound queue until the proxy unblocks.
    expect(removed.body.data).toEqual({ status: 'OK' });
    expect(
      (await findP2PRelationship(appA.database, aliceIdA, bobAddressOnA)).pair,
    ).toMatchObject({ active: false });
    const restored = await request(appA.baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        account: 'missedbob',
        namespaceId: bobAddressOnA.namespaceId,
        snapshot: { displayName: 'Missed Bob', avatar: null },
        note: 'restore after compacted revoke',
      });
    expect(restored.body.code).toBe(BusinessCode.OK);
    expect(restored.body.data).toMatchObject({ status: 'OK' });
    proxy.blockStateFeed(false);

    await vi.waitFor(
      async () => {
        const [pair, state] = await Promise.all([
          appB.database.query.relationshipPair.findFirst({
            where: and(
              eq(relationshipPair.threadId, threadOnB),
              eq(relationshipPair.active, true),
            ),
          }),
          appB.database.query.federationThreadSyncState.findFirst({
            where: and(eq(federationThreadSyncState.threadId, threadOnB)),
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
          eq(message.threadId, threadOnB),
          eq(message.content, JSON.stringify({ text: hiddenText })),
        ),
      }),
    ).toBeUndefined();

    const liveText = 'p2p-after-re-add';
    const live = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: threadOnA,
        content: JSON.stringify({ text: liveText }),
        contentType: 'PURE_TEXT',
        clientMessageId: randomUUID(),
      });
    expect(live.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, threadOnB),
              eq(message.content, JSON.stringify({ text: liveText })),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 90_000);
});
