import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localIdentityDomain } from './support/local-domain.js';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  accountThreadState,
  groupMeta,
  groupMetaMemberFeed,
  message,
  profileTable,
  messageThread,
} from '../src/database/schema.js';
import { GroupRole } from '../src/database/enums.js';
import { readCurrentGroupRosterInTx } from '../src/group/meta/current-group-roster.js';
import { readThreadHeadSnapshotInTx } from '../src/federation/federation-thread-head-snapshot.js';
import { GroupService } from '../src/group/group.service.js';
import { GroupMetaFeedService } from '../src/group/meta/group-meta-feed.service.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { seedUser } from './seed.js';

describe('group creation', () => {
  let app: TestingModule;
  let database: DatabaseService;
  let groups: GroupService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = app.get(DatabaseService);
    groups = app.get(GroupService);
  });

  afterAll(async () => app.close());

  it.each([30, 31])(
    'persists creation and rename at %i characters',
    async (length) => {
      const owner = await seedUser(
        app as unknown as INestApplication,
        `name-boundary-${length}`,
      );
      const created = await groups.createNewGroup({
        owner: owner.id,
        name: 'a'.repeat(length),
      });
      await groups.updateGroup({
        threadId: created.threadId,
        operatorUserId: owner.id,
        name: '界'.repeat(length),
      });
      const thread = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, created.threadId),
      });
      const profiles = await database.db
        .select()
        .from(profileTable)
        .where(eq(profileTable.account, thread!.groupAccount!));
      expect(profiles.map((profile) => profile.displayName).sort()).toEqual(
        ['a'.repeat(length), '界'.repeat(length)].sort(),
      );
      await expect(
        groups.updateGroup({
          threadId: created.threadId,
          operatorUserId: owner.id,
          name: 'a'.repeat(32),
        }),
      ).rejects.toMatchObject({
        bizCode: 10000,
        message: 'group name must be at most 31 characters',
      });
    },
  );

  it('publishes and acknowledges announcement coordinates independently of message reads', async () => {
    const owner = await seedUser(
      app as unknown as INestApplication,
      'announcement-owner',
    );
    const created = await groups.createNewGroup({
      owner: owner.id,
      name: 'Notice room',
    });
    const initial = await database.db.query.groupMeta.findFirst({
      where: eq(groupMeta.threadId, created.threadId),
    });
    expect(initial?.announcementFeedId).toBe(1);
    expect(initial?.announcementText).toBeNull();
    const published = await groups.setAnnouncement({
      threadId: created.threadId,
      operatorUserId: owner.id,
      text: 'Welcome',
    });
    const before = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(accountThreadState.threadId, created.threadId),
        eq(accountThreadState.accountId, owner.id),
      ),
    });
    const read = await groups.markAnnouncementRead({
      threadId: created.threadId,
      accountId: owner.id,
      feedId: published.feedId,
    });
    expect(read.announcementReadFeedId).toBe(published.feedId);
    const after = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(accountThreadState.threadId, created.threadId),
        eq(accountThreadState.accountId, owner.id),
      ),
    });
    expect(after?.lastReadSeq).toBe(before?.lastReadSeq);
    expect(after?.unreadCount).toBe(before?.unreadCount);
    expect(after!.threadFeedId).toBeGreaterThan(before!.threadFeedId);
    const edited = await groups.setAnnouncement({
      threadId: created.threadId,
      operatorUserId: owner.id,
      text: 'Updated',
    });
    expect(edited.feedId).toBeGreaterThan(read.announcementReadFeedId);
    await groups.markAnnouncementRead({
      threadId: created.threadId,
      accountId: owner.id,
      feedId: published.feedId,
    });
    const stale = await database.db.query.accountThreadState.findFirst({
      where: and(
        eq(accountThreadState.threadId, created.threadId),
        eq(accountThreadState.accountId, owner.id),
      ),
    });
    expect(stale?.announcementReadFeedId).toBe(published.feedId);
    await expect(
      groups.markAnnouncementRead({
        threadId: created.threadId,
        accountId: owner.id,
        feedId: edited.feedId + 1,
      }),
    ).rejects.toMatchObject({ bizCode: 10000 });
  });

  it('rejects an over-limit creation before accessing the database', async () => {
    await expect(
      groups.createNewGroup({ owner: -1, name: 'a'.repeat(32) }),
    ).rejects.toMatchObject({
      bizCode: 10000,
      message: 'group name must be at most 31 characters',
    });
  });

  it('writes one authority-local creation message without advertising it to federation', async () => {
    const owner = await seedUser(
      app as unknown as INestApplication,
      'group-creation-owner',
    );
    const created = await groups.createNewGroup({
      owner: owner.id,
      name: 'Created group',
    });

    const creation = await database.db.query.message.findFirst({
      where: and(
        eq(message.threadId, created.threadId),
        eq(message.contentType, 'SYSTEM'),
      ),
    });
    expect(creation).toMatchObject({
      seq: 1,
      creatorAccount: '$system',
    });
    expect(JSON.parse(creation!.content)).toEqual({
      type: 'GROUP_CREATED',
      creator: {
        account: owner.account,
        profileNamespaceId: 0,
        profileRev: 1,
      },
    });
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, created.threadId),
        ),
      }),
    ).toMatchObject({ lastReadSeq: 1, unreadCount: 0, threadProfileRev: 1 });
    expect(
      await database.db.transaction((tx) =>
        readThreadHeadSnapshotInTx(tx, created.threadId),
      ),
    ).toEqual({ messageEndSeq: 0, tombstoneEndSeq: 0 });
  });

  it('commits revision zero before setting the profile and notifies only after the new thread feed commits', async () => {
    const owner = await seedUser(
      app as unknown as INestApplication,
      'group-two-transaction-owner',
    );
    const metaService = app.get(GroupMetaFeedService);
    const feedService = app.get(ClientStateFeedService);
    const reconcile = metaService.reconcileProfileInTx.bind(metaService);
    let initialThreadFeedId: number | undefined;
    const notify = vi.spyOn(feedService, 'notifyFeedUpdates');
    const profileWrite = vi
      .spyOn(metaService, 'reconcileProfileInTx')
      .mockImplementation(async (tx, threadId, profileRev) => {
        if (profileRev === 1) {
          // A different connection can see transaction one's committed state,
          // but not transaction two's new profile or thread-feed projection.
          const state = await database.db.query.accountThreadState.findFirst({
            where: and(
              eq(accountThreadState.accountId, owner.id),
              eq(accountThreadState.threadId, threadId),
            ),
          });
          expect(state).toMatchObject({ threadProfileRev: 0 });
          initialThreadFeedId = state!.threadFeedId;
          expect(initialThreadFeedId).toBeGreaterThan(0);
          expect(
            await database.db.query.profileTable.findFirst({
              where: and(
                eq(
                  profileTable.account,
                  (await database.db.query.messageThread.findFirst({
                    where: eq(messageThread.id, threadId),
                  }))!.groupAccount!,
                ),
                eq(profileTable.profileRev, 1),
              ),
            }),
          ).toBeUndefined();
          expect(notify).not.toHaveBeenCalled();
        }
        return reconcile(tx, threadId, profileRev);
      });
    try {
      const created = await groups.createNewGroup({
        owner: owner.id,
        name: 'Two transaction group',
      });
      expect(initialThreadFeedId).toBeDefined();
      const state = await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, created.threadId),
        ),
      });
      expect(state).toMatchObject({ threadProfileRev: 1 });
      expect(state!.threadFeedId).toBeGreaterThan(initialThreadFeedId!);
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            userId: owner.id,
            threadFeedEndId: state!.threadFeedId,
          }),
        ]),
      );
    } finally {
      profileWrite.mockRestore();
      notify.mockRestore();
    }
  });

  it('serializes profile creation with a concurrent announcement acknowledgement without deadlocking', async () => {
    const owner = await seedUser(
      app as unknown as INestApplication,
      'group-creation-concurrent-owner',
    );
    const intents = app.get(RelationshipIntentService);
    const feed = app.get(ClientStateFeedService);
    const lock = intents.lockGroupMutationInTx.bind(intents);
    let signalLocked!: (value: { threadId: number; pid: number }) => void;
    const participantLocked = new Promise<{ threadId: number; pid: number }>(
      (resolve) => {
        signalLocked = resolve;
      },
    );
    let releaseProfile!: () => void;
    const resumeProfile = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    let initialThreadFeedId = 0;
    const lockSpy = vi
      .spyOn(intents, 'lockGroupMutationInTx')
      .mockImplementation(async (tx, params) => {
        const result = await lock(tx, params);
        if (params.feedAllocatorUserIds?.includes(owner.id)) {
          const backend = await tx.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          const state = await tx.query.accountThreadState.findFirst({
            where: and(
              eq(accountThreadState.accountId, owner.id),
              eq(accountThreadState.threadId, params.threadId),
            ),
          });
          expect(state).toMatchObject({ threadProfileRev: 0 });
          initialThreadFeedId = state!.threadFeedId;
          signalLocked({ threadId: params.threadId, pid: backend.rows[0].pid });
          await resumeProfile;
        }
        return result;
      });
    const committedStates: Promise<
      typeof accountThreadState.$inferSelect | undefined
    >[] = [];
    const notify = vi
      .spyOn(feed, 'notifyFeedUpdates')
      .mockImplementation(() => {
        committedStates.push(
          database.db.query.accountThreadState.findFirst({
            where: eq(accountThreadState.accountId, owner.id),
          }),
        );
      });
    const creation = groups.createNewGroup({
      owner: owner.id,
      name: 'Concurrent group',
    });
    // Observe rejections immediately while the other operation is blocked.
    void creation.catch(() => undefined);
    let acknowledgement:
      | ReturnType<GroupService['markAnnouncementRead']>
      | undefined;
    try {
      const { threadId, pid } = await Promise.race([
        participantLocked,
        creation.then(() => {
          throw new Error('creation missed the participant barrier');
        }),
      ]);
      acknowledgement = groups.markAnnouncementRead({
        threadId,
        accountId: owner.id,
        feedId: 1,
      });
      void acknowledgement.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const blocked = await database.db.execute<{ pid: number }>(sql`
          SELECT pid FROM pg_stat_activity
          WHERE ${pid} = ANY(pg_blocking_pids(pid))
        `);
          expect(blocked.rows.length).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 20 },
      );
      expect(notify).not.toHaveBeenCalled();
      releaseProfile();
      const [created, ack] = await Promise.all([creation, acknowledgement]);
      expect(ack).toEqual({ announcementReadFeedId: 1 });
      const state = await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, created.threadId),
        ),
      });
      expect(state).toMatchObject({
        threadProfileRev: 1,
        announcementReadFeedId: 1,
      });
      expect(state!.threadFeedId).toBeGreaterThan(initialThreadFeedId);
      expect(notify).toHaveBeenCalledOnce();
      expect(await committedStates[0]).toMatchObject({ threadProfileRev: 1 });
    } finally {
      releaseProfile();
      await Promise.allSettled([
        creation,
        ...(acknowledgement ? [acknowledgement] : []),
      ]);
      lockSpy.mockRestore();
      notify.mockRestore();
    }
  }, 20_000);

  it('publishes the creator as the first OWNER in the authoritative Group Meta roster', async () => {
    const owner = await seedUser(
      app as unknown as INestApplication,
      'group-creation-roster-owner',
    );
    const created = await groups.createNewGroup({
      owner: owner.id,
      name: 'Roster group',
    });

    const [meta] = await database.db
      .select({ metaEndId: groupMeta.metaEndId })
      .from(groupMeta)
      .where(eq(groupMeta.threadId, created.threadId));
    const facts = await database.db
      .select({
        feedId: groupMetaMemberFeed.feedId,
        operation: groupMetaMemberFeed.operation,
        body: groupMetaMemberFeed.body,
      })
      .from(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, created.threadId));

    expect(meta?.metaEndId).toBeGreaterThan(0);
    expect(facts).toHaveLength(2);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'GROUP_PROFILE' }),
        expect.objectContaining({
          operation: 'MEMBER_UPSERT',
          body: {
            account: owner.account,
            namespaceId: 0,
            role: GroupRole.OWNER,
            profileRev: 1,
          },
        }),
      ]),
    );
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, created.threadId),
        ),
      }),
    ).toMatchObject({ groupMetaFeedEndId: meta?.metaEndId });
    await expect(
      database.db.transaction((tx) =>
        readCurrentGroupRosterInTx(tx, created.threadId),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        account: owner.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
        role: GroupRole.OWNER,
      }),
    ]);
  });
});
