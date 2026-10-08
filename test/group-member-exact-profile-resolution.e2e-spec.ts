import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { ProfileResolutionCoordinatorService } from '../src/profile-resolution/profile-resolution-coordinator.service.js';
import {
  ProfileLookup,
  type ProfileClientResolutionDemand,
} from '../src/profile-resolution/profile-resolution-demand.js';
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
  const selector = () =>
    ({
      publisherNamespaceId: namespaceId,
      lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
      groupAccount: '!exact-profile-group',
      target: { profileNamespaceId: namespaceId, account, rev: 2 },
    }) satisfies ProfileClientResolutionDemand;

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
      endpointAType: 'USER',
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
      profileNamespaceId: namespaceId,
      operation: 'MEMBER_UPSERT',
      body: { role: 'OWNER', profileNamespaceId: namespaceId, profileRev: 2 },
    });
    await database.db.insert(tables.profileTable).values(
      [1, 2].map((profileRev) => ({
        account,
        publisherNamespaceId: namespaceId,
        profileNamespaceId: namespaceId,
        profileRev,
        displayName: profileRev === 2 ? 'Updated member' : 'Historical member',
      })),
    );
    await database.db.insert(tables.accountThreadState).values({
      accountId: viewerId,
      threadId,
      messageEndSeq: 1,
      role: 'MEMBER',
    });
    await database.db.insert(tables.message).values({
      threadId,
      seq: 1,
      originSeq: 1,
      originServerTime: new Date(),
      publisherNamespaceId: namespaceId,
      creatorAccount: account,
      profileNamespaceId: namespaceId,
      profileRev: 2,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'member proof' }),
      payloadDigest: 'profile-proof',
      updatedAt: new Date(),
    });
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
      subject.start(viewerId, 0, {
        publisherNamespaceId: namespaceId,
        lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
        groupAccount: '!exact-profile-group',
        target: { profileNamespaceId: namespaceId, account, rev: 2 },
      }),
    ).resolves.toMatchObject({
      status: 'READY',
      profile: { profileNamespaceId: namespaceId, rev: 2 },
    });
    await expect(subject.start(viewerId, 0, selector())).resolves.toMatchObject(
      {
        status: 'READY',
        profile: {
          profileNamespaceId: namespaceId,
          rev: 2,
          name: 'Updated member',
        },
      },
    );
  });

  it('serves cached exact snapshots without checking the viewer or current roster revision', async () => {
    await expect(
      subject.start(outsiderId, 0, selector()),
    ).resolves.toMatchObject({
      status: 'READY',
      profile: { rev: 2, name: 'Updated member' },
    });
    await expect(
      subject.start(viewerId, 0, {
        ...selector(),
        target: { ...selector().target, rev: 1 },
      }),
    ).resolves.toMatchObject({
      status: 'READY',
      profile: { rev: 1, name: 'Historical member' },
    });
    await expect(
      subject.start(outsiderId, 0, {
        ...selector(),
        target: { ...selector().target, rev: 3 },
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
  });

  it('checks current membership only on a cache miss', async () => {
    await database.db
      .update(tables.relationshipPair)
      .set({ active: false })
      .where(eq(tables.relationshipPair.threadId, threadId));
    try {
      await expect(
        subject.start(viewerId, 0, selector()),
      ).resolves.toMatchObject({ status: 'READY', profile: { rev: 2 } });
      await expect(
        subject.start(viewerId, 0, {
          ...selector(),
          target: { ...selector().target, rev: 3 },
        }),
      ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    } finally {
      await database.db
        .update(tables.relationshipPair)
        .set({ active: true })
        .where(eq(tables.relationshipPair.threadId, threadId));
    }
  });

  it('serves a departed subject from cache but does not authorize an uncached revision', async () => {
    const member = and(
      eq(tables.groupMetaMemberFeed.threadId, threadId),
      eq(tables.groupMetaMemberFeed.memberAccount, account),
    );
    await database.db
      .update(tables.groupMetaMemberFeed)
      .set({
        operation: 'MEMBER_DEPART',
        body: { role: 'OWNER', profileNamespaceId: namespaceId, profileRev: 2 },
      })
      .where(member);
    try {
      await expect(
        subject.start(viewerId, 0, selector()),
      ).resolves.toMatchObject({ status: 'READY', profile: { rev: 2 } });
      await expect(
        subject.start(viewerId, 0, {
          ...selector(),
          target: { ...selector().target, rev: 3 },
        }),
      ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    } finally {
      await database.db
        .update(tables.groupMetaMemberFeed)
        .set({
          operation: 'MEMBER_UPSERT',
          body: {
            role: 'OWNER',
            profileNamespaceId: namespaceId,
            profileRev: 2,
          },
        })
        .where(member);
    }
  });
});
