import {
  groupState as group,
  groupStateFields,
  readGroupState,
} from '../src/group/shared/group-state.js';
import type { NamespacedAddress } from '../src/common/client-identity.js';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { ContentType } from '../src/database/enums.js';
import {
  accountThreadState,
  deletedMessage,
  federationThreadHistoryGap,
  federationThreadSyncState,
  groupMetaMemberFeed,
  message,
  messageThread,
  peerStateFeed,
  relationshipIntent,
  systemSetting,
  threadAudience,
  identityNamespace,
} from '../src/database/schema.js';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../src/federation/federation-history-access-setting.js';
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
  registerAndLogin,
  resolveFederatedCard,
  uploadAvatar,
} from './federation-test-helpers.js';
import { findGroupRelationship } from './seed.js';
import {
  waitForAcceptedDurableTask,
  waitForAcceptedDurableTasks,
  waitForLocalRelationshipRequest,
} from './durable-task-helpers.js';

describe('federation reverse thread rounds (two nodes)', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenA: string;
  let tokenB: string;
  let bobLocalIdB: number;
  let bobAddressOnA: NamespacedAddress;
  let carolLocalIdA: number;
  let tokenCarol: string;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    const alice = await registerAndLogin(appA, 'reversealice', 'Reverse Alice');
    const bob = await registerAndLogin(appB, 'reversebob', 'Reverse Bob');
    tokenA = alice.token;
    tokenB = bob.token;
    bobLocalIdB = bob.id;
    await uploadAvatar(appA, tokenA, await makePng(37));
    await uploadAvatar(appB, tokenB, await makePng(73));
    await establishFederatedFriendship({
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
    bobAddressOnA = {
      account: 'reversebob',
      domain: FED_DOMAIN_B,
      namespaceId: (await appA.database.query.identityNamespace.findFirst({
        where: eq(identityNamespace.domain, FED_DOMAIN_B),
      }))!.id,
    };
    const carol = await registerAndLogin(appA, 'reversecarol', 'Reverse Carol');
    tokenCarol = carol.token;
    carolLocalIdA = carol.id;
    await uploadAvatar(appA, tokenCarol, await makePng(109));
    const localFriendRequest = await request(appA.baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'reversecarol', domain: 'local' });
    expect(localFriendRequest.body.code).toBe(BusinessCode.OK);
    await waitForLocalRelationshipRequest(
      appA.database,
      localFriendRequest.body,
      alice.id,
      carol.id,
    );
    const localFriendAccepted = await request(appA.baseUrl)
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${tokenCarol}`)
      .send({ account: 'reversealice', domain: 'local' });
    expect(localFriendAccepted.body.code).toBe(BusinessCode.OK);
    expect(localFriendAccepted.body.data).toMatchObject({ status: 'OK' });
  }, 120_000);

  beforeEach(async () => {
    // Fault-injection cases share these nodes. Complete real Health recovery before the next case.
    const resolved = await Promise.all([
      resolveFederatedCard(appA, tokenA, 'reversebob', FED_DOMAIN_B),
      resolveFederatedCard(appB, tokenB, 'reversealice', FED_DOMAIN_A),
    ]);
    for (const result of resolved) expect(result.event).toBe('resolved');
  });

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
      .select({ account: groupStateFields.account })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
      .where(eq(messageThread.id, originThreadId))
      .limit(1);
    expect(originGroup).toBeDefined();
    await beforeInvite?.(originThreadId);
    const invited = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        groupId: originThreadId,
        users: [{ account: 'reversebob', domain: FED_DOMAIN_B }],
      });
    expect(invited.body.code, JSON.stringify(invited.body)).toBe(
      BusinessCode.OK,
    );
    await waitForAcceptedDurableTasks(appA.database, invited.body);
    const mirror = await vi.waitFor(
      async () => {
        const [row] = await appB.database
          .select({ id: messageThread.id, groupId: messageThread.id })
          .from(messageThread)
          .innerJoin(group, eq(group.id, messageThread.id))
          .where(
            and(
              eq(groupStateFields.account, originGroup.account),
              eq(groupStateFields.domain, FED_DOMAIN_A),
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
          mirror.id!,
          bobLocalIdB,
        );
        const invitation = relationship.pair
          ? await appB.database.query.relationshipIntent.findFirst({
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
    await waitForAcceptedDurableTask(appB.database, joined.body);
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
      mirrorGroupId: mirror.id!,
    };
  }

  it('retains a quote when its source was withdrawn before a remote member joined', async () => {
    const { originThreadId, mirrorThreadId } = await createJoinedFederatedGroup(
      'late-join-withdrawn-quote',
      async (threadId) => {
        const source = await request(appA.baseUrl)
          .post('/api/v1/send-message')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            threadId,
            content: 'withdraw-before-join',
            contentType: ContentType.PURE_TEXT,
            clientMessageId: randomUUID(),
          });
        expect(source.body.code).toBe(BusinessCode.OK);
        const reply = await request(appA.baseUrl)
          .post('/api/v1/send-message')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            threadId,
            content: JSON.stringify({
              text: 'late-join-quote',
              quote: { seq: source.body.data.seq },
            }),
            contentType: ContentType.PURE_TEXT,
            clientMessageId: randomUUID(),
          });
        expect(reply.body.code).toBe(BusinessCode.OK);
        const withdrawn = await request(appA.baseUrl)
          .post('/api/v1/withdraw-message')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ threadId, seq: source.body.data.seq });
        expect(withdrawn.body.code).toBe(BusinessCode.OK);
      },
    );
    const mirror = await vi.waitFor(
      async () => {
        const rows = await appB.database.query.message.findMany({
          where: eq(message.threadId, mirrorThreadId),
        });
        const reply = rows.find(
          (m) => JSON.parse(m.content).text === 'late-join-quote',
        );
        expect(reply).toMatchObject({ localState: 'READY', isDeleted: false });
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: eq(federationThreadSyncState.threadId, mirrorThreadId),
          });
        expect(state).toMatchObject({
          activeGapId: null,
        });
        return reply!;
      },
      { timeout: 20_000, interval: 100 },
    );
    const queried = await request(appB.baseUrl)
      .post('/api/v1/query-messages')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: mirrorThreadId,
        after: mirror.seq - 1,
        through: mirror.seq,
        take: 1,
      });
    expect(queried.body.code).toBe(BusinessCode.OK);
    expect(JSON.parse(queried.body.data.messages[0].content)).toMatchObject({
      text: 'late-join-quote',
      quote: { status: 'NOT_FOUND' },
    });
    const resolved = await request(appB.baseUrl)
      .post('/api/v1/message/quote-resolution')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ threadId: mirrorThreadId, messageSeq: mirror.seq });
    expect(resolved.body.code).toBe(BusinessCode.OK);
    expect(resolved.body.data).toMatchObject({
      status: 'READY',
      result: { status: 'NOT_FOUND' },
    });
  }, 60_000);

  it('filters third-party mirror copies before a later local gallery submission', async () => {
    const { originThreadId, mirrorThreadId, mirrorGroupId } =
      await createJoinedFederatedGroup('mirror-owned-gallery');
    const mirrorGroup = await readGroupState(
      appB.database,
      eq(group.id, mirrorGroupId),
    );
    // Model a retained third-node copy ahead of the next locally authored message.
    // It is not a submission by this server and must never be returned by the filtered feed.
    await appB.database.transaction(async (tx) => {
      const [thread] = await tx
        .update(messageThread)
        .set({ curSeq: sql`${messageThread.curSeq} + 1` })
        .where(eq(messageThread.id, mirrorThreadId))
        .returning({ seq: messageThread.curSeq });
      await tx.insert(message).values({
        threadId: mirrorThreadId,
        seq: thread.seq,
        originSeq: 999,
        originServerTime: new Date(),
        sourceNamespaceId: mirrorGroup!.namespaceId,
        creatorAccount: 'third-member',
        creatorDomain: 'third.test',
        profileNamespaceId: mirrorGroup!.namespaceId,
        profileRev: 0,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: 'third-party-copy' }),
        localState: 'READY',
        updatedAt: new Date(),
      });
    });
    const clientMessageId = randomUUID();
    const staged = await request(appB.baseUrl)
      .post('/api/v1/send-media')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: mirrorThreadId,
        clientMessageId,
        contentType: 'GALLERY',
        fileCnt: 2,
      });
    expect(staged.body.code).toBe(BusinessCode.OK);
    for (const position of [0, 1]) {
      const uploaded = await request(appB.baseUrl)
        .post('/api/v1/upload')
        .set('Authorization', `Bearer ${tokenB}`)
        .set('x-client-message-id', clientMessageId)
        .attach(
          'file',
          await makePng(151 + position),
          `gallery-${position}.png`,
        )
        .field('partId', randomUUID())
        .field('position', String(position))
        .field('intent', 'FILE');
      expect(uploaded.body.code).toBe(BusinessCode.OK);
    }
    await vi.waitFor(
      async () => {
        const source = await appB.database.query.message.findFirst({
          where: eq(message.clientMessageId, clientMessageId),
        });
        expect(source).toMatchObject({ localState: 'READY' });
        const received = await appA.database.query.message.findFirst({
          where: and(
            eq(message.threadId, originThreadId),
            eq(message.creatorAccount, 'reversebob'),
            eq(message.contentType, ContentType.GALLERY),
          ),
        });
        expect(received).toMatchObject({
          contentType: 'GALLERY',
          localState: 'READY',
          isDeleted: false,
        });
        expect(source!.originSeq).toBe(received!.seq);
        expect(
          await appA.database.query.message.findFirst({
            where: and(
              eq(message.threadId, originThreadId),
              eq(message.creatorAccount, 'third-member'),
            ),
          }),
        ).toBeUndefined();
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 60_000);

  it('propagates a remote member withdrawal to the group origin', async () => {
    const { originThreadId, mirrorThreadId, mirrorGroupId } =
      await createJoinedFederatedGroup('remote-member-withdrawal');
    const mirrorGroup = await readGroupState(
      appB.database,
      eq(group.id, mirrorGroupId),
    );
    // Model independently allocated local history without depending on the timing
    // of join system messages. The next real send fills the new local tail.
    await appB.database
      .update(messageThread)
      .set({ curSeq: sql`${messageThread.curSeq} + 100` })
      .where(eq(messageThread.id, mirrorThreadId));
    const sent = await request(appB.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: mirrorThreadId,
        content: 'remote-member-withdrawal-source',
        contentType: ContentType.PURE_TEXT,
        clientMessageId: randomUUID(),
      });
    expect(sent.body.code).toBe(BusinessCode.OK);
    const origin = await vi.waitFor(
      async () => {
        const row = await appA.database.query.message.findFirst({
          where: and(
            eq(message.threadId, originThreadId),
            eq(message.creatorAccount, 'reversebob'),
            eq(
              message.content,
              JSON.stringify({ text: 'remote-member-withdrawal-source' }),
            ),
          ),
        });
        expect(row).toMatchObject({ isDeleted: false });
        return row!;
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(origin.seq).not.toBe(sent.body.data.seq);
    await vi.waitFor(
      async () => {
        const source = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirrorThreadId),
            eq(message.seq, sent.body.data.seq),
          ),
        });
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: eq(federationThreadSyncState.threadId, mirrorThreadId),
          });
        expect(source, JSON.stringify({ state, mirrorGroup })).toMatchObject({
          seq: sent.body.data.seq,
          originSeq: origin.seq,
          originServerTime: origin.createdAt,
          creatorDomain: 'local',
        });
        expect(source!.sourceNamespaceId).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 },
    );
    const retried = await request(appB.baseUrl)
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        threadId: mirrorThreadId,
        content: 'remote-member-withdrawal-source',
        contentType: ContentType.PURE_TEXT,
        clientMessageId: sent.body.data.clientMessageId,
      });
    expect(retried.body.code).toBe(BusinessCode.OK);
    expect(retried.body.data).toMatchObject({
      seq: sent.body.data.seq,
      originSeq: origin.seq,
    });
    const withdrawn = await request(appB.baseUrl)
      .post('/api/v1/withdraw-message')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ threadId: mirrorThreadId, seq: sent.body.data.seq });
    expect(withdrawn.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        expect(
          await appA.database.query.message.findFirst({
            where: eq(message.id, origin.id),
          }),
        ).toMatchObject({
          isDeleted: true,
          originSeq: sent.body.data.originSeq,
        });
        expect(
          await appA.database.query.deletedMessage.findFirst({
            where: and(
              eq(deletedMessage.threadId, originThreadId),
              eq(deletedMessage.messageSeq, origin.seq),
            ),
          }),
        ).toMatchObject({ sourceNamespaceId: 0, messageSeq: origin.seq });
        const head = await appA.database.query.peerStateFeed.findFirst({
          where: and(
            eq(peerStateFeed.peerDomain, FED_DOMAIN_B),
            eq(peerStateFeed.account, mirrorGroup!.account),
            eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          ),
        });
        expect(
          (head?.body as { tombstoneEndSeq: number })?.tombstoneEndSeq,
        ).toBeGreaterThan(0);
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 60_000);

  it('publishes the paired client tombstone head when the federated current message is withdrawn', async () => {
    const { originThreadId, mirrorThreadId } = await createJoinedFederatedGroup(
      'withdraw-current-preview',
    );
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
        const head = await appB.database.query.accountThreadState.findFirst({
          where: and(
            eq(accountThreadState.accountId, bobLocalIdB),
            eq(accountThreadState.threadId, mirrorThreadId),
          ),
        });
        expect(head).toMatchObject({
          threadId: mirrorThreadId,
          messageEndSeq: expect.any(Number),
          tombstoneEndSeq: expect.any(Number),
        });
        expect(head!.messageEndSeq).toBeGreaterThanOrEqual(mirrored.seq);
        expect(head!.tombstoneEndSeq).toBeGreaterThan(0);
        expect(head!.threadFeedId).toBeGreaterThan(0);
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
      .select({ account: groupStateFields.account })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
      .where(eq(messageThread.id, originThreadId))
      .limit(1);
    expect(originGroup).toBeDefined();

    // Seed history before the authorization snapshot initializes the mirror.
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

    const invited = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        groupId: originThreadId,
        users: [{ account: 'reversebob', domain: FED_DOMAIN_B }],
      });
    expect(invited.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTasks(appA.database, invited.body);

    const mirror = await vi.waitFor(
      async () => {
        const [row] = await appB.database
          .select({
            id: messageThread.id,
            groupId: messageThread.id,
            authorityNamespaceId: messageThread.authorityNamespaceId,
          })
          .from(messageThread)
          .innerJoin(group, eq(group.id, messageThread.id))
          .where(
            and(
              eq(groupStateFields.account, originGroup.account),
              eq(groupStateFields.domain, FED_DOMAIN_A),
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
          mirror.id!,
          bobLocalIdB,
        );
        const intent = relationship.pair
          ? await appB.database.query.relationshipIntent.findFirst({
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
    await waitForAcceptedDurableTask(appB.database, joined.body);

    await vi.waitFor(
      async () => {
        const originRelationship = await findGroupRelationship(
          appA.database,
          originThreadId,
          bobAddressOnA,
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

    const beforeRestart = await vi.waitFor(
      async () => {
        expect(proxy.blockedReverseMessageCount()).toBeGreaterThan(0);
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(eq(federationThreadSyncState.threadId, mirror.id)),
          });
        expect(state?.activeGapId).not.toBeNull();
        const gap =
          await appB.database.query.federationThreadHistoryGap.findFirst({
            where: eq(federationThreadHistoryGap.id, state!.activeGapId!),
          });
        expect(gap).toMatchObject({ startSeq: 1, recoverable: true });
        const newest = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirror.id),
            eq(message.originSeq, state!.messageTargetSeq),
            eq(message.sourceNamespaceId, mirror.authorityNamespaceId),
          ),
        });
        expect(newest?.localState).toBe('READY');
        return { state: state!, gap: gap!, latestLocalSeq: newest!.seq };
      },
      { timeout: 15_000, interval: 100 },
    );
    const clientFeedBefore = await vi.waitFor(
      async () => {
        const head = await appB.database.query.accountThreadState.findFirst({
          where: and(
            eq(accountThreadState.accountId, bobLocalIdB),
            eq(accountThreadState.threadId, mirror.id),
          ),
          columns: {
            threadFeedId: true,
            messageEndSeq: true,
            tombstoneEndSeq: true,
            unreadCount: true,
            previewSeqs: true,
            lastMentionSeq: true,
          },
        });
        expect(head?.messageEndSeq).toBe(beforeRestart.latestLocalSeq);
        return head!;
      },
      { timeout: 15_000, interval: 100 },
    );

    await appB.stop();
    const durableWhileStopped =
      await appB.database.query.federationThreadSyncState.findFirst({
        where: and(eq(federationThreadSyncState.threadId, mirror.id)),
      });
    expect(durableWhileStopped?.activeGapId).toBe(
      beforeRestart.state.activeGapId,
    );
    expect(
      (await findGroupRelationship(appB.database, mirror.id!, bobLocalIdB))
        .pair,
    ).toMatchObject({ active: true, threadId: mirror.id });
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
            where: and(eq(federationThreadSyncState.threadId, mirror.id)),
          });
        expect(state).toMatchObject({
          activeGapId: null,
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
      await appB.database.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, bobLocalIdB),
          eq(accountThreadState.threadId, mirror.id),
        ),
        columns: {
          threadFeedId: true,
          messageEndSeq: true,
          tombstoneEndSeq: true,
          unreadCount: true,
          previewSeqs: true,
          lastMentionSeq: true,
        },
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
      .select({ account: groupStateFields.account, groupId: messageThread.id })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
      .where(eq(messageThread.id, originThreadId))
      .limit(1);
    expect(originGroup).toBeDefined();

    const inviteCarol = await request(appA.baseUrl)
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        groupId: originThreadId,
        users: [{ account: 'reversecarol', domain: 'local' }],
      });
    expect(inviteCarol.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTasks(appA.database, inviteCarol.body);
    const joinCarol = await request(appA.baseUrl)
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${tokenCarol}`)
      .send({ groupId: originThreadId });
    expect(joinCarol.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appA.database, joinCarol.body);

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
      .send({ groupId: originThreadId });
    expect(leaveCarol.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appA.database, leaveCarol.body);
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
        .send({
          groupId: originThreadId,
          users: [{ account: 'reversebob', domain: FED_DOMAIN_B }],
        });
      expect(invited.body.code, JSON.stringify(invited.body)).toBe(
        BusinessCode.OK,
      );
      await waitForAcceptedDurableTasks(appA.database, invited.body);
    };
    await inviteBob();
    const mirror = await vi.waitFor(
      async () => {
        const [row] = await appB.database
          .select({ id: messageThread.id, groupId: messageThread.id })
          .from(messageThread)
          .innerJoin(group, eq(group.id, messageThread.id))
          .where(
            and(
              eq(groupStateFields.account, originGroup.account),
              eq(groupStateFields.domain, FED_DOMAIN_A),
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
            mirror.id!,
            bobLocalIdB,
          );
          const invitation = relationship.pair
            ? await appB.database.query.relationshipIntent.findFirst({
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
      await waitForAcceptedDurableTask(appB.database, joined.body);
    };
    await joinBob();

    await vi.waitFor(
      async () => {
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(eq(federationThreadSyncState.threadId, mirror.id)),
          });
        expect(state).toMatchObject({
          activeGapId: null,
        });
        expect(state!.messageProcessedThroughSeq).toBe(state!.messageTargetSeq);
        const historicalMessage = await appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, mirror.id),
            eq(message.content, JSON.stringify({ text: departedHistoryText })),
          ),
        });
        expect(historicalMessage).toMatchObject({
          creatorAccount: 'reversecarol',
          creatorDomain: FED_DOMAIN_A,
        });
        const departedCarolFacts = await appB.database
          .select({ feedId: groupMetaMemberFeed.feedId })
          .from(groupMetaMemberFeed)
          .where(
            and(
              eq(groupMetaMemberFeed.threadId, mirror.id!),
              eq(groupMetaMemberFeed.memberAccount, 'reversecarol'),
              eq(groupMetaMemberFeed.memberDomain, FED_DOMAIN_A),
            ),
          );
        expect(departedCarolFacts).toEqual([]);
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
        .send({ groupId: mirror.id });
      expect(left.body.code).toBe(BusinessCode.OK);
      await waitForAcceptedDurableTask(appB.database, left.body);
      expect(
        await appB.database.query.messageThread.findFirst({
          where: eq(messageThread.id, mirror.id),
        }),
      ).toMatchObject({ federationRoundsEnabled: false });
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
        where: and(eq(federationThreadSyncState.threadId, mirror.id)),
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
            where: and(eq(federationThreadSyncState.threadId, mirror.id)),
          });
        const thread = await appB.database.query.messageThread.findFirst({
          where: eq(messageThread.id, mirror.id),
          columns: { authorizationEpoch: true, federationRoundsEnabled: true },
        });
        expect(thread?.federationRoundsEnabled).toBe(true);
        expect(
          state!.authorizationEpoch,
          JSON.stringify({
            threadEpoch: thread?.authorizationEpoch,
            previousStateEpoch: stateBeforeReauthorization!.authorizationEpoch,
            currentStateEpoch: state!.authorizationEpoch,
            messageTargetSeq: state!.messageTargetSeq,
            deletionTargetSeq: state!.deletionTargetSeq,
            deletionRecoveryThroughSeq: state!.deletionRecoveryThroughSeq,
          }),
        ).toBeGreaterThan(stateBeforeReauthorization!.authorizationEpoch);
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
        const progress = mirrored
          ? undefined
          : {
              thread: await appB.database.query.messageThread.findFirst({
                where: eq(messageThread.id, mirror.id),
              }),
              sync: await appB.database.query.federationThreadSyncState.findFirst(
                { where: eq(federationThreadSyncState.threadId, mirror.id) },
              ),
            };
        expect(
          mirrored,
          JSON.stringify(progress, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ).toMatchObject({ isDeleted: false });
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
            where: and(eq(federationThreadSyncState.threadId, mirror.id)),
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
        where: and(eq(federationThreadSyncState.threadId, mirror.id)),
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
            where: and(eq(federationThreadSyncState.threadId, mirror.id)),
          });
        expect(state).toMatchObject({
          deletionRecoveryThroughSeq: null,
          deletionRecoveryMaxMessageSeq: null,
          activeGapId: null,
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
            where: and(eq(federationThreadSyncState.threadId, mirror.id)),
          });
        expect(state!.authorizationEpoch).toBeGreaterThan(
          recoveryState.authorizationEpoch,
        );
        expect(state).toMatchObject({
          deletionRecoveryThroughSeq: null,
          deletionRecoveryMaxMessageSeq: null,
          activeGapId: null,
        });
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 180_000);

  it('marks only an unavailable reverse gap terminal and keeps forward delivery live', async () => {
    const historicalTexts = [
      'unavailable-history-one',
      'unavailable-history-two',
      'unavailable-history-three',
    ];
    proxy.blockReverseMessages(true);
    const { originThreadId, mirrorThreadId } = await createJoinedFederatedGroup(
      'unavailable-reverse-gap',
      async (threadId) => {
        // The authorization snapshot must include the history to backfill.
        for (const text of historicalTexts) {
          const sent = await request(appA.baseUrl)
            .post('/api/v1/send-message')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
              threadId,
              content: text,
              contentType: ContentType.PURE_TEXT,
              clientMessageId: randomUUID(),
            });
          expect(sent.body.code).toBe(BusinessCode.OK);
        }
      },
    );

    const active = await vi.waitFor(
      async () => {
        expect(proxy.blockedReverseMessageCount()).toBeGreaterThan(0);
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(eq(federationThreadSyncState.threadId, mirrorThreadId)),
          });
        expect(state?.activeGapId).not.toBeNull();
        const gap =
          await appB.database.query.federationThreadHistoryGap.findFirst({
            where: eq(federationThreadHistoryGap.id, state!.activeGapId!),
          });
        expect(gap?.recoverable).toBe(true);
        // Forward and reverse rounds are independent; wait for the authorized tail.
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
        ).toMatchObject({ localState: 'READY' });
        return { state: state!, gap: gap! };
      },
      { timeout: 20_000, interval: 100 },
    );

    await appA.database
      .update(threadAudience)
      .set({
        messageAccessAfterSeq: active.gap.endSeq,
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
            where: and(eq(federationThreadSyncState.threadId, mirrorThreadId)),
          }),
          appB.database.query.federationThreadHistoryGap.findFirst({
            where: eq(federationThreadHistoryGap.id, active.gap.id),
          }),
        ]);
        expect(state).toMatchObject({
          activeGapId: null,
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
    let hiddenThrough: number;
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
        hiddenThrough = (await appA.database.query.messageThread.findFirst({
          where: eq(messageThread.id, threadId),
          columns: { curSeq: true },
        }))!.curSeq;
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
        ).toMatchObject({ messageAccessAfterSeq: hiddenThrough });
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
            where: and(eq(federationThreadSyncState.threadId, mirrorThreadId)),
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
      .send({ groupId: mirrorThreadId });
    expect(left.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDurableTask(appB.database, left.body);
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
      .send({
        groupId: originThreadId,
        users: [{ account: 'reversebob', domain: FED_DOMAIN_B }],
      });
    expect(reinvited.body.code, JSON.stringify(reinvited.body)).toBe(
      BusinessCode.OK,
    );
    await waitForAcceptedDurableTasks(appA.database, reinvited.body);
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
    await waitForAcceptedDurableTask(appB.database, rejoined.body);
    const newState = await vi.waitFor(
      async () => {
        const state =
          await appB.database.query.federationThreadSyncState.findFirst({
            where: and(eq(federationThreadSyncState.threadId, mirrorThreadId)),
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
            where: and(eq(federationThreadSyncState.threadId, mirrorThreadId)),
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
