import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { GroupController } from '../src/controller/group.controller.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('group invitations by public address', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });
  afterAll(async () => mod?.close());

  it('resolves the authoritative friend rather than a later group copy, without creating users', async () => {
    const directNs = await seedFederatedPeerNamespace(
      database.db,
      'invite-direct.test',
    );
    const mirrorNs = await seedFederatedPeerNamespace(
      database.db,
      'invite-mirror.test',
    );
    const [local] = await database.db
      .insert(tables.account)
      .values({
        account: 'inviter',
        updatedAt: new Date(),
      })
      .returning();
    const direct = {
      account: 'friend',
      domain: 'invite-direct.test',
      namespaceId: directNs,
    };
    const decoy = { ...direct, namespaceId: mirrorNs };
    await database.db.insert(tables.profileTable).values([
      {
        account: direct.account,
        publisherNamespaceId: directNs,
        profileNamespaceId: directNs,
        profileRev: 1,
        displayName: 'Friend',
      },
      {
        account: direct.account,
        publisherNamespaceId: mirrorNs,
        profileNamespaceId: mirrorNs,
        profileRev: 1,
        displayName: 'Group copy',
      },
    ]);
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    await database.db.insert(tables.relationshipPair).values({
      kind: 'P2P',
      active: true,
      threadId: thread.id,
      endpointAType: 'USER',
      endpointAAccount: local.account,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: direct.account,
      endpointBNamespaceId: directNs,
    });
    const executeIntent = vi.fn().mockResolvedValue({ status: 'APPLIED' });
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
      federationService: { ourDomain: 'inviter.test' },
      groupIntents: { execute: executeIntent },
    });
    const req = {
      user: { userId: local.id },
      threadAccess: { threadId: 9, participant: { role: 'OWNER' } },
    } as never;
    const address = { account: direct.account, domain: direct.domain };
    const result = await controller.inviteUsers(req, {
      groupId: 9,
      users: [address, address],
    } as never);
    // The controller dedupes addresses and delegates each unique one to the
    // group intent family, which owns friend resolution under its locks.
    expect(result.invited).toEqual([address]);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(executeIntent).toHaveBeenCalledWith({
      threadId: 9,
      managerUserId: local.id,
      decision: 'REQUESTED',
      target: address,
    });
    expect(decoy.namespaceId).not.toBe(direct.namespaceId);

    const rejection = {
      status: 'REJECTED',
      reason: 'NOT_FRIEND',
      code: 40400,
      message: 'not a friend or no conversation',
    };
    executeIntent.mockResolvedValueOnce(rejection);
    const inactive = await controller.inviteUsers(req, {
      groupId: 9,
      users: [address],
    });
    expect(inactive.invited).toEqual([]);
    expect(inactive.skipped).toEqual([
      {
        ...address,
        reason: rejection.reason,
        code: rejection.code,
        message: rejection.message,
      },
    ]);
  });
});
