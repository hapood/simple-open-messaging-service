import { FederationStateFeedConsumerService } from '../src/federation/federation-state-feed-consumer.service.js';
import { FederationReverseRevokeService } from '../src/federation/federation-reverse-revoke.service.js';
import { FederationRelationshipMutationService } from '../src/federation/federation-relationship-mutation.service.js';
import { DurableTaskQueueService } from '../src/durable-task/durable-task-queue.service.js';
import { durableTask } from '../src/database/schema.js';
import { systemAccountIdInTx } from '../src/user/system-account.js';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';
import { requireThreadContentLockInTx } from '../src/business/shared/locks/thread-content-lock.js';
import type { AccountTarget } from '../src/user/account-address.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageThreadType } from '../src/database/enums.js';
import {
  account,
  relationshipIntent,
  federationThreadSyncState,
  federationThreadHistoryGap,
  groupAccount as group,
  messageThread,
  accountThreadState,
} from '../src/database/schema.js';
import { RelationshipService } from '../src/relationship/relationship.service.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { MessageService } from '../src/message/message.service.js';
import { ThreadPreviewService } from '../src/message/thread-preview.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { findP2PRelationship, seedFederatedPeerNamespace } from './seed.js';

describe('federation directed-state boundaries', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let relationships: RelationshipService;
  let relationshipIntents: RelationshipIntentService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    relationshipIntents = new RelationshipIntentService();
    relationships = new RelationshipService(
      database,
      {} as never,
      new ClientStateFeedService(database, {
        onStateFeedUpdated: () => undefined,
      } as never),
      relationshipIntents,
      {} as never,
      Object.create(MessageService.prototype) as MessageService,
    );
    Object.assign(relationships, {
      previews: new ThreadPreviewService(database),
    });
  });

  afterAll(async () => mod.close());

  async function createPair(suffix: string) {
    const peerNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      'peer.test',
    );
    const [local] = await database.db
      .insert(account)
      .values({
        account: `boundary-local-${suffix}`,
        updatedAt: new Date(),
      })
      .returning();
    const peer = {
      account: `boundary-peer-${suffix}`,
      domain: 'peer.test',
      namespaceId: peerNamespaceId,
    };
    return { local, peer };
  }

  async function seedIntents(
    localId: number,
    peerId: AccountTarget,
    rows: Array<{
      author: 'local' | 'peer';
      status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
      note?: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
      updatedAt?: Date;
    }>,
  ) {
    await database.db.transaction((tx) =>
      relationshipIntents.lockPairInTx(tx, localId, peerId),
    );
    const relationship = await findP2PRelationship(
      database.db,
      localId,
      peerId,
    );
    await database.db.insert(relationshipIntent).values(
      rows.map((row) => ({
        pairId: relationship.pair!.id,
        authorSide:
          row.author === 'local'
            ? relationship.firstSide
            : relationship.secondSide,
        status: row.status,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        note: row.note ?? '',
        requestedAt: row.requestedAt,
        expiresAt: row.expiresAt,
        updatedAt: row.updatedAt ?? new Date(),
      })),
    );
    return relationship;
  }

  it.each([0, 12])(
    'initializes the retained remote grant (%i messages) atomically on local acceptance',
    async (end) => {
      const { local, peer } = await createPair(`grant-${end}`);
      await database.db.transaction((tx) =>
        relationships.applyRemoteP2PIntentInTx(tx, {
          localUserId: local.id,
          peerUserId: peer,
          status: 'REQUESTED',
          profileRev: 0,
          note: '',
          requestedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          origin: peer.domain,
          messageEndSeq: end,
          tombstoneEndSeq: end === 0 ? 0 : 4,
        }),
      );
      // Scope assertions to the new pair, since this suite preserves other cases.
      let activatedThreadId = 0;
      const activate = async (
        tx: Parameters<Parameters<typeof database.db.transaction>[0]>[0],
      ) => {
        await relationships.writeLocalP2PIntentInTx(tx, local.id, peer, true);
        const pair = await findP2PRelationship(tx, local.id, peer);
        activatedThreadId = pair.pair!.threadId!;
        const state = await tx.query.federationThreadSyncState.findFirst({
          where: eq(federationThreadSyncState.threadId, activatedThreadId),
        });
        expect(state).toMatchObject({
          messageTargetSeq: end,
          messageProcessedThroughSeq: Math.max(0, end - 1),
          deletionTargetSeq: end === 0 ? 0 : 4,
          deletionProcessedThroughSeq: end === 0 ? 0 : 4,
          historyBoundaryReached: end === 0,
        });
      };
      await expect(
        database.db.transaction(async (tx) => {
          await activate(tx);
          throw new Error('rollback grant');
        }),
      ).rejects.toThrow('rollback grant');
      expect(
        await database.db.query.federationThreadSyncState.findFirst({
          where: eq(federationThreadSyncState.threadId, activatedThreadId),
        }),
      ).toBeUndefined();
      await database.db.transaction(activate);
      if (end !== 0) return;
      await database.db.transaction(async (tx) => {
        const threadLock = await requireThreadContentLockInTx(
          tx,
          activatedThreadId,
        );
        // Multiple messages and a deletion may arrive before the first head is drained.
        expect(
          await FederationThreadSyncStateService.updateThreadHeadInTx(tx, {
            threadId: activatedThreadId,
            namespaceId: peer.namespaceId,
            messageTargetSeq: 3,
            deletionTargetSeq: 1,
            threadLock,
          }),
        ).toBe(true);
        const state = await tx.query.federationThreadSyncState.findFirst({
          where: eq(federationThreadSyncState.threadId, activatedThreadId),
        });
        expect(state).toMatchObject({
          messageTargetSeq: 3,
          deletionTargetSeq: 1,
          messageProcessedThroughSeq: 0,
          deletionProcessedThroughSeq: 0,
          activeGapId: null,
          historyBoundaryReached: true,
        });
        await FederationThreadSyncStateService.advanceMessageProcessedThroughInTx(
          tx,
          activatedThreadId,
          3,
          3,
          peer.namespaceId,
        );
        await FederationThreadSyncStateService.advanceDeletionProcessedThroughInTx(
          tx,
          activatedThreadId,
          1,
          1,
          peer.namespaceId,
        );
      });
      const state = await database.db.query.federationThreadSyncState.findFirst(
        {
          where: eq(federationThreadSyncState.threadId, activatedThreadId),
        },
      );
      expect(state).toMatchObject({
        messageProcessedThroughSeq: 3,
        deletionProcessedThroughSeq: 1,
        activeGapId: null,
      });
      expect(
        await database.db
          .select()
          .from(federationThreadHistoryGap)
          .where(eq(federationThreadHistoryGap.threadId, activatedThreadId)),
      ).toHaveLength(0);
    },
  );

  it('rejects NULL snapshots in the database and preserves the existing zero grant', async () => {
    const { local, peer } = await createPair('nonnull-head');
    const relationship = await seedIntents(local.id, peer, [
      {
        author: 'peer',
        status: 'REQUESTED',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await expect(
      database.db.execute(sql`
      UPDATE "RelationshipIntent" SET "messageEndSeq" = NULL, "tombstoneEndSeq" = NULL
      WHERE "pairId" = ${relationship.pair!.id}
    `),
    ).rejects.toThrow();
    const stored = await database.db.query.relationshipIntent.findFirst({
      where: eq(relationshipIntent.pairId, relationship.pair!.id),
    });
    expect(stored).toMatchObject({ messageEndSeq: 0, tombstoneEndSeq: 0 });
    await database.db.transaction((tx) =>
      relationships.writeLocalP2PIntentInTx(tx, local.id, peer, true),
    );
    expect(
      (await findP2PRelationship(database.db, local.id, peer)).pair?.active,
    ).toBe(true);
  });

  it('ignores a peer FRIEND snapshot outside an effective request flow', async () => {
    const { local, peer } = await createPair(Date.now().toString(36));
    const relationship = await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'REVOKED',
        requestedAt: null,
        expiresAt: null,
      },
      {
        author: 'peer',
        status: 'ACCEPTED',
        requestedAt: new Date(),
        expiresAt: null,
      },
    ]);

    const effect = await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: local.id,
        peerUserId: peer,
        status: 'ACCEPTED',
        profileRev: 1,
        note: '',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'peer.test',
      }),
    );

    expect(effect).toMatchObject({
      changed: false,
      requestCreated: false,
      clientFeedUpdates: [],
    });
    expect(effect.requestCreated).toBe(false);
    const directions = await database.db
      .select({
        authorSide: relationshipIntent.authorSide,
        status: relationshipIntent.status,
        expiresAt: relationshipIntent.expiresAt,
      })
      .from(relationshipIntent)
      .where(
        and(
          eq(relationshipIntent.pairId, relationship.pair!.id),
          eq(relationshipIntent.authorSide, relationship.firstSide),
        ),
      );
    expect(directions[0]).toMatchObject({
      authorSide: relationship.firstSide,
      status: 'REVOKED',
      expiresAt: null,
    });
  });

  it('does not synthesize a peer-authored direction for an outbound request', async () => {
    const { local, peer } = await createPair(`o-${Date.now().toString(36)}`);

    await database.db.transaction((tx) =>
      relationships.writeLocalP2PIntentInTx(tx, local.id, peer, true, 'hello'),
    );

    const relationship = await findP2PRelationship(database.db, local.id, peer);
    const directions = await database.db.query.relationshipIntent.findMany({
      where: eq(relationshipIntent.pairId, relationship.pair!.id),
    });
    expect(directions).toHaveLength(1);
    expect(directions[0]).toMatchObject({
      authorSide: relationship.firstSide,
      status: 'REQUESTED',
    });
  });

  it('atomically confirms crossed requests after promoting the local direction', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-crossed`,
    );
    const requestedAt = new Date();
    const relationship = await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'REQUESTED',
        note: 'local request',
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
        updatedAt: requestedAt,
      },
    ]);

    const effect = await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: local.id,
        peerUserId: peer,
        status: 'REQUESTED',
        profileRev: 1,
        note: 'peer request',
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
        origin: 'peer.test',
      }),
    );

    expect(effect).toMatchObject({
      added: true,
      requestCreated: false,
      threadId: expect.any(Number),
    });
    const directions = await database.db.query.relationshipIntent.findMany({
      where: eq(relationshipIntent.pairId, relationship.pair!.id),
    });
    expect(
      directions.find((row) => row.authorSide === relationship.firstSide),
    ).toMatchObject({ status: 'ACCEPTED', expiresAt: null });
    expect(
      directions.find((row) => row.authorSide === relationship.secondSide),
    ).toMatchObject({ status: 'REQUESTED' });
    expect(
      (await findP2PRelationship(database.db, local.id, peer)).pair,
    ).toMatchObject({ active: true, threadId: effect.threadId });
    const localParticipants = await database.db
      .select({ id: accountThreadState.id })
      .from(accountThreadState)
      .where(eq(accountThreadState.threadId, effect.threadId!));
    expect(localParticipants).toHaveLength(1);
  });

  it('applies a remote revoke without directly changing the local intent', async () => {
    const { local, peer } = await createPair(
      `ar-${Date.now().toString(36).slice(-6)}`,
    );
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000);
    await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'REQUESTED',
        requestedAt,
        expiresAt,
      },
      {
        author: 'peer',
        status: 'REQUESTED',
        requestedAt,
        expiresAt,
      },
    ]);
    const feed = new ClientStateFeedService(database, {
      onStateFeedUpdated: () => undefined,
    } as never);
    const stateFeed = {
      lockOutboundStateFeedNamespacesInTx: async () => undefined,
      writeManyInTx: async () => new Map(),
    };
    const mutations = Object.create(
      FederationRelationshipMutationService.prototype,
    ) as FederationRelationshipMutationService;
    Object.assign(mutations, {
      relationships,
      relationshipIntents,
      stateFeed,
      config: { domain: 'local.test' },
    });
    const reverse = new FederationReverseRevokeService(
      database,
      new DurableTaskQueueService(database),
      mutations,
      feed,
      { emit: () => undefined } as never,
    );
    const consumer = Object.create(
      FederationStateFeedConsumerService.prototype,
    ) as FederationStateFeedConsumerService;
    Object.assign(consumer, {
      relationships,
      relationshipIntents,
      reverseRevokes: reverse,
      stateFeed,
      config: { domain: 'local.test' },
    });
    await database.db.transaction((tx) =>
      consumer.applyPageInTx(tx, peer.domain, peer.namespaceId, {
        items: [
          {
            eventType: 'RELATIONSHIP_INTENT',
            account: peer.account,
            peerAccount: local.account,
            feedId: '1',
            body: {
              status: 'REVOKED',
              profileRev: 1,
              note: '',
              requestedAt: null,
              expiresAt: null,
            },
          },
        ],
        scannedThrough: '1',
        stateFeedEndId: '1',
        hasMore: false,
      }),
    );

    const relationship = await findP2PRelationship(database.db, local.id, peer);
    const intents = await database.db.query.relationshipIntent.findMany({
      where: eq(relationshipIntent.pairId, relationship.pair!.id),
    });
    expect(intents.map((intent) => intent.status).sort()).toEqual([
      'REQUESTED',
      'REVOKED',
    ]);
    expect(
      intents.find((intent) => intent.status === 'REQUESTED')?.expiresAt,
    ).toEqual(expiresAt);
    const task = (await database.db.query.durableTask.findMany()).find(
      (row) =>
        row.payload.operation === 'RESPOND_TO_REVOKE' &&
        row.payload.intentAuthorUserId === local.id,
    )!;
    expect(task).toMatchObject({
      taskType: 'REVOKE_USER_RELATIONSHIP',
      actorUserId: await database.db.transaction(systemAccountIdInTx),
    });
    await database.db
      .update(durableTask)
      .set({ status: 'PROCESSING', startedAt: new Date() })
      .where(eq(durableTask.id, task.id));
    await reverse.execute({ ...task, status: 'PROCESSING' });
    const closed = await database.db.query.relationshipIntent.findMany({
      where: eq(relationshipIntent.pairId, relationship.pair!.id),
    });
    expect(closed.every((intent) => intent.status === 'REVOKED')).toBe(true);
    expect(
      (
        await database.db.query.durableTask.findFirst({
          where: eq(durableTask.id, task.id),
        })
      )?.checkpoint,
    ).toEqual({ reverseRevokeDone: true });
  });

  it('confirms ACCEPTED + REQUESTED without waiting for a second acknowledgement', async () => {
    const { local, peer } = await createPair(
      `ar-${Date.now().toString(36).slice(-6)}`,
    );
    const requestedAt = new Date();
    await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'ACCEPTED',
        requestedAt,
        expiresAt: null,
        updatedAt: requestedAt,
      },
    ]);

    const effect = await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: local.id,
        peerUserId: peer,
        status: 'REQUESTED',
        profileRev: 1,
        note: 'peer request',
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
        origin: 'peer.test',
      }),
    );

    expect(effect).toMatchObject({
      added: true,
      requestCreated: false,
      threadId: expect.any(Number),
    });
    expect(
      (await findP2PRelationship(database.db, local.id, peer)).pair,
    ).toMatchObject({ active: true });
  });

  it('does not confirm an expired request paired with a fresh request', async () => {
    const { local, peer } = await createPair(
      `ec-${Date.now().toString(36).slice(-6)}`,
    );
    const requestedAt = new Date(Date.now() - 120_000);
    await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'REQUESTED',
        note: 'expired',
        requestedAt,
        expiresAt: new Date(Date.now() - 60_000),
        updatedAt: requestedAt,
      },
    ]);
    const remoteRequestedAt = new Date();

    const effect = await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: local.id,
        peerUserId: peer,
        status: 'REQUESTED',
        profileRev: 1,
        note: 'fresh',
        requestedAt: remoteRequestedAt,
        expiresAt: new Date(remoteRequestedAt.getTime() + 24 * 60 * 60 * 1000),
        origin: 'peer.test',
      }),
    );

    expect(effect).toMatchObject({
      requestCreated: true,
    });
    expect(effect.added).toBeUndefined();
    expect(
      (await findP2PRelationship(database.db, local.id, peer)).pair,
    ).toMatchObject({ active: false, threadId: null });
  });

  it('rejects an ACCEPTED database fact without a request timestamp', async () => {
    const { local, peer } = await createPair(
      `ia-${Date.now().toString(36).slice(-6)}`,
    );

    await database.db.transaction((tx) =>
      relationshipIntents.lockPairInTx(tx, local.id, peer),
    );
    const relationship = await findP2PRelationship(database.db, local.id, peer);
    await expect(
      database.db.insert(relationshipIntent).values({
        pairId: relationship.pair!.id,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        authorSide: relationship.firstSide,
        status: 'ACCEPTED',
        requestedAt: null,
        expiresAt: null,
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('confirms FRIEND and removes the TTL when the local request is still valid', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-valid`,
    );
    const relationship = await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'REQUESTED',
        note: 'hello',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    ]);

    const effect = await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: local.id,
        peerUserId: peer,
        status: 'ACCEPTED',
        profileRev: 1,
        note: '',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'peer.test',
      }),
    );

    expect(effect.localStateRevision).toBeDefined();
    const localDirection = await database.db.query.relationshipIntent.findFirst(
      {
        where: and(
          eq(relationshipIntent.pairId, relationship.pair!.id),
          eq(relationshipIntent.authorSide, relationship.firstSide),
        ),
      },
    );
    expect(localDirection).toMatchObject({
      status: 'ACCEPTED',
      expiresAt: null,
    });
  });

  it('completes a peer request that the local direction already accepted', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-final`,
    );
    const requestedAt = new Date();
    const relationship = await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'ACCEPTED',
        requestedAt,
        expiresAt: null,
      },
      {
        author: 'peer',
        status: 'REQUESTED',
        note: 'peer request',
        requestedAt,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    ]);

    const effect = await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: local.id,
        peerUserId: peer,
        status: 'ACCEPTED',
        profileRev: 1,
        note: '',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'peer.test',
      }),
    );

    expect(effect.changed).toBe(true);
    const peerDirection = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.pairId, relationship.pair!.id),
        eq(relationshipIntent.authorSide, relationship.secondSide),
      ),
    });
    expect(peerDirection).toMatchObject({
      status: 'ACCEPTED',
      expiresAt: null,
    });
  });

  it('treats expired requests as absent and refreshes them as a new request', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-expired`,
    );
    const expiredAt = new Date(Date.now() - 60_000);
    const relationship = await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'REQUESTED',
        note: 'old local',
        requestedAt: new Date(Date.now() - 120_000),
        expiresAt: expiredAt,
      },
      {
        author: 'peer',
        status: 'REQUESTED',
        note: 'old peer',
        requestedAt: new Date(Date.now() - 120_000),
        expiresAt: expiredAt,
      },
    ]);

    await database.db.transaction((tx) =>
      relationships.writeLocalP2PIntentInTx(
        tx,
        local.id,
        peer,
        true,
        'new request',
      ),
    );

    const refreshed = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.pairId, relationship.pair!.id),
        eq(relationshipIntent.authorSide, relationship.firstSide),
      ),
    });
    expect(refreshed).toMatchObject({
      status: 'REQUESTED',
      note: 'new request',
    });
    expect(refreshed!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('recreates an expired group invitation even when its note is unchanged', async () => {
    const suffix = `${Date.now().toString(36)}-group`;
    const { local: owner, peer: target } = await createPair(suffix);
    const [groupState] = await database.db
      .insert(group)
      .values({
        account: `!boundary-${suffix}`,
        updatedAt: new Date(),
      })
      .returning({ id: group.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupAccount: `!boundary-${suffix}`,
        groupDomain: 'local',
        groupAccountId: groupState.id,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });

    const firstId = await relationships.createGroupInvite(
      owner.id,
      thread.id,
      target,
      'same note',
    );
    const requestedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await database.db
      .update(relationshipIntent)
      .set({
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
      .where(eq(relationshipIntent.id, BigInt(firstId)));
    const secondId = await relationships.createGroupInvite(
      owner.id,
      thread.id,
      target,
      'same note',
    );

    expect(secondId).toBe(firstId);
    const refreshed = await database.db.query.relationshipIntent.findFirst({
      where: eq(relationshipIntent.id, BigInt(firstId)),
    });
    expect(refreshed).toMatchObject({ status: 'REQUESTED' });
    expect(refreshed!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
