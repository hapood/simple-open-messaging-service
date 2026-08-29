import { randomUUID } from 'node:crypto';
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
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { ContentType } from '../src/database/enums.js';
import {
  clientMessageFeed,
  federationThreadHistoryGap,
  federationThreadSyncState,
  group,
  message,
  messageThread,
  relationshipIntent,
  threadAudience,
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
  registerAndLogin,
  uploadAvatar,
} from './federation-test-helpers.js';
import { findGroupRelationship } from './seed.js';

describe('federation reverse thread rounds (two nodes)', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let tokenB: string;
  let bobLocalIdB: number;
  let bobStubIdA: number;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    await truncateFederationDbs(appA, appB);
    const alice = await registerAndLogin(appA, 'reversealice', 'Reverse Alice');
    const bob = await registerAndLogin(appB, 'reversebob', 'Reverse Bob');
    tokenA = alice.token;
    tokenB = bob.token;
    bobLocalIdB = bob.id;
    await uploadAvatar(appA, tokenA, await makePng(37));
    await uploadAvatar(appB, tokenB, await makePng(73));
    const friendship = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: alice.id,
      remoteUserId: bob.id,
      localToken: tokenA,
      remoteToken: tokenB,
      localAccount: 'reversealice',
      remoteAccount: 'reversebob',
      localDomain: FED_DOMAIN_A,
      remoteDomain: FED_DOMAIN_B,
    });
    bobStubIdA = friendship.remoteStubIdOnLocal;
  }, 120_000);

  afterEach(() => {
    proxy?.blockReverseMessages(false);
  });

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('resumes an active history gap after restart and closes it atomically', async () => {
    const created = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'reverse-history' });
    expect(created.body.code, JSON.stringify(created.body)).toBe(
      BusinessCode.OK,
    );
    const originThreadId = created.body.data.threadId as number;
    const [originGroup] = await appA.database
      .select({ account: group.account })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, originThreadId))
      .limit(1);
    expect(originGroup).toBeDefined();

    const invited = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: originThreadId, userIds: [bobStubIdA] });
    expect(invited.body.code).toBe(BusinessCode.OK);

    const mirror = await vi.waitFor(
      async () => {
        const [row] = await appB.database
          .select({ id: messageThread.id, groupId: messageThread.groupId })
          .from(messageThread)
          .innerJoin(group, eq(group.id, messageThread.groupId))
          .where(
            and(
              eq(group.account, originGroup.account),
              eq(group.domain, FED_DOMAIN_A),
            ),
          )
          .limit(1);
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 10_000, interval: 100 },
    );
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          mirror.groupId!,
          bobLocalIdB,
        );
        const intent = relationship.pair
          ? await appB.database.query.relationshipIntent.findFirst({
              where: and(
                eq(relationshipIntent.pairId, relationship.pair.id),
                eq(relationshipIntent.authorSide, relationship.groupSide),
              ),
            })
          : undefined;
        expect(intent?.status).toBe('REQUESTED');
      },
      { timeout: 10_000, interval: 100 },
    );
    const joined = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: mirror.id });
    expect(joined.body.code).toBe(BusinessCode.OK);

    await vi.waitFor(
      async () => {
        const originRelationship = await findGroupRelationship(
          appA.database,
          (await appA.database.query.messageThread.findFirst({
            where: eq(messageThread.id, originThreadId),
          }))!.groupId!,
          bobStubIdA,
        );
        expect(originRelationship.pair?.active).toBe(true);
        expect(
          await appA.database.query.threadAudience.findFirst({
            where: and(
              eq(threadAudience.threadId, originThreadId),
              eq(threadAudience.targetDomain, FED_DOMAIN_B),
            ),
          }),
        ).toMatchObject({ messageAccessAfterSeq: 0 });
      },
      { timeout: 15_000, interval: 100 },
    );

    await appB.stop();
    const historicalTexts = [
      'reverse-history-one',
      'reverse-history-two',
      'reverse-history-three',
    ];
    for (const text of historicalTexts) {
      const sent = await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: originThreadId,
          content: text,
          contentType: ContentType.PURE_TEXT,
          clientMessageId: randomUUID(),
        });
      expect(sent.body.code).toBe(BusinessCode.OK);
    }
    const sourceMessages = await appA.database.query.message.findMany({
      where: and(
        eq(message.threadId, originThreadId),
        inArray(
          message.content,
          historicalTexts.map((text) => JSON.stringify({ text })),
        ),
      ),
    });
    expect(sourceMessages).toHaveLength(historicalTexts.length);

    proxy.blockReverseMessages(true);
    await appB.start();

    const beforeRestart = await vi.waitFor(
      async () => {
        expect(proxy.blockedReverseMessageCount()).toBeGreaterThan(0);
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirror.id),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state?.activeGapId).not.toBeNull();
        expect(state?.historyBoundaryReached).toBe(false);
        const gap =
          await appB.database.query.federationThreadHistoryGap.findFirst({
            where: eq(federationThreadHistoryGap.id, state!.activeGapId!),
          });
        expect(gap).toMatchObject({ startSeq: 1, recoverable: true });
        const newest = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirror.id),
            eq(message.originSeq, state!.messageTargetSeq),
            eq(message.federationSourceDomain, FED_DOMAIN_A),
          ),
        });
        expect(newest?.localState).toBe('READY');
        return { state: state!, gap: gap! };
      },
      { timeout: 15_000, interval: 100 },
    );
    const clientFeedBefore =
      await appB.database.query.clientMessageFeed.findFirst({
        where: and(
          eq(clientMessageFeed.userId, bobLocalIdB),
          eq(clientMessageFeed.threadId, mirror.id),
        ),
      });

    await appB.stop();
    const durableWhileStopped =
      await appB.database.query.federationThreadSyncState.findFirst({
        where: and(
          eq(federationThreadSyncState.threadId, mirror.id),
          eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
        ),
      });
    expect(durableWhileStopped?.activeGapId).toBe(
      beforeRestart.state.activeGapId,
    );
    await appB.start();
    await vi.waitFor(
      () => expect(proxy.blockedReverseMessageCount()).toBeGreaterThan(0),
      { timeout: 15_000, interval: 100 },
    );
    const resumedGap =
      await appB.database.query.federationThreadHistoryGap.findFirst({
        where: eq(
          federationThreadHistoryGap.id,
          beforeRestart.state.activeGapId!,
        ),
      });
    expect(resumedGap).toMatchObject({
      startSeq: beforeRestart.gap.startSeq,
      endSeq: beforeRestart.gap.endSeq,
      recoverable: true,
    });

    proxy.blockReverseMessages(false);
    await vi.waitFor(
      async () => {
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirror.id),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state).toMatchObject({
          activeGapId: null,
          historyBoundaryReached: true,
        });
        const mirrored = await appB.database.query.message.findMany({
          where: and(
            eq(message.threadId, mirror.id),
            inArray(
              message.content,
              historicalTexts.map((text) => JSON.stringify({ text })),
            ),
          ),
        });
        expect(mirrored).toHaveLength(historicalTexts.length);
      },
      { timeout: 15_000, interval: 100 },
    );

    const mirrored = await appB.database.query.message.findMany({
      where: and(
        eq(message.threadId, mirror.id),
        inArray(
          message.content,
          historicalTexts.map((text) => JSON.stringify({ text })),
        ),
      ),
    });
    const sourceSeqs = new Map(
      sourceMessages.map((source) => [source.content, source.seq]),
    );
    for (const restored of mirrored) {
      expect(restored.originSeq).toBe(sourceSeqs.get(restored.content));
      if (restored.originSeq! < beforeRestart.state.messageTargetSeq)
        expect(restored.localState).toBe('READY');
    }
    expect(
      await appB.database.query.clientMessageFeed.findFirst({
        where: and(
          eq(clientMessageFeed.userId, bobLocalIdB),
          eq(clientMessageFeed.threadId, mirror.id),
        ),
      }),
    ).toEqual(clientFeedBefore);
  }, 120_000);
});
