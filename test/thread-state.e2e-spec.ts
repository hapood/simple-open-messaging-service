import { UserService } from '../src/user/user.service.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, or, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { ThreadFeedService } from '../src/message/thread-feed.service.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { ProfileResolutionCoordinatorService } from '../src/profile-resolution/profile-resolution-coordinator.service.js';
import { ProfileLookup } from '../src/profile-resolution/profile-resolution-demand.js';
import { BusinessCode } from '../src/common/business-code.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { resolveAuthorizedFederationThreadInTx } from '../src/federation/federation-thread-query-authorization.js';

describe('account-owned THREAD_STATE and default profiles', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let counter = 0;
  const resolver = () =>
    new ProfileResolutionCoordinatorService(
      database,
      new FederationProfileService(database, {} as never, {} as never),
      { onProfileResolved: vi.fn(), onProfileFailed: vi.fn() } as never,
    );
  const feed = () => new ThreadFeedService(database);
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });
  afterAll(async () => mod.close());

  it('does not return an account fallback as an unresolved self profile', async () => {
    const [owner] = await database.db
      .insert(tables.account)
      .values({
        account: 'self-profile-unresolved',
        defaultProfileRev: 9,
      })
      .returning();
    const users = new UserService(database);
    expect(await users.findSelfProfile(owner.id)).toBeNull();
    await database.db.insert(tables.profileTable).values({
      account: owner.account,
      domain: 'local',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 9,
      displayName: 'Resolved self',
      avatar: '',
      bio: 'Complete',
    });
    expect(await users.findSelfProfile(owner.id)).toMatchObject({
      name: 'Resolved self',
      defaultProfileRev: 9,
      bio: 'Complete',
    });
  });

  async function fixture(foreign = false) {
    const id = ++counter;
    const domain = foreign ? `profile-${id}.test` : 'local';
    const namespaceId = foreign
      ? await seedFederatedPeerNamespace(database.db, domain)
      : 0;
    const [owner] = await database.db
      .insert(tables.account)
      .values({ account: `viewer-${id}` })
      .returning();
    const target = `target-${id}`;
    if (!foreign)
      await database.db
        .insert(tables.account)
        .values({ account: target, defaultProfileRev: 7 });
    await database.db.insert(tables.profileTable).values({
      account: target,
      domain,
      publisherNamespaceId: namespaceId,
      profileNamespaceId: namespaceId,
      profileRev: 7,
      displayName: 'Disclosed profile',
    });
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'P2P',
        authorityNamespaceId: namespaceId,
        updatedAt: new Date(),
      })
      .returning();
    const [pair] = await database.db
      .insert(tables.relationshipPair)
      .values({
        kind: 'P2P',
        threadId: thread.id,
        active: false,
        endpointAType: 'USER',
        endpointAAccount: owner.account,
        endpointANamespaceId: 0,
        endpointBType: 'USER',
        endpointBAccount: target,
        endpointBNamespaceId: namespaceId,
      })
      .returning();
    await database.db.insert(tables.relationshipIntent).values([
      {
        authorAccount: owner.account,
        authorNamespaceId: 0,
        receiverAccount: target,
        receiverNamespaceId: namespaceId,
        status: 'REVOKED' as const,
        profileNamespaceId: 0,
        profileRev: 0,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        requestedAt: new Date(),
        expiresAt: null,
      },
      {
        authorAccount: target,
        authorNamespaceId: namespaceId,
        receiverAccount: owner.account,
        receiverNamespaceId: 0,
        status: 'REVOKED' as const,
        profileNamespaceId: namespaceId,
        profileRev: 7,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        requestedAt: new Date(),
        expiresAt: null,
      },
    ]);
    await database.db
      .insert(tables.accountThreadState)
      .values({ accountId: owner.id, threadId: thread.id });
    const activate = () =>
      database.db.transaction(async (tx) => {
        await tx
          .update(tables.relationshipIntent)
          .set({ status: 'ACCEPTED' })
          .where(
            or(
              and(
                eq(tables.relationshipIntent.authorAccount, owner.account),
                eq(tables.relationshipIntent.authorNamespaceId, 0),
                eq(tables.relationshipIntent.receiverAccount, target),
                eq(tables.relationshipIntent.receiverNamespaceId, namespaceId),
              ),
              and(
                eq(tables.relationshipIntent.authorAccount, target),
                eq(tables.relationshipIntent.authorNamespaceId, namespaceId),
                eq(tables.relationshipIntent.receiverAccount, owner.account),
                eq(tables.relationshipIntent.receiverNamespaceId, 0),
              ),
            ),
          );
        await tx
          .update(tables.relationshipPair)
          .set({ active: true, established: true })
          .where(eq(tables.relationshipPair.id, pair.id));
      });
    const snapshot = async () =>
      (await feed().queryThreadFeedDelta(owner.id, { after: 0 })).items.find(
        (item) => item.threadId === thread.id,
      );
    return {
      owner,
      thread,
      pair,
      activate,
      snapshot,
      target,
      domain,
      namespaceId,
    };
  }

  it('publishes participant state while a concurrent foreign-key holder remains open', async () => {
    const f = await fixture();
    await f.activate();
    await database.db
      .delete(tables.accountThreadState)
      .where(eq(tables.accountThreadState.threadId, f.thread.id));
    const foreignKeyWriter = await database.pool.connect();
    try {
      await foreignKeyWriter.query('BEGIN');
      await foreignKeyWriter.query(
        `
        INSERT INTO "UserQuotaDailyUsage" ("userId", date, category, count)
        VALUES ($1, CURRENT_DATE, 'requests', 1)
      `,
        [f.owner.id],
      );
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
        await tx
          .insert(tables.accountThreadState)
          .values({ accountId: f.owner.id, threadId: f.thread.id });
      });
      // The foreign-key holder can subsequently update the same parent without a cycle.
      await foreignKeyWriter.query(
        `UPDATE "Account"
        SET "clientStateFeedEndId" = "clientStateFeedEndId" + 1 WHERE id = $1`,
        [f.owner.id],
      );
      expect((await f.snapshot())?.conversationState).toBe('ACTIVE');
    } finally {
      await foreignKeyWriter.query('ROLLBACK');
      foreignKeyWriter.release();
    }
  });

  it.each(['revocation', 'thread deletion'] as const)(
    'reads an authorized snapshot without waiting for concurrent %s',
    async (change) => {
      const f = await fixture(true);
      await f.activate();
      const revocation = await database.pool.connect();
      try {
        await revocation.query('BEGIN');
        if (change === 'revocation') {
          await revocation.query(
            `UPDATE "RelationshipIntent" SET status = 'REVOKED'
          WHERE "authorAccount" = $1 AND "authorNamespaceId" = 0
            AND "receiverAccount" = $2 AND "receiverNamespaceId" = $3`,
            [f.owner.account, f.target, f.namespaceId],
          );
        } else {
          await revocation.query(
            'DELETE FROM "AccountThreadState" WHERE "threadId" = $1',
            [f.thread.id],
          );
          await revocation.query('DELETE FROM "MessageThread" WHERE id = $1', [
            f.thread.id,
          ]);
        }
        await database.db.transaction(
          async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
            const authorized = await resolveAuthorizedFederationThreadInTx(
              tx,
              f.domain,
              f.namespaceId,
              { type: 'P2P', account: f.owner.account, peerAccount: f.target },
            );
            expect(authorized.threadId).toBe(f.thread.id);
            await revocation.query('COMMIT');
            // A page keeps one authorization/data snapshot even after the writer commits.
            const samePage = await resolveAuthorizedFederationThreadInTx(
              tx,
              f.domain,
              f.namespaceId,
              { type: 'P2P', account: f.owner.account, peerAccount: f.target },
            );
            expect(samePage.threadId).toBe(f.thread.id);
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
        await expect(
          database.db.transaction(
            (tx) =>
              resolveAuthorizedFederationThreadInTx(
                tx,
                f.domain,
                f.namespaceId,
                {
                  type: 'P2P',
                  account: f.owner.account,
                  peerAccount: f.target,
                },
              ),
            { isolationLevel: 'repeatable read', accessMode: 'read only' },
          ),
        ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
      } finally {
        await revocation.query('ROLLBACK');
        revocation.release();
      }
    },
  );

  it('does not authorize request shells; establishment and its snapshot roll back together', async () => {
    const f = await fixture();
    expect(await f.snapshot()).toBeUndefined();
    await expect(
      resolver().start(f.owner.id, 1, {
        publisherNamespaceId: f.namespaceId,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target: {
          profileNamespaceId: f.namespaceId,
          account: f.target,
          domain: f.domain,
          rev: 7,
        },
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    await expect(
      database.db.transaction(async (tx) => {
        await tx
          .update(tables.relationshipPair)
          .set({ active: true, established: true })
          .where(eq(tables.relationshipPair.id, f.pair.id));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await f.snapshot()).toBeUndefined();
    await f.activate();
    expect(await f.snapshot()).toMatchObject({
      conversationState: 'ACTIVE',
      profile: { profileRev: 7 },
    });
  });

  it.each([false, true])(
    'retains the exact disclosed profile after revoke and intent replacement (foreign=%s)',
    async (foreign) => {
      const f = await fixture(foreign);
      await f.activate();
      const coordinator = resolver();
      const selector = {
        publisherNamespaceId: f.namespaceId,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target: {
          profileNamespaceId: f.namespaceId,
          account: f.target,
          domain: f.domain,
          rev: 7,
        },
      };
      await expect(
        coordinator.start(f.owner.id, 1, selector),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 7, namespaceId: f.namespaceId },
      });
      await expect(
        coordinator.start(f.owner.id + 100000, 1, selector),
      ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
      await database.db
        .update(tables.relationshipPair)
        .set({ active: false })
        .where(eq(tables.relationshipPair.id, f.pair.id));
      await database.db
        .update(tables.relationshipIntent)
        .set({ status: 'REVOKED', expiresAt: null, profileRev: 99 })
        .where(
          or(
            and(
              eq(tables.relationshipIntent.authorAccount, f.owner.account),
              eq(tables.relationshipIntent.authorNamespaceId, 0),
              eq(tables.relationshipIntent.receiverAccount, f.target),
              eq(tables.relationshipIntent.receiverNamespaceId, f.namespaceId),
            ),
            and(
              eq(tables.relationshipIntent.authorAccount, f.target),
              eq(tables.relationshipIntent.authorNamespaceId, f.namespaceId),
              eq(tables.relationshipIntent.receiverAccount, f.owner.account),
              eq(tables.relationshipIntent.receiverNamespaceId, 0),
            ),
          ),
        );
      expect(await f.snapshot()).toMatchObject({
        conversationState: 'READ_ONLY',
        profile: { profileRev: 7 },
      });
      await expect(
        resolver().start(f.owner.id, 1, selector),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 7, name: 'Disclosed profile' },
      });
    },
  );

  it('preserves the establishment revision through blocking and ordinary profile updates', async () => {
    const f = await fixture();
    await f.activate();
    const first = await f.snapshot();
    await database.db
      .update(tables.accountThreadState)
      .set({ blocked: true })
      .where(eq(tables.accountThreadState.threadId, f.thread.id));
    const blocked = await f.snapshot();
    expect(blocked!.threadFeedId).toBeGreaterThan(first!.threadFeedId);
    expect(blocked).toEqual({
      ...first,
      blocked: true,
      threadFeedId: blocked!.threadFeedId,
    });
    await database.db.insert(tables.profileTable).values({
      account: f.target,
      domain: 'local',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 8,
      displayName: 'Updated',
      avatar: '',
      bio: '',
    });
    await database.db
      .update(tables.account)
      .set({ defaultProfileRev: 8 })
      .where(eq(tables.account.account, f.target));
    expect(await f.snapshot()).toMatchObject({
      profile: { profileRev: 7 },
    });
    await database.db
      .update(tables.accountThreadState)
      .set({ blocked: false })
      .where(eq(tables.accountThreadState.threadId, f.thread.id));
    const current = await f.snapshot();
    const all = await feed().queryThreadFeedDelta(f.owner.id, {
      after: blocked!.threadFeedId,
    });
    expect(all.items).toContainEqual(
      expect.objectContaining({
        threadId: f.thread.id,
        blocked: false,
        threadFeedId: current!.threadFeedId,
      }),
    );
  });
  it('changes the grant only on re-establishment and rejects other revisions even after a cache hit', async () => {
    const f = await fixture();
    await f.activate();
    const first = await f.snapshot();
    const coordinator = resolver();
    const exact = {
      publisherNamespaceId: f.namespaceId,
      lookup: ProfileLookup.ACCOUNT_PROFILE,
      target: {
        profileNamespaceId: f.namespaceId,
        account: f.target,
        domain: f.domain,
        rev: 7,
      },
    };
    await coordinator.start(f.owner.id, 1, exact);
    await database.db
      .update(tables.relationshipPair)
      .set({ active: false })
      .where(eq(tables.relationshipPair.id, f.pair.id));
    await database.db
      .update(tables.relationshipIntent)
      .set({ status: 'REVOKED', profileRev: 8 })
      .where(
        and(
          eq(tables.relationshipIntent.authorAccount, f.owner.account),
          eq(tables.relationshipIntent.authorNamespaceId, 0),
          eq(tables.relationshipIntent.receiverAccount, f.target),
          eq(tables.relationshipIntent.receiverNamespaceId, f.namespaceId),
        ),
      );
    await database.db.insert(tables.profileTable).values({
      account: f.target,
      domain: f.domain,
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 8,
      displayName: 'New establishment',
    });
    await expect(
      coordinator.start(f.owner.id, 1, {
        ...exact,
        target: { ...exact.target, rev: 8 },
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    await f.activate();
    const second = await f.snapshot();
    expect(second?.profile.profileRev).toBe(8);
    expect(second!.threadFeedId).toBeGreaterThan(first!.threadFeedId);
    await expect(coordinator.start(f.owner.id, 1, exact)).rejects.toMatchObject(
      {
        bizCode: BusinessCode.NOT_FOUND,
      },
    );
    await expect(
      coordinator.start(f.owner.id, 1, {
        ...exact,
        target: { ...exact.target, rev: 8 },
      }),
    ).resolves.toMatchObject({ status: 'READY', profile: { rev: 8 } });
  });

  it('re-establishes a retained P2P state from the new intent even when its revision is lower', async () => {
    const f = await fixture();
    await f.activate();
    const first = await f.snapshot();
    expect(first?.profile.profileRev).toBe(7);

    await database.db
      .update(tables.relationshipPair)
      .set({ active: false })
      .where(eq(tables.relationshipPair.id, f.pair.id));
    await database.db
      .update(tables.relationshipIntent)
      .set({ status: 'REVOKED', profileRev: 5 })
      .where(
        and(
          eq(tables.relationshipIntent.authorAccount, f.target),
          eq(tables.relationshipIntent.authorNamespaceId, f.namespaceId),
          eq(tables.relationshipIntent.receiverAccount, f.owner.account),
          eq(tables.relationshipIntent.receiverNamespaceId, 0),
        ),
      );
    await f.activate();

    const reestablished = await f.snapshot();
    expect(reestablished).toMatchObject({
      conversationState: 'ACTIVE',
      profile: { profileRev: 5 },
    });
    expect(reestablished!.threadFeedId).toBeGreaterThan(first!.threadFeedId);
  });
});
