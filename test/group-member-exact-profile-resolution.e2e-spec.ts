import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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
  let unrelatedPublisherNamespaceId: number;
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
    unrelatedPublisherNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      'unrelated-profile-origin.test',
    );
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
        curSeq: 1,
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
      established: true,
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
      operation: 'MEMBER_UPSERT',
      body: { account, namespaceId, role: 'OWNER', profileRev: 2 },
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

  it('authorizes a current Meta reference without requiring matching messages', async () => {
    const demand = { ...selector(), target: { ...selector().target, rev: 3 } };
    const authorize = (userId = viewerId) =>
      subject['authorizeGroupMemberDemand'](userId, demand);
    await database.db
      .update(tables.groupMetaMemberFeed)
      .set({
        body: { account, namespaceId, role: 'OWNER', profileRev: 3 },
      })
      .where(eq(tables.groupMetaMemberFeed.threadId, threadId));
    try {
      // The only message names revision 2, not the requested current revision 3.
      await expect(authorize()).resolves.toBeUndefined();
      await expect(authorize(outsiderId)).rejects.toMatchObject({
        bizCode: BusinessCode.NOT_FOUND,
      });
      await database.db
        .update(tables.relationshipPair)
        .set({ active: false })
        .where(eq(tables.relationshipPair.threadId, threadId));
      await expect(authorize()).rejects.toMatchObject({
        bizCode: BusinessCode.NOT_FOUND,
      });
    } finally {
      await database.db
        .update(tables.relationshipPair)
        .set({ active: true })
        .where(eq(tables.relationshipPair.threadId, threadId));
      await database.db
        .update(tables.groupMetaMemberFeed)
        .set({
          body: {
            account,
            namespaceId,
            role: 'OWNER',
            profileRev: 2,
          },
        })
        .where(eq(tables.groupMetaMemberFeed.threadId, threadId));
    }
  });

  it('authorizes message evidence independently of current Meta within the viewer range', async () => {
    const demand = { ...selector(), target: { ...selector().target, rev: 4 } };
    const authorize = (request = demand) =>
      subject['authorizeGroupMemberDemand'](viewerId, request);
    await database.db.insert(tables.message).values({
      threadId,
      seq: 2,
      originSeq: 2,
      originServerTime: new Date(),
      publisherNamespaceId: namespaceId,
      creatorAccount: account,
      profileNamespaceId: namespaceId,
      profileRev: 4,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'historical proof' }),
      payloadDigest: 'historical-proof',
      updatedAt: new Date(),
    });
    await database.db
      .update(tables.accountThreadState)
      .set({ messageEndSeq: 2 })
      .where(eq(tables.accountThreadState.threadId, threadId));
    await database.db
      .update(tables.groupMetaMemberFeed)
      .set({ operation: 'MEMBER_DEPART' })
      .where(eq(tables.groupMetaMemberFeed.threadId, threadId));
    try {
      await expect(authorize()).resolves.toBeUndefined();
      await expect(
        authorize({
          ...demand,
          publisherNamespaceId: unrelatedPublisherNamespaceId,
        }),
      ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
      await expect(
        authorize({ ...demand, target: { ...demand.target, rev: 5 } }),
      ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
      await database.db
        .update(tables.accountThreadState)
        .set({ messageEndSeq: 1 })
        .where(eq(tables.accountThreadState.threadId, threadId));
      await expect(authorize()).rejects.toMatchObject({
        bizCode: BusinessCode.NOT_FOUND,
      });
      await database.db
        .update(tables.accountThreadState)
        .set({ messageEndSeq: 2 })
        .where(eq(tables.accountThreadState.threadId, threadId));
      await database.db
        .update(tables.messageThread)
        .set({ curSeq: 2, clearedSeq: 2 })
        .where(eq(tables.messageThread.id, threadId));
      await expect(authorize()).rejects.toMatchObject({
        bizCode: BusinessCode.NOT_FOUND,
      });
    } finally {
      await database.db
        .update(tables.messageThread)
        .set({ curSeq: 1, clearedSeq: null })
        .where(eq(tables.messageThread.id, threadId));
      await database.db
        .update(tables.accountThreadState)
        .set({ messageEndSeq: 1 })
        .where(eq(tables.accountThreadState.threadId, threadId));
      await database.db
        .update(tables.groupMetaMemberFeed)
        .set({ operation: 'MEMBER_UPSERT' })
        .where(eq(tables.groupMetaMemberFeed.threadId, threadId));
      await database.db
        .delete(tables.message)
        .where(
          and(eq(tables.message.threadId, threadId), eq(tables.message.seq, 2)),
        );
    }
  });

  it('serves a departed subject from cache but does not authorize an uncached revision', async () => {
    const member = and(
      eq(tables.groupMetaMemberFeed.threadId, threadId),
      sql`${tables.groupMetaMemberFeed.body} ->> 'account' = ${account}`,
      sql`${tables.groupMetaMemberFeed.body} -> 'namespaceId' = to_jsonb(${namespaceId}::integer)`,
    );
    await database.db
      .update(tables.groupMetaMemberFeed)
      .set({
        operation: 'MEMBER_DEPART',
        body: { account, namespaceId, role: 'OWNER', profileRev: 2 },
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
            account,
            namespaceId,
            role: 'OWNER',
            profileRev: 2,
          },
        })
        .where(member);
    }
  });
});
