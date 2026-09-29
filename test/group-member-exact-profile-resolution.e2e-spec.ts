import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { ProfileResolutionCoordinatorService } from '../src/profile-resolution/profile-resolution-coordinator.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('exact profile completion for a federated group member', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let subject: ProfileResolutionCoordinatorService;
  let viewerId: number;
  let outsiderId: number;
  let threadId: number;
  let namespaceId: number;
  const domain = 'member-profile-origin.test';
  const account = 'exact-profile-member';
  const viewer = 'exact-profile-viewer';
  const selector = { type: 'EXACT' as const, account, domain, rev: 2 };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    const users = await database.db
      .insert(tables.account)
      .values([
        { account: viewer, updatedAt: new Date() },
        { account: 'exact-profile-outsider', updatedAt: new Date() },
      ])
      .returning();
    viewerId = users[0].id;
    outsiderId = users[1].id;
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'GROUP',
        groupAccount: '!exact-profile-group',
        groupDomain: domain,
        authorityNamespaceId: namespaceId,
        updatedAt: new Date(),
      })
      .returning();
    threadId = thread.id;
    await database.db.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      threadId,
      active: true,
      endpointAType: 'GROUP',
      endpointAAccount: viewer,
      endpointANamespaceId: 0,
      endpointBType: 'GROUP',
      endpointBAccount: '!exact-profile-group',
      endpointBNamespaceId: namespaceId,
    });
    await database.db.insert(tables.groupMetaMemberFeed).values({
      threadId,
      feedId: 1,
      memberAccount: account,
      memberDomain: domain,
      operation: 'MEMBER_UPSERT',
      body: { role: 'OWNER', profileRev: 2 },
    });
    await database.db.insert(tables.profileTable).values(
      [1, 2].map((profileRev) => ({
        account,
        domain,
        namespaceId,
        profileRev,
        displayName: profileRev === 2 ? 'Updated member' : 'Historical member',
      })),
    );
    subject = new ProfileResolutionCoordinatorService(
      database,
      new FederationProfileService(database, {} as never, {} as never),
      {} as never,
    );
  });
  afterAll(async () => {
    await mod.close();
  });

  it('allows the event-driven exact read of a roster-authorized snapshot', async () => {
    await expect(
      subject.start(viewerId, {
        type: 'GROUP_META',
        threadId,
        profileRev: 2,
        subject: { type: 'MEMBER', account, domain },
      }),
    ).resolves.toMatchObject({
      status: 'READY',
      profile: { namespaceId, rev: 2 },
    });
    await expect(subject.start(viewerId, selector)).resolves.toMatchObject({
      status: 'READY',
      profile: { namespaceId, rev: 2, name: 'Updated member' },
    });
  });

  it('does not disclose a cached snapshot to an unrelated viewer or a revision absent from the roster', async () => {
    await expect(subject.start(outsiderId, selector)).rejects.toMatchObject({
      bizCode: BusinessCode.NOT_FOUND,
    });
    await expect(
      subject.start(viewerId, { ...selector, rev: 1 }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
  });

  it('rechecks current membership even when the exact snapshot is cached', async () => {
    await database.db
      .update(tables.relationshipPair)
      .set({ active: false })
      .where(eq(tables.relationshipPair.threadId, threadId));
    try {
      await expect(subject.start(viewerId, selector)).rejects.toMatchObject({
        bizCode: BusinessCode.NOT_FOUND,
      });
    } finally {
      await database.db
        .update(tables.relationshipPair)
        .set({ active: true })
        .where(eq(tables.relationshipPair.threadId, threadId));
    }
  });

  it('does not use a departed subject as authorization', async () => {
    const member = and(
      eq(tables.groupMetaMemberFeed.threadId, threadId),
      eq(tables.groupMetaMemberFeed.memberAccount, account),
    );
    await database.db
      .update(tables.groupMetaMemberFeed)
      .set({ operation: 'MEMBER_DEPART', body: {} })
      .where(member);
    try {
      await expect(subject.start(viewerId, selector)).rejects.toMatchObject({
        bizCode: BusinessCode.NOT_FOUND,
      });
    } finally {
      await database.db
        .update(tables.groupMetaMemberFeed)
        .set({
          operation: 'MEMBER_UPSERT',
          body: { role: 'OWNER', profileRev: 2 },
        })
        .where(member);
    }
  });
});
