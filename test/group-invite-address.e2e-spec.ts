import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { AccountThreadStateService } from '../src/account-thread-state/account-thread-state.service.js';
import { GroupController } from '../src/controller/group.controller.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { eq } from 'drizzle-orm';

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
      { ...direct, profileRev: 1, displayName: 'Friend' },
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
      endpointBAccount: direct.account,
      endpointBDomain: direct.domain,
      endpointBNamespaceId: directNs,
    });
    const queue = { enqueueTask: vi.fn().mockResolvedValue({ taskId: 7n }) };
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
      groupService: {
        findGroupByThreadId: async () => ({
          group: { account: '!group', domain: 'local' },
        }),
      },
      participantService: new AccountThreadStateService(
        database,
        {} as never,
        {} as never,
      ),
      federationService: { ourDomain: 'inviter.test' },
      durableTasks: queue,
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
    expect(result.invited).toEqual([address]);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(queue.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { threadId: 9, targetUserId: direct },
      }),
    );
    expect(decoy.namespaceId).not.toBe(direct.namespaceId);
    const unknown = await controller.inviteUsers(req, {
      groupId: 9,
      users: [{ account: 'unknown', domain: direct.domain }],
    } as never);
    expect(unknown.tasks).toEqual([]);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(
      await database.db.select({ id: tables.account.id }).from(tables.account),
    ).toHaveLength(1);
    await database.db
      .update(tables.relationshipPair)
      .set({ active: false })
      .where(eq(tables.relationshipPair.threadId, thread.id));
    const inactive = await controller.inviteUsers(req, {
      groupId: 9,
      users: [address],
    });
    expect(inactive.invited).toEqual([]);
    expect(inactive.skipped).toEqual([
      { ...address, reason: 'not a friend or no conversation' },
    ]);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
  });
});
