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
  clientStateFeed,
  federationThreadHistoryGap,
  federationThreadSyncState,
  group,
  message,
  messageThread,
  relationshipIntent,
  systemSetting,
  threadAudience,
  threadMember,
  user,
} from '../src/database/schema.js';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../src/federation/federation-history-access-setting.js';
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
import { waitForLocalFriendInvite } from './domain-command-helpers.js';

describe('federation reverse thread rounds (two nodes)', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let tokenB: string;
  let bobLocalIdB: number;
  let bobStubIdA: number;
  let carolLocalIdA: number;
  let tokenCarol: string;

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
    const carol = await registerAndLogin(appA, 'reversecarol', 'Reverse Carol');
    tokenCarol = carol.token;
    carolLocalIdA = carol.id;
    await uploadAvatar(appA, tokenCarol, await makePng(109));
    const localFriendRequest = await request(appA.baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'reversecarol' });
    expect(localFriendRequest.body.code).toBe(BusinessCode.OK);
    const localFriendInviteId = await waitForLocalFriendInvite(
      appA.database,
      localFriendRequest.body.data.commandId,
      alice.id,
      carol.id,
    );
    const localFriendAccepted = await request(appA.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenCarol}`)
      .send({ inviteId: localFriendInviteId });
    expect(localFriendAccepted.body.code).toBe(BusinessCode.OK);
  }, 120_000);

  afterEach(async () => {
    proxy?.blockReverseMessages(false);
    proxy?.blockMessageFeed(false);
    proxy?.blockMessageFeedResponse(false);
    proxy?.blockTombstoneFeed(false);
    await appA?.database
      .delete(systemSetting)
      .where(eq(systemSetting.key, FEDERATION_HISTORY_ACCESS_SETTING_KEY));
  });

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  async function createJoinedFederatedGroup(
    name: string,
    beforeInvite?: (originThreadId: number) => Promise<void>,
  ): Promise<{
    originThreadId: number;
    mirrorThreadId: number;
    mirrorGroupId: number;
  }> {
    const created = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name });
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
    await beforeInvite?.(originThreadId);
    const invited = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: originThreadId, userIds: [bobStubIdA] });
    expect(invited.body.code, JSON.stringify(invited.body)).toBe(
      BusinessCode.OK,
    );
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
      { timeout: 15_000, interval: 100 },
    );
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          mirror.groupId!,
          bobLocalIdB,
        );
        const invitation = relationship.pair
          ? await appB.database.query.relationshipIntent.findFirst({
              where: and(
                eq(relationshipIntent.pairId, relationship.pair.id),
                eq(relationshipIntent.authorSide, relationship.groupSide),
              ),
            })
          : undefined;
        expect(invitation?.status).toBe('REQUESTED');
      },
      { timeout: 15_000, interval: 100 },
    );
    const joined = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: mirror.id });
    expect(joined.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appA.database.query.threadAudience.findFirst({
            where: and(
              eq(threadAudience.threadId, originThreadId),
              eq(threadAudience.targetDomain, FED_DOMAIN_B),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 15_000, interval: 100 },
    );
    return {
      originThreadId,
      mirrorThreadId: mirror.id,
      mirrorGroupId: mirror.groupId!,
    };
  }

  it('publishes one paired client head with an empty preview when the federated current message is withdrawn', async () => {
    const { originThreadId, mirrorThreadId } =
      await createJoinedFederatedGroup('withdraw-current-preview');
    const text = 'federated-current-preview';
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
    const mirrored = await vi.waitFor(
      async () => {
        const row = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirrorThreadId),
            eq(message.content, JSON.stringify({ text })),
          ),
        });
        expect(row).toMatchObject({ isDeleted: false });
        return row!;
      },
      { timeout: 20_000, interval: 100 },
    );

    const withdrawn = await request(appA.baseUrl)
      .post('/api/v1/withdraw-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ threadId: originThreadId, seq: sent.body.data.seq });
    expect(withdrawn.body.code).toBe(BusinessCode.OK);

    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirrorThreadId),
              eq(message.seq, mirrored.seq),
            ),
          }),
        ).toMatchObject({ isDeleted: true });
        const head = await appB.database.query.clientStateFeed.findFirst({
          where: and(
            eq(clientStateFeed.userId, bobLocalIdB),
            eq(
              clientStateFeed.compactionKey,
              JSON.stringify(['THREAD_CONTENT_HEAD', mirrorThreadId]),
            ),
          ),
        });
        expect(head?.body).toMatchObject({
          threadId: mirrorThreadId,
          tombstoneEndSeq: expect.any(Number),
          preview: { seq: mirrored.seq, text: '', senderId: null },
        });
        expect(
          (head!.body as { messageEndSeq: number }).messageEndSeq,
        ).toBeGreaterThanOrEqual(mirrored.seq);
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 60_000);

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
      await appB.database.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, bobLocalIdB),
          eq(
            clientStateFeed.compactionKey,
            JSON.stringify(['THREAD_CONTENT_HEAD', mirror.id]),
          ),
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
      await appB.database.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, bobLocalIdB),
          eq(
            clientStateFeed.compactionKey,
            JSON.stringify(['THREAD_CONTENT_HEAD', mirror.id]),
          ),
        ),
      }),
    ).toEqual(clientFeedBefore);
  }, 120_000);

  it('converges departed history, withdrawals, and repeated last-member re-entry', async () => {
    const created = await request(appA.baseUrl)
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'repeated-federation-recovery' });
    expect(created.body.code, JSON.stringify(created.body)).toBe(
      BusinessCode.OK,
    );
    const originThreadId = created.body.data.threadId as number;
    const [originGroup] = await appA.database
      .select({ account: group.account, groupId: messageThread.groupId })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, originThreadId))
      .limit(1);
    expect(originGroup).toBeDefined();

    const inviteCarol = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: originThreadId, userIds: [carolLocalIdA] });
    expect(inviteCarol.body.code).toBe(BusinessCode.OK);
    const joinCarol = await request(appA.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenCarol}`)
      .send({ groupId: originThreadId });
    expect(joinCarol.body.code).toBe(BusinessCode.OK);

    const departedHistoryText = 'history-from-departed-carol';
    const retainedWithdrawalText = 'retained-before-remote-leave';
    for (const [token, text] of [
      [tokenCarol, departedHistoryText],
      [tokenA, retainedWithdrawalText],
    ] as const) {
      const sent = await request(appA.baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${token}`)
        .send({
          threadId: originThreadId,
          content: text,
          contentType: ContentType.PURE_TEXT,
          clientMessageId: randomUUID(),
        });
      expect(sent.body.code).toBe(BusinessCode.OK);
    }
    const leaveCarol = await request(appA.baseUrl)
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${tokenCarol}`)
      .send({ groupId: originThreadId, deleteData: false });
    expect(leaveCarol.body.code).toBe(BusinessCode.OK);
    const currentTail = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: 'current-tail-after-carol-left',
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(currentTail.body.code).toBe(BusinessCode.OK);

    const inviteBob = async (): Promise<void> => {
      const invited = await request(appA.baseUrl)
        .post('/api/v1/group/invite')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ groupId: originThreadId, userIds: [bobStubIdA] });
      expect(invited.body.code, JSON.stringify(invited.body)).toBe(
        BusinessCode.OK,
      );
    };
    await inviteBob();
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
      { timeout: 15_000, interval: 100 },
    );
    const joinBob = async (): Promise<void> => {
      await vi.waitFor(
        async () => {
          const relationship = await findGroupRelationship(
            appB.database,
            mirror.groupId!,
            bobLocalIdB,
          );
          const invitation = relationship.pair
            ? await appB.database.query.relationshipIntent.findFirst({
                where: and(
                  eq(relationshipIntent.pairId, relationship.pair.id),
                  eq(relationshipIntent.authorSide, relationship.groupSide),
                ),
              })
            : undefined;
          expect(invitation?.status).toBe('REQUESTED');
        },
        { timeout: 15_000, interval: 100 },
      );
      const joined = await request(appB.baseUrl)
        .post('/api/v1/group/join-request')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: mirror.id });
      expect(joined.body.code).toBe(BusinessCode.OK);
    };
    await joinBob();

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
        expect(state!.messageProcessedThroughSeq).toBe(state!.messageTargetSeq);
        const historicalMessage = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirror.id),
            eq(message.content, JSON.stringify({ text: departedHistoryText })),
          ),
        });
        expect(historicalMessage).toBeDefined();
        const departedCarol = await appB.database.query.user.findFirst({
          where: and(
            eq(user.account, 'reversecarol'),
            eq(user.domain, FED_DOMAIN_A),
            eq(user.sourceDomain, FED_DOMAIN_A),
          ),
        });
        expect(departedCarol).toBeDefined();
        expect(
          await appB.database.query.threadMember.findFirst({
            where: and(
              eq(threadMember.threadId, mirror.id),
              eq(threadMember.userId, departedCarol!.id),
            ),
          }),
        ).toMatchObject({ left: true });
      },
      { timeout: 20_000, interval: 100 },
    );

    const retainedOnOrigin = await appA.database.query.message.findFirst({
      where: and(
        eq(message.threadId, originThreadId),
        eq(message.content, JSON.stringify({ text: retainedWithdrawalText })),
      ),
    });
    expect(retainedOnOrigin).toBeDefined();
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, mirror.id),
          eq(message.originSeq, retainedOnOrigin!.seq),
        ),
      }),
    ).toMatchObject({ isDeleted: false });

    const leaveBob = async (): Promise<void> => {
      const left = await request(appB.baseUrl)
        .post('/api/v1/group/leave')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ groupId: mirror.id, deleteData: false });
      expect(left.body.code).toBe(BusinessCode.OK);
      await vi.waitFor(
        async () => {
          expect(
            await appA.database.query.threadAudience.findFirst({
              where: and(
                eq(threadAudience.threadId, originThreadId),
                eq(threadAudience.targetDomain, FED_DOMAIN_B),
              ),
            }),
          ).toBeUndefined();
        },
        { timeout: 15_000, interval: 100 },
      );
    };
    await leaveBob();
    const stateBeforeReauthorization =
      await appB.database.query.federationThreadSyncState.findFirst({
        where: and(
          eq(federationThreadSyncState.threadId, mirror.id),
          eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
        ),
      });
    expect(stateBeforeReauthorization).toBeDefined();

    const withdrawn = await request(appA.baseUrl)
      .post('/api/v1/withdraw-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ threadId: originThreadId, seq: retainedOnOrigin!.seq });
    expect(withdrawn.body.code).toBe(BusinessCode.OK);
    const firstGapTexts = [
      'unauthorized-gap-one',
      'unauthorized-gap-two',
      'unauthorized-gap-three',
    ];
    for (const text of firstGapTexts) {
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

    proxy.blockTombstoneFeed(true);
    await inviteBob();
    await joinBob();
    const recoveryState = await vi.waitFor(
      async () => {
        expect(proxy.blockedTombstoneFeedCount()).toBeGreaterThan(0);
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirror.id),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state!.authorizationEpoch).toBeGreaterThan(
          stateBeforeReauthorization!.authorizationEpoch,
        );
        expect(state!.deletionRecoveryThroughSeq).not.toBeNull();
        expect(state!.deletionRecoveryMaxMessageSeq).toBe(
          stateBeforeReauthorization!.messageProcessedThroughSeq,
        );
        return state!;
      },
      { timeout: 20_000, interval: 100 },
    );

    const duringRecoveryText = 'message-during-frozen-deletion-recovery';
    const sentDuringRecovery = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: duringRecoveryText,
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(sentDuringRecovery.body.code).toBe(BusinessCode.OK);
    const duringRecoveryOnOrigin = await vi.waitFor(
      async () => {
        const [origin, mirrored] = await Promise.all([
          appA.database.query.message.findFirst({
            where: and(
              eq(message.threadId, originThreadId),
              eq(message.content, JSON.stringify({ text: duringRecoveryText })),
            ),
          }),
          appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirror.id),
              eq(message.content, JSON.stringify({ text: duringRecoveryText })),
            ),
          }),
        ]);
        expect(origin).toBeDefined();
        expect(mirrored).toMatchObject({ isDeleted: false });
        return origin!;
      },
      { timeout: 20_000, interval: 100 },
    );
    const withdrawnDuringRecovery = await request(appA.baseUrl)
      .post('/api/v1/withdraw-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ threadId: originThreadId, seq: duringRecoveryOnOrigin.seq });
    expect(withdrawnDuringRecovery.body.code).toBe(BusinessCode.OK);
    const mergedDeletionTarget = await vi.waitFor(
      async () => {
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirror.id),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state!.deletionRecoveryThroughSeq).toBe(
          recoveryState.deletionRecoveryThroughSeq,
        );
        expect(state!.deletionRecoveryMaxMessageSeq).toBe(
          recoveryState.deletionRecoveryMaxMessageSeq,
        );
        expect(state!.deletionTargetSeq).toBeGreaterThan(
          recoveryState.deletionRecoveryThroughSeq!,
        );
        return state!.deletionTargetSeq;
      },
      { timeout: 20_000, interval: 100 },
    );

    await appB.restart();
    await vi.waitFor(
      () => expect(proxy.blockedTombstoneFeedCount()).toBeGreaterThan(0),
      { timeout: 20_000, interval: 100 },
    );
    const durableRecovery =
      await appB.database.query.federationThreadSyncState.findFirst({
        where: and(
          eq(federationThreadSyncState.threadId, mirror.id),
          eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
        ),
      });
    expect(durableRecovery?.deletionRecoveryThroughSeq).toBe(
      recoveryState.deletionRecoveryThroughSeq,
    );
    expect(durableRecovery?.deletionRecoveryMaxMessageSeq).toBe(
      recoveryState.deletionRecoveryMaxMessageSeq,
    );
    proxy.blockTombstoneFeed(false);

    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirror.id),
              eq(message.originSeq, retainedOnOrigin!.seq),
            ),
          }),
        ).toMatchObject({ isDeleted: true });
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirror.id),
              eq(message.originSeq, duringRecoveryOnOrigin.seq),
            ),
          }),
        ).toMatchObject({ isDeleted: true });
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirror.id),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state).toMatchObject({
          deletionRecoveryThroughSeq: null,
          deletionRecoveryMaxMessageSeq: null,
          activeGapId: null,
          historyBoundaryReached: true,
        });
        expect(state!.deletionProcessedThroughSeq).toBe(mergedDeletionTarget);
        expect(state!.deletionTargetSeq).toBe(mergedDeletionTarget);
      },
      { timeout: 20_000, interval: 100 },
    );
    for (const text of firstGapTexts) {
      expect(
        await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirror.id),
            eq(message.content, JSON.stringify({ text })),
          ),
        }),
      ).toBeDefined();
    }

    const afterFirstRejoin = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: 'after-first-rejoin',
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(afterFirstRejoin.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirror.id),
              eq(
                message.content,
                JSON.stringify({ text: 'after-first-rejoin' }),
              ),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 15_000, interval: 100 },
    );

    await leaveBob();
    const secondGap = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: 'unauthorized-second-gap',
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(secondGap.body.code).toBe(BusinessCode.OK);
    await inviteBob();
    await joinBob();
    const afterSecondRejoin = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: 'after-second-rejoin',
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(afterSecondRejoin.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirror.id),
              eq(
                message.content,
                JSON.stringify({ text: 'after-second-rejoin' }),
              ),
            ),
          }),
        ).toBeDefined();
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirror.id),
              eq(
                message.content,
                JSON.stringify({ text: 'unauthorized-second-gap' }),
              ),
            ),
          }),
        ).toBeDefined();
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirror.id),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state!.authorizationEpoch).toBeGreaterThan(
          recoveryState.authorizationEpoch,
        );
        expect(state).toMatchObject({
          deletionRecoveryThroughSeq: null,
          deletionRecoveryMaxMessageSeq: null,
          activeGapId: null,
          historyBoundaryReached: true,
        });
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 180_000);

  it('marks only an unavailable reverse gap terminal and keeps forward delivery live', async () => {
    const { originThreadId, mirrorThreadId } = await createJoinedFederatedGroup(
      'unavailable-reverse-gap',
    );

    await appB.stop();
    const historicalTexts = [
      'unavailable-history-one',
      'unavailable-history-two',
      'unavailable-history-three',
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

    proxy.blockReverseMessages(true);
    await appB.start();
    const active = await vi.waitFor(
      async () => {
        expect(proxy.blockedReverseMessageCount()).toBeGreaterThan(0);
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirrorThreadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state?.activeGapId).not.toBeNull();
        const gap =
          await appB.database.query.federationThreadHistoryGap.findFirst({
            where: eq(federationThreadHistoryGap.id, state!.activeGapId!),
          });
        expect(gap?.recoverable).toBe(true);
        return { state: state!, gap: gap! };
      },
      { timeout: 20_000, interval: 100 },
    );

    await appA.database
      .update(threadAudience)
      .set({
        messageAccessAfterSeq: active.gap.endSeq,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threadAudience.threadId, originThreadId),
          eq(threadAudience.targetDomain, FED_DOMAIN_B),
        ),
      );
    proxy.blockReverseMessages(false);

    await vi.waitFor(
      async () => {
        const [state, unavailableGap] = await Promise.all([
          appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirrorThreadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          }),
          appB.database.query.federationThreadHistoryGap.findFirst({
            where: eq(federationThreadHistoryGap.id, active.gap.id),
          }),
        ]);
        expect(state).toMatchObject({
          activeGapId: null,
          historyBoundaryReached: true,
        });
        expect(unavailableGap).toMatchObject({ recoverable: false });
      },
      { timeout: 20_000, interval: 100 },
    );

    for (const text of historicalTexts.slice(0, -1)) {
      expect(
        await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirrorThreadId),
            eq(message.content, JSON.stringify({ text })),
          ),
        }),
      ).toBeUndefined();
    }
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, mirrorThreadId),
          eq(
            message.content,
            JSON.stringify({ text: historicalTexts.at(-1)! }),
          ),
        ),
      }),
    ).toBeDefined();

    const liveText = 'forward-after-unavailable-history';
    const sentLive = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: liveText,
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(sentLive.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirrorThreadId),
              eq(message.content, JSON.stringify({ text: liveText })),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 120_000);

  it('starts a new audience at the current tail when retained history access is disabled', async () => {
    await appA.database.insert(systemSetting).values({
      key: FEDERATION_HISTORY_ACCESS_SETTING_KEY,
      value: 'false',
      updatedAt: new Date(),
    });
    const hiddenText = 'history-before-restricted-authorization';
    const { originThreadId, mirrorThreadId } = await createJoinedFederatedGroup(
      'restricted-federation-history',
      async (threadId) => {
        const sent = await request(appA.baseUrl)
          .post('/api/v1/send-message')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            threadId,
            content: hiddenText,
            contentType: ContentType.PURE_TEXT,
            clientMessageId: randomUUID(),
          });
        expect(sent.body.code).toBe(BusinessCode.OK);
      },
    );

    await vi.waitFor(
      async () => {
        expect(
          await appA.database.query.threadAudience.findFirst({
            where: and(
              eq(threadAudience.threadId, originThreadId),
              eq(threadAudience.targetDomain, FED_DOMAIN_B),
            ),
          }),
        ).toMatchObject({ messageAccessAfterSeq: 1 });
      },
      { timeout: 20_000, interval: 100 },
    );

    const liveText = 'message-after-restricted-authorization';
    const sentLive = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: liveText,
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(sentLive.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirrorThreadId),
              eq(message.content, JSON.stringify({ text: liveText })),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, mirrorThreadId),
          eq(message.content, JSON.stringify({ text: hiddenText })),
        ),
      }),
    ).toBeUndefined();
  }, 120_000);

  it('ignores a stale forbidden response after a newer group authorization epoch commits', async () => {
    const { originThreadId, mirrorThreadId, mirrorGroupId } =
      await createJoinedFederatedGroup('stale-forbidden-epoch');
    const baselineText = 'baseline-before-stale-forbidden';
    const sentBaseline = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: baselineText,
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(sentBaseline.body.code).toBe(BusinessCode.OK);
    const oldState = await vi.waitFor(
      async () => {
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirrorThreadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state).toBeDefined();
        expect(state!.messageProcessedThroughSeq).toBe(state!.messageTargetSeq);
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirrorThreadId),
              eq(message.content, JSON.stringify({ text: baselineText })),
            ),
          }),
        ).toBeDefined();
        return state!;
      },
      { timeout: 20_000, interval: 100 },
    );

    proxy.blockMessageFeed(true);
    const staleText = 'message-behind-stale-forbidden';
    const sentStale = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: staleText,
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(sentStale.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      () => expect(proxy.blockedMessageFeedCount()).toBeGreaterThan(0),
      { timeout: 20_000, interval: 100 },
    );

    const left = await request(appB.baseUrl)
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: mirrorThreadId, deleteData: false });
    expect(left.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appA.database.query.threadAudience.findFirst({
            where: and(
              eq(threadAudience.threadId, originThreadId),
              eq(threadAudience.targetDomain, FED_DOMAIN_B),
            ),
          }),
        ).toBeUndefined();
      },
      { timeout: 20_000, interval: 100 },
    );

    proxy.blockMessageFeedResponse(true);
    proxy.blockMessageFeed(false);
    await vi.waitFor(
      () => expect(proxy.blockedMessageFeedResponseCount()).toBeGreaterThan(0),
      { timeout: 20_000, interval: 100 },
    );

    const reinvited = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ groupId: originThreadId, userIds: [bobStubIdA] });
    expect(reinvited.body.code, JSON.stringify(reinvited.body)).toBe(
      BusinessCode.OK,
    );
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          mirrorGroupId,
          bobLocalIdB,
        );
        const invitation = relationship.pair
          ? await appB.database.query.relationshipIntent.findFirst({
              where: and(
                eq(relationshipIntent.pairId, relationship.pair.id),
                eq(relationshipIntent.authorSide, relationship.groupSide),
              ),
            })
          : undefined;
        expect(invitation?.status).toBe('REQUESTED');
      },
      { timeout: 20_000, interval: 100 },
    );
    const rejoined = await request(appB.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ groupId: mirrorThreadId });
    expect(rejoined.body.code).toBe(BusinessCode.OK);
    const newState = await vi.waitFor(
      async () => {
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirrorThreadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state!.authorizationEpoch).toBeGreaterThan(
          oldState.authorizationEpoch,
        );
        return state!;
      },
      { timeout: 20_000, interval: 100 },
    );

    proxy.blockMessageFeedResponse(false);
    await vi.waitFor(
      async () => {
        const relationship = await findGroupRelationship(
          appB.database,
          mirrorGroupId,
          bobLocalIdB,
        );
        expect(relationship.pair?.active).toBe(true);
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(
              eq(federationThreadSyncState.threadId, mirrorThreadId),
              eq(federationThreadSyncState.peerDomain, FED_DOMAIN_A),
            ),
          });
        expect(state?.authorizationEpoch).toBe(newState.authorizationEpoch);
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(
      await appB.database.query.message.findFirst({
        where: and(
          eq(message.threadId, mirrorThreadId),
          eq(message.content, JSON.stringify({ text: staleText })),
        ),
      }),
    ).toBeUndefined();

    const liveText = 'message-after-stale-forbidden';
    const sentLive = await request(appA.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: originThreadId,
        content: liveText,
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(sentLive.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appB.database.query.message.findFirst({
            where: and(
              eq(message.threadId, mirrorThreadId),
              eq(message.content, JSON.stringify({ text: liveText })),
            ),
          }),
        ).toBeDefined();
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 120_000);
});
