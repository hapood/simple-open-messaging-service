import { Test, type TestingModule } from '@nestjs/testing';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { SseService } from '../src/gateway/sse.service.js';
import { ProfileResolutionCoordinatorService } from '../src/profile-resolution/profile-resolution-coordinator.service.js';
import { BusinessCode } from '../src/common/business-code.js';
import {
  ProfileLookup,
  type ProfileClientResolutionDemand,
} from '../src/profile-resolution/profile-resolution-demand.js';
import { withMessageDigest } from './support/message-fixture.js';

describe('local-author profiles referenced by a foreign authoritative group', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let threadId: number;
  let viewerId: number;
  let sse: SseService;
  const account = 'local-profile-viewer';
  const groupAccount = '!local-profile-mirror';
  const coordinator = () => mod.get(ProfileResolutionCoordinatorService);

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    database = mod.get(DatabaseService);
    sse = mod.get(SseService);
    vi.spyOn(sse, 'onProfileUnavailable');
    const ns = await seedFederatedPeerNamespace(
      database.db,
      'local-profile-origin.test',
    );
    const [viewer] = await database.db
      .insert(tables.account)
      .values({
        account,
        namespaceId: 0,
        defaultProfileRev: 2,
        updatedAt: new Date(),
      })
      .returning();
    viewerId = viewer.id;
    await database.db.insert(tables.profileTable).values([
      {
        account,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        generatedAt: 1_700_000_000_000,
        displayName: 'Local historical',
      },
      {
        account,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 2,
        generatedAt: 1_700_000_000_000,
        displayName: 'Local current',
      },
      {
        account,
        publisherNamespaceId: ns,
        profileNamespaceId: ns,
        profileRev: 1,
        generatedAt: 1_700_000_000_000,
        displayName: 'Wrong foreign copy',
      },
    ]);
    const group = {
      account: groupAccount,
      domain: 'local-profile-origin.test',
    };
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'GROUP',
        groupAccount: group.account,
        authorityNamespaceId: ns,
        curSeq: 3,
        updatedAt: new Date(),
      })
      .returning();
    threadId = thread.id;
    await database.db.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      threadId,
      active: true,
      endpointAType: 'USER',
      endpointAAccount: account,
      endpointANamespaceId: 0,
      endpointBType: 'GROUP',
      endpointBAccount: group.account,
      endpointBNamespaceId: ns,
    });
    await database.db.insert(tables.groupMetaMemberFeed).values({
      threadId,
      operation: 'MEMBER_UPSERT',
      feedId: 1,
      body: {
        account,
        namespaceId: 0,
        role: 'MEMBER',
        profileRev: 1,
      },
    });
    await database.db.insert(tables.accountThreadState).values({
      accountId: viewerId,
      threadId,
      messageEndSeq: 3,
      role: 'MEMBER',
    });
    await database.db.insert(tables.message).values(
      withMessageDigest(
        [1, 2, 3].map((seq) => ({
          threadId,
          seq,
          originSeq: seq,
          publisherNamespaceId: 0,
          creatorAccount: account,
          profileNamespaceId: 0,
          profileRev: seq === 3 ? 3 : 1,
          contentType: 'PURE_TEXT' as const,
          content: JSON.stringify({ text: 'local author' }),
          updatedAt: new Date(),
        })),
      ),
    );
  });
  afterAll(async () => {
    await mod.close();
  });

  it.each(['local', 'canonical'])(
    'resolves a mirror roster %s domain from the local exact version',
    async (_form) => {
      await expect(
        coordinator().start(viewerId, 0, {
          publisherNamespaceId: 0,
          lookup: ProfileLookup.ACCOUNT_PROFILE,
          target: {
            profileNamespaceId: 0,
            account,
            rev: 1,
          },
        } satisfies ProfileClientResolutionDemand),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 1, name: 'Local historical' },
      });
    },
  );

  it.each([1, 2])(
    'resolves message %i locally even with a foreign source namespace',
    async (_messageSeq) => {
      await expect(
        coordinator().start(viewerId, 0, {
          publisherNamespaceId: 0,
          lookup: ProfileLookup.ACCOUNT_PROFILE,
          target: {
            profileNamespaceId: 0,
            account,
            rev: 1,
          },
        } satisfies ProfileClientResolutionDemand),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 1, name: 'Local historical' },
      });
    },
  );

  it('does not fall back to S2S or the latest local version for a missing exact revision', async () => {
    await expect(
      coordinator().start(viewerId, 0, {
        publisherNamespaceId: 0,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target: {
          profileNamespaceId: 0,
          account,
          rev: 3,
        },
      } satisfies ProfileClientResolutionDemand),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    expect(sse.onProfileUnavailable).not.toHaveBeenCalled();
  });

  it('serves cached snapshots without thread authorization, but rejects an uncached revision', async () => {
    const [outsider] = await database.db
      .insert(tables.account)
      .values({ account: 'profile-outsider', updatedAt: new Date() })
      .returning();
    await expect(
      coordinator().start(outsider.id, 0, {
        publisherNamespaceId: 0,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target: {
          profileNamespaceId: 0,
          account,
          rev: 1,
        },
      } satisfies ProfileClientResolutionDemand),
    ).resolves.toMatchObject({
      status: 'READY',
      profile: { rev: 1, name: 'Local historical' },
    });
    await expect(
      coordinator().start(outsider.id, 0, {
        publisherNamespaceId: 0,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target: { profileNamespaceId: 0, account, rev: 3 },
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
  });
});
