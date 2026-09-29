import { Test, type TestingModule } from '@nestjs/testing';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { ProfileResolutionCoordinatorService } from '../src/profile-resolution/profile-resolution-coordinator.service.js';
import { BusinessCode } from '../src/common/business-code.js';

describe('local-author profiles referenced by a foreign authoritative group', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let threadId: number;
  let viewerId: number;
  let profiles: FederationProfileService;
  const domain = loadFederationConfig().domain;
  const account = 'local-profile-viewer';
  const sse = { onProfileResolved: vi.fn(), onProfileFailed: vi.fn() };
  const coordinator = () =>
    new ProfileResolutionCoordinatorService(database, profiles, sse as never);

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    profiles = new FederationProfileService(database, {} as never, {} as never);
    const ns = await seedFederatedPeerNamespace(
      database.db,
      'local-profile-origin.test',
    );
    const [viewer] = await database.db
      .insert(tables.account)
      .values({
        account,
        domain: 'local',
        namespaceId: 0,
        defaultProfileRev: 2,
        updatedAt: new Date(),
      })
      .returning();
    viewerId = viewer.id;
    await database.db.insert(tables.profileTable).values([
      {
        account,
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
        displayName: 'Local historical',
      },
      {
        account,
        domain: 'local',
        namespaceId: 0,
        profileRev: 2,
        displayName: 'Local current',
      },
      {
        account,
        domain,
        namespaceId: ns,
        profileRev: 1,
        displayName: 'Wrong foreign copy',
      },
    ]);
    const group = {
      account: '!local-profile-mirror',
      domain: 'local-profile-origin.test',
    };
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'GROUP',
        groupAccount: group.account,
        groupDomain: group.domain,
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
      endpointAType: 'GROUP',
      endpointAAccount: account,
      endpointANamespaceId: 0,
      endpointBType: 'GROUP',
      endpointBAccount: group.account,
      endpointBNamespaceId: ns,
    });
    await database.db.insert(tables.groupMetaMemberFeed).values({
      threadId,
      memberAccount: account,
      memberDomain: 'local',
      operation: 'MEMBER_UPSERT',
      feedId: 1,
      body: { role: 'MEMBER', profileRev: 1 },
    });
    await database.db.insert(tables.message).values(
      [1, 2, 3].map((seq) => ({
        threadId,
        seq,
        originSeq: seq,
        sourceNamespaceId: ns,
        creatorAccount: account,
        creatorDomain: 'local',
        profileNamespaceId: 0,
        profileRev: seq === 3 ? 3 : 1,
        contentType: 'PURE_TEXT' as const,
        content: JSON.stringify({ text: 'local author' }),
        updatedAt: new Date(),
      })),
    );
  });
  afterAll(async () => {
    await mod.close();
  });

  it.each(['local', 'canonical'])(
    'resolves a mirror roster %s domain from the local exact version',
    async (form) => {
      await expect(
        coordinator().start(viewerId, {
          type: 'GROUP_META',
          threadId,
          profileRev: 1,
          subject: {
            type: 'MEMBER',
            account,
            domain: form === 'local' ? 'local' : domain,
          },
        }),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 1, name: 'Local historical' },
      });
    },
  );

  it.each([1, 2])(
    'resolves message %i locally even with a foreign source namespace',
    async (messageSeq) => {
      await expect(
        coordinator().start(viewerId, {
          type: 'MESSAGE_AUTHOR',
          threadId,
          messageSeq,
          rev: 1,
        }),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 1, name: 'Local historical' },
      });
    },
  );

  it('does not fall back to S2S or the latest local version for a missing exact revision', async () => {
    await expect(
      coordinator().start(viewerId, {
        type: 'MESSAGE_AUTHOR',
        threadId,
        messageSeq: 3,
        rev: 3,
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    expect(sse.onProfileFailed).not.toHaveBeenCalled();
  });

  it('still rejects a viewer without thread authorization', async () => {
    const [outsider] = await database.db
      .insert(tables.account)
      .values({ account: 'profile-outsider', updatedAt: new Date() })
      .returning();
    await expect(
      coordinator().start(outsider.id, {
        type: 'MESSAGE_AUTHOR',
        threadId,
        messageSeq: 1,
        rev: 1,
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
  });
});
