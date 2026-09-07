import { Test, type TestingModule } from '@nestjs/testing';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { UserService } from '../src/user/user.service.js';
import { AccountThreadStateService } from '../src/account-thread-state/account-thread-state.service.js';
import { RelationshipController } from '../src/controller/relationship.controller.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('revoking a friendship with a multiply mirrored identity', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });
  afterAll(async () => {
    await mod?.close();
  });

  it('requires a namespace and selects the direct peer identity, not the group mirror', async () => {
    const groupNs = await seedFederatedPeerNamespace(
      database.db,
      'revoke-group.test',
    );
    const directNs = await seedFederatedPeerNamespace(
      database.db,
      'revoke-direct.test',
    );
    const [local] = await database.db
      .insert(tables.account)
      .values({
        account: 'revoke-local',
        updatedAt: new Date(),
      })
      .returning();
    const remote = {
      account: 'revoke-peer',
      domain: 'revoke-direct.test',
      namespaceId: directNs,
    };
    const decoy = { ...remote, namespaceId: groupNs };
    await database.db.insert(tables.profileTable).values([
      { ...remote, profileRev: 1, displayName: 'Direct copy' },
      { ...decoy, profileRev: 1, displayName: 'Group copy' },
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
      endpointADomain: 'local',
      endpointANamespaceId: directNs,
      endpointBType: 'USER',
      endpointBAccount: remote.account,
      endpointBDomain: remote.domain,
      endpointBNamespaceId: directNs,
    });
    const users = new UserService(database);
    const participants = new AccountThreadStateService(
      database,
      {} as never,
      {} as never,
    );
    expect(() =>
      users.findUniqueUser({
        account_domain: { account: remote.account, domain: remote.domain },
      } as never),
    ).toThrow('explicit namespaceId');
    expect(await participants.findP2PThreadBetween(local.id, decoy)).toBeNull();
    expect(await participants.findP2PThreadBetween(local.id, remote)).toBe(
      thread.id,
    );
    const queue = { enqueueTask: vi.fn().mockResolvedValue({ taskId: 1n }) };
    const controller = new RelationshipController(
      users,
      {
        federatedRelationshipContext: vi
          .fn()
          .mockResolvedValue({ namespaceId: directNs, status: 'FRIEND' }),
      } as never,
      participants,
      {} as never,
      queue as never,
      {} as never,
    );
    await expect(
      controller.revokeRelationship({ user: { userId: local.id } } as never, {
        account: remote.account,
        domain: remote.domain,
      }),
    ).resolves.toEqual({ taskId: '1', status: 'PENDING' });
    expect(queue.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'END_FRIENDSHIP',
        payload: { threadId: thread.id },
      }),
    );
  });
});
