import type { ThreadStateSnapshot } from '../shared/thread-state.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { ProfileResolutionCoordinatorService } from '../src/federation/profile-resolution-coordinator.service.js';
import { BusinessCode } from '../src/common/business-code.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { resolveAuthorizedFederationThreadInTx } from '../src/federation/federation-thread-query-authorization.js';

describe('account-owned THREAD_STATE and default profiles', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let counter = 0;
  const peerHttp = { get: vi.fn() };
  const resolver = () =>
    new ProfileResolutionCoordinatorService(
      database,
      peerHttp as never,
      new FederationProfileService(database, {} as never, {} as never),
      {} as never,
      { onProfileResolved: vi.fn(), onProfileFailed: vi.fn() } as never,
    );
  const feed = () => new ClientStateFeedService(database, {} as never);
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });
  afterAll(async () => mod.close());

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
      namespaceId,
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
        endpointADomain: 'local',
        endpointANamespaceId: namespaceId,
        endpointBType: 'USER',
        endpointBAccount: target,
        endpointBDomain: domain,
        endpointBNamespaceId: namespaceId,
      })
      .returning();
    await database.db.insert(tables.relationshipIntent).values(
      ['A', 'B'].map((authorSide) => ({
        pairId: pair.id,
        authorSide,
        status: 'REVOKED' as const,
        profileRev: authorSide === 'B' ? 7 : 0,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        requestedAt: new Date(),
        expiresAt: null,
      })),
    );
    await database.db
      .insert(tables.accountThreadState)
      .values({ accountId: owner.id, threadId: thread.id });
    const activate = () =>
      database.db.transaction(async (tx) => {
        await tx
          .update(tables.relationshipIntent)
          .set({ status: 'ACCEPTED' })
          .where(eq(tables.relationshipIntent.pairId, pair.id));
        await tx
          .update(tables.relationshipPair)
          .set({ active: true })
          .where(eq(tables.relationshipPair.id, pair.id));
      });
    const snapshot = async () =>
      (
        await database.db.execute<{
          body: ThreadStateSnapshot;
          feedId: number;
        }>(sql`
      SELECT body, "feedId" FROM "ClientStateFeed" WHERE "userId" = ${owner.id}
        AND "eventType" = 'THREAD_STATE' AND "subjectAccount" = ${String(thread.id)}
    `)
      ).rows[0];
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
        SET "stateFeedAllocatedThrough" = "stateFeedAllocatedThrough" + 1 WHERE id = $1`,
        [f.owner.id],
      );
      expect((await f.snapshot()).body.conversationState).toBe('ACTIVE');
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
          WHERE "pairId" = $1 AND "authorSide" = 'A'`,
            [f.pair.id.toString()],
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
      resolver().start(f.owner.id, {
        type: 'EXACT',
        account: f.target,
        domain: f.domain,
        rev: 7,
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    await expect(
      database.db.transaction(async (tx) => {
        await tx
          .update(tables.relationshipPair)
          .set({ active: true })
          .where(eq(tables.relationshipPair.id, f.pair.id));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await f.snapshot()).toBeUndefined();
    await f.activate();
    expect((await f.snapshot()).body).toMatchObject({
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
        type: 'EXACT' as const,
        account: f.target,
        domain: f.domain,
        rev: 7,
      };
      await expect(
        coordinator.start(f.owner.id, selector),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 7, namespaceId: f.namespaceId },
      });
      await expect(
        coordinator.start(f.owner.id + 100000, selector),
      ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
      await database.db
        .update(tables.relationshipPair)
        .set({ active: false })
        .where(eq(tables.relationshipPair.id, f.pair.id));
      await database.db
        .update(tables.relationshipIntent)
        .set({ status: 'REVOKED', expiresAt: null, profileRev: 99 })
        .where(eq(tables.relationshipIntent.pairId, f.pair.id));
      expect((await f.snapshot()).body).toMatchObject({
        conversationState: 'READ_ONLY',
        profile: { profileRev: 7 },
      });
      await expect(
        resolver().start(f.owner.id, selector),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 7, name: 'Disclosed profile' },
      });
      expect(peerHttp.get).not.toHaveBeenCalled();
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
    expect(blocked.feedId).toBeGreaterThan(first.feedId);
    expect(blocked.body).toEqual({ ...first.body, blocked: true });
    await database.db.transaction((tx) =>
      feed().writeInTx(tx, {
        userId: f.owner.id,
        eventType: 'PROFILE',
        account: f.target,
        domain: 'local',
        namespaceId: 0,
        subjectAccount: '',
        subjectDomain: 'local',
        body: { profileRev: 8, displayName: 'Updated', bio: '', avatar: null },
      }),
    );
    expect((await f.snapshot()).body).toMatchObject({
      establishedAt: first.body.establishedAt,
      profile: { profileRev: 7 },
    });
    await database.db
      .update(tables.accountThreadState)
      .set({ blocked: false })
      .where(eq(tables.accountThreadState.threadId, f.thread.id));
    const current = await f.snapshot();
    const all = await feed().query(f.owner.id, 'full', 0, current.feedId);
    expect(
      all.some(
        (item) =>
          item.eventType === 'THREAD_STATE' &&
          (item.body as Record<string, unknown>).blocked === false,
      ),
    ).toBe(true);
  });
  it('changes the grant only on re-establishment and rejects other revisions even after a cache hit', async () => {
    const f = await fixture();
    await f.activate();
    const first = await f.snapshot();
    const coordinator = resolver();
    const exact = {
      type: 'EXACT' as const,
      account: f.target,
      domain: f.domain,
      rev: 7,
    };
    await coordinator.start(f.owner.id, exact);
    await database.db
      .update(tables.relationshipPair)
      .set({ active: false })
      .where(eq(tables.relationshipPair.id, f.pair.id));
    await database.db
      .update(tables.relationshipIntent)
      .set({ status: 'REVOKED', profileRev: 8 })
      .where(eq(tables.relationshipIntent.pairId, f.pair.id));
    await database.db.insert(tables.profileTable).values({
      account: f.target,
      domain: f.domain,
      namespaceId: 0,
      profileRev: 8,
      displayName: 'New establishment',
    });
    await expect(
      coordinator.start(f.owner.id, { ...exact, rev: 8 }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    await f.activate();
    const second = await f.snapshot();
    expect(second.body.profile.profileRev).toBe(8);
    expect(second.body.establishedAt).toBeGreaterThanOrEqual(
      first.body.establishedAt,
    );
    expect(second.feedId).toBeGreaterThan(first.feedId);
    await expect(coordinator.start(f.owner.id, exact)).rejects.toMatchObject({
      bizCode: BusinessCode.NOT_FOUND,
    });
    await expect(
      coordinator.start(f.owner.id, { ...exact, rev: 8 }),
    ).resolves.toMatchObject({ status: 'READY', profile: { rev: 8 } });
  });
});
