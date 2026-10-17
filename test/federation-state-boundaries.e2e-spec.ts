import { FederationStateFeedConsumerService } from '../src/federation/federation-state-feed-consumer.service.js';
import { FederationThreadSyncStateService } from '../src/federation/federation-thread-sync-state.service.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import type { AccountSubjectAddress } from '../src/user/account-address.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, or, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageThreadType } from '../src/database/enums.js';
import {
  account,
  relationshipPair as relationshipPairTable,
  relationshipIntent,
  federationThreadSyncState,
  federationThreadHistoryGap,
  groupAccount as group,
  messageThread,
  accountThreadState,
} from '../src/database/schema.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { UserIntentService } from '../src/user/p2p-intent/authored/user-intent.service.js';
import { findP2PRelationship, seedFederatedPeerNamespace } from './seed.js';

describe('federation directed-state boundaries', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  function p2pIntentFilter(
    local: { account: string; namespaceId: number },
    peer: { account: string; namespaceId: number },
  ) {
    return or(
      and(
        eq(relationshipIntent.authorAccount, local.account),
        eq(relationshipIntent.authorNamespaceId, local.namespaceId),
        eq(relationshipIntent.receiverAccount, peer.account),
        eq(relationshipIntent.receiverNamespaceId, peer.namespaceId),
      ),
      and(
        eq(relationshipIntent.authorAccount, peer.account),
        eq(relationshipIntent.authorNamespaceId, peer.namespaceId),
        eq(relationshipIntent.receiverAccount, local.account),
        eq(relationshipIntent.receiverNamespaceId, local.namespaceId),
      ),
    );
  }

  let relationshipIntents: RelationshipIntentService;
  let userIntents: UserIntentService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    database = mod.get(DatabaseService);
    // Compile the real dependency graph without starting schedulers or listeners.
    relationshipIntents = mod.get(RelationshipIntentService);
    userIntents = mod.get(UserIntentService);
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
    peerId: AccountSubjectAddress,
    rows: Array<{
      author: 'local' | 'peer';
      status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
      note?: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
      updatedAt?: Date;
      messageEndSeq?: number;
      tombstoneEndSeq?: number;
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
    const localIdentity = await database.db.query.account.findFirst({
      where: eq(account.id, localId),
      columns: { account: true, namespaceId: true },
    });
    await database.db.insert(relationshipIntent).values(
      rows.map((row) => ({
        authorAccount:
          row.author === 'local' ? localIdentity!.account : peerId.account,
        authorNamespaceId: row.author === 'local' ? 0 : peerId.namespaceId,
        receiverAccount:
          row.author === 'local' ? peerId.account : localIdentity!.account,
        receiverNamespaceId: row.author === 'local' ? peerId.namespaceId : 0,
        profileNamespaceId: 0,
        profileRev: 0,
        status: row.status,
        messageEndSeq: row.messageEndSeq ?? 0,
        tombstoneEndSeq: row.tombstoneEndSeq ?? 0,
        note: row.note ?? '',
        requestedAt: row.requestedAt,
        expiresAt: row.expiresAt,
        updatedAt: row.updatedAt ?? new Date(),
      })),
    );
    return relationship;
  }

  /** Every production path that authors an ACCEPTED direction also mints the
   * retained P2P shell; raw SQL seeds skip it, so revocation-route tests
   * restore the invariant explicitly. */
  async function seedThreadShell(localId: number, peer: AccountSubjectAddress) {
    const relationship = await findP2PRelationship(database.db, localId, peer);
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.P2P,
        authorityNamespaceId: peer.namespaceId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    await database.db
      .update(relationshipPairTable)
      .set({ threadId: thread.id, updatedAt: new Date() })
      .where(eq(relationshipPairTable.id, relationship.pair!.id));
    await database.db
      .insert(accountThreadState)
      .values({ accountId: localId, threadId: thread.id });
    return thread.id;
  }

  it.each([0, 12])(
    'initializes the retained remote grant (%i messages) atomically on local acceptance',
    async (end) => {
      const { local, peer } = await createPair(`grant-${end}`);
      await seedIntents(local.id, peer, [
        {
          author: 'peer',
          status: 'REQUESTED',
          requestedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          messageEndSeq: end,
          tombstoneEndSeq: end === 0 ? 0 : 4,
        },
      ]);
      // Scope assertions to the new pair, since this suite preserves other cases.
      let activatedThreadId = 0;
      const activate = async (
        tx: Parameters<Parameters<typeof database.db.transaction>[0]>[0],
      ) => {
        await userIntents.executeInTx(
          tx,
          {
            userId: local.id,
            decision: 'REQUESTED',
            target: {
              account: peer.account,
              namespaceId: peer.namespaceId,
            },
          },
          [],
        );
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
    const _relationship = await seedIntents(local.id, peer, [
      {
        author: 'peer',
        status: 'REQUESTED',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const localRow = await database.db.query.account.findFirst({
      where: eq(account.id, local.id),
      columns: { account: true, namespaceId: true },
    });
    await expect(
      database.db.execute(sql`
      UPDATE "RelationshipIntent" SET "messageEndSeq" = NULL, "tombstoneEndSeq" = NULL
      WHERE ("authorAccount" = ${localRow!.account} AND "authorNamespaceId" = 0
          AND "receiverAccount" = ${peer.account} AND "receiverNamespaceId" = ${peer.namespaceId})
        OR ("authorAccount" = ${peer.account} AND "authorNamespaceId" = ${peer.namespaceId}
          AND "receiverAccount" = ${localRow!.account} AND "receiverNamespaceId" = 0)
    `),
    ).rejects.toThrow();
    const stored = await database.db.query.relationshipIntent.findFirst({
      where: p2pIntentFilter(localRow!, peer),
    });
    expect(stored).toMatchObject({ messageEndSeq: 0, tombstoneEndSeq: 0 });
    await database.db.transaction((tx) =>
      userIntents.executeInTx(
        tx,
        {
          userId: local.id,
          decision: 'REQUESTED',
          target: {
            account: peer.account,
            namespaceId: peer.namespaceId,
          },
        },
        [],
      ),
    );
    expect(
      (await findP2PRelationship(database.db, local.id, peer)).pair?.active,
    ).toBe(true);
  });

  it('applies a remote revoke and concludes the local intent atomically', async () => {
    const { local, peer } = await createPair(
      `ar-${Date.now().toString(36).slice(-6)}`,
    );
    // Dangling acceptance: the local side consented and the pair never activated.
    // Receiving the peer REVOKED concludes both authored directions in one transaction.
    const requestedAt = new Date();
    await seedIntents(local.id, peer, [
      {
        author: 'local',
        status: 'ACCEPTED',
        requestedAt,
        expiresAt: null,
      },
      {
        author: 'peer',
        status: 'REQUESTED',
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
      },
    ]);
    await seedThreadShell(local.id, peer);
    const consumer = mod.get(FederationStateFeedConsumerService);
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
              namespaceId: 0,
              profileRev: 1,
              note: '',
              requestedAt: null,
              expiresAt: null,
            },
          },
        ],
        scannedThrough: '1',
        stateFeedEndId: '1',
        profileNamespaceFeedEndId: '0',
        hasMore: false,
      }),
    );

    const revokedLocal = await database.db.query.account.findFirst({
      where: eq(account.id, local.id),
      columns: { account: true, namespaceId: true },
    });
    const intents = await database.db.query.relationshipIntent.findMany({
      where: p2pIntentFilter(revokedLocal!, peer),
    });
    expect(intents.every((intent) => intent.status === 'REVOKED')).toBe(true);
  });

  it('treats expired requests as absent and refreshes them as a new request', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-expired`,
    );
    const expiredAt = new Date(Date.now() - 60_000);
    const _relationship = await seedIntents(local.id, peer, [
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
      userIntents.executeInTx(
        tx,
        {
          userId: local.id,
          decision: 'REQUESTED',
          target: {
            account: peer.account,
            namespaceId: peer.namespaceId,
          },
          note: 'new request',
        },
        [],
      ),
    );

    const refreshedLocal = await database.db.query.account.findFirst({
      where: eq(account.id, local.id),
      columns: { account: true, namespaceId: true },
    });
    const refreshed = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorAccount, refreshedLocal!.account),
        eq(relationshipIntent.authorNamespaceId, 0),
        eq(relationshipIntent.receiverAccount, peer.account),
        eq(relationshipIntent.receiverNamespaceId, peer.namespaceId),
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
    const { local: _owner, peer: target } = await createPair(suffix);
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

    const inviteDirection = {
      authorAccount: `!boundary-${suffix}`,
      authorNamespaceId: 0,
      receiverAccount: target.account,
      receiverNamespaceId: target.namespaceId,
    };
    const inviteRow = () =>
      database.db.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorAccount, inviteDirection.authorAccount),
          eq(relationshipIntent.authorNamespaceId, 0),
          eq(
            relationshipIntent.receiverAccount,
            inviteDirection.receiverAccount,
          ),
          eq(
            relationshipIntent.receiverNamespaceId,
            inviteDirection.receiverNamespaceId,
          ),
        ),
      });
    const writeInvite = () =>
      database.db.transaction((tx) =>
        relationshipIntents.writeGroupAuthoredIntentInTx(tx, {
          groupId: thread.id,
          memberUserId: target,
          threadId: thread.id,
          author: 'GROUP',
          status: 'REQUESTED',
          note: 'same note',
        }),
      );

    // A just-created group cannot be dissolved, so the invite row is present.
    await writeInvite();
    const first = await inviteRow();
    expect(first).toBeDefined();
    const requestedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await database.db
      .update(relationshipIntent)
      .set({
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
      .where(
        and(
          eq(relationshipIntent.authorAccount, inviteDirection.authorAccount),
          eq(relationshipIntent.authorNamespaceId, 0),
          eq(
            relationshipIntent.receiverAccount,
            inviteDirection.receiverAccount,
          ),
          eq(
            relationshipIntent.receiverNamespaceId,
            inviteDirection.receiverNamespaceId,
          ),
        ),
      );
    await writeInvite();

    // Refreshing reuses the single invitation row rather than creating one.
    const rows = await database.db.query.relationshipIntent.findMany({
      where: and(
        eq(relationshipIntent.authorAccount, inviteDirection.authorAccount),
        eq(relationshipIntent.authorNamespaceId, 0),
        eq(relationshipIntent.receiverAccount, inviteDirection.receiverAccount),
        eq(
          relationshipIntent.receiverNamespaceId,
          inviteDirection.receiverNamespaceId,
        ),
      ),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'REQUESTED' });
    expect(rows[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
