import { Test, type TestingModule } from '@nestjs/testing';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { ProfileResolutionCoordinatorService } from '../src/federation/profile-resolution-coordinator.service.js';
import { BusinessCode } from '../src/common/business-code.js';

describe('local-author profiles referenced by a foreign authoritative group', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let threadId: number;
  let viewerId: number;
  let profiles: FederationProfileService;
  const domain = loadFederationConfig().domain;
  const account = 'local-profile-viewer';
  const peerHttp = { get: vi.fn() };
  const sse = { onProfileResolved: vi.fn(), onProfileFailed: vi.fn() };
  const coordinator = () =>
    new ProfileResolutionCoordinatorService(
      database,
      peerHttp as never,
      profiles,
      {} as never,
      sse as never,
    );

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    profiles = new FederationProfileService(
      database,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const ns = await seedFederatedPeerNamespace(
      database.db,
      'local-profile-origin.test',
    );
    const [viewer, shell] = await database.db
      .insert(tables.user)
      .values([
        {
          account,
          domain: 'local',
          namespaceId: 0,
          name: 'Current',
          defaultProfileRev: 2,
          updatedAt: new Date(),
        },
        {
          account,
          domain,
          namespaceId: ns,
          name: 'Foreign shell',
          updatedAt: new Date(),
        },
      ])
      .returning();
    viewerId = viewer.id;
    await database.db.insert(tables.profileVersion).values([
      { userId: viewer.id, profileRev: 1, displayName: 'Local historical' },
      { userId: viewer.id, profileRev: 2, displayName: 'Local current' },
      { userId: shell.id, profileRev: 1, displayName: 'Wrong foreign copy' },
    ]);
    const [group] = await database.db
      .insert(tables.group)
      .values({
        account: '!local-profile-mirror',
        domain: 'local-profile-origin.test',
        namespaceId: ns,
        name: 'Mirror',
        updatedAt: new Date(),
      })
      .returning();
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'GROUP',
        groupId: group.id,
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
      endpointAAccount: group.account,
      endpointADomain: group.domain,
      endpointANamespaceId: ns,
      endpointBType: 'USER',
      endpointBAccount: account,
      endpointBDomain: 'local',
      endpointBNamespaceId: ns,
    });
    await database.db.insert(tables.groupMetaMemberFeed).values({
      groupId: group.id,
      memberUserId: shell.id,
      operation: 'UPSERT',
      feedId: 1n,
      body: { role: 'MEMBER', profileRev: 1 },
    });
    await database.db.insert(tables.message).values(
      [1, 2, 3].map((seq) => ({
        threadId,
        seq,
        originSeq: seq,
        sourceNamespaceId: ns,
        creatorAccount: account,
        creatorDomain: seq === 2 ? 'local' : domain,
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
          threadId,
          memberAccount: account,
          memberDomain: form === 'local' ? 'local' : domain,
        }),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 1, name: 'Local historical' },
      });
      expect(peerHttp.get).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2])(
    'resolves message %i locally even with a foreign source namespace',
    async (messageSeq) => {
      await expect(
        coordinator().start(viewerId, { threadId, messageSeq }),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: { rev: 1, name: 'Local historical' },
      });
      expect(peerHttp.get).not.toHaveBeenCalled();
    },
  );

  it('does not fall back to S2S or the latest local version for a missing exact revision', async () => {
    await expect(
      coordinator().start(viewerId, { threadId, messageSeq: 3 }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    expect(peerHttp.get).not.toHaveBeenCalled();
    expect(sse.onProfileFailed).not.toHaveBeenCalled();
  });

  it('still rejects a viewer without thread authorization', async () => {
    await expect(
      coordinator().start(-1, { threadId, messageSeq: 1 }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
  });
});
