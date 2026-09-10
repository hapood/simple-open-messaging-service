import { FederationReverseRevokeService } from '../src/federation/federation-reverse-revoke.service.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { account, durableTask } from '../src/database/schema.js';
import { systemAccountIdInTx } from '../src/user/system-account.js';
import { UserService } from '../src/user/user.service.js';
import { DurableTaskQueueService } from '../src/durable-task/durable-task-queue.service.js';

describe('system account attribution', () => {
  let database: DatabaseService;
  let systemId: number;
  beforeAll(async () => {
    database = new DatabaseService();
    systemId = await database.db.transaction(systemAccountIdInTx);
  });
  afterAll(async () => database.onApplicationShutdown());

  it('provisions an internal identity that cannot authenticate or publish a profile', async () => {
    const system = await database.db.query.account.findFirst({
      where: eq(account.id, systemId),
    });
    expect(system).toMatchObject({
      account: '$system',
      kind: 'SYSTEM',
      hashPwd: null,
      defaultProfileRev: 0,
    });
    expect(system?.disabledAt).toBeInstanceOf(Date);
    for (const changes of [
      { disabledAt: null },
      { hashPwd: 'a-password-hash' },
      { defaultProfileRev: 1 },
      { kind: 'USER' },
    ]) {
      await expect(
        database.db
          .update(account)
          .set(changes)
          .where(eq(account.id, systemId)),
      ).rejects.toThrow();
    }
    const users = new UserService(database);
    expect(await users.searchUsers('system', { take: 10 })).toEqual({
      list: [],
      total: 0,
    });
    expect(() =>
      users.addUser({ account: '$system', name: 'Impersonator' }),
    ).toThrow();
  });

  it('rolls reverse task admission back with the receiving transaction', async () => {
    const queue = new DurableTaskQueueService(database);
    const reverse = new FederationReverseRevokeService(
      database,
      queue,
      {} as never,
      {} as never,
      {} as never,
    );
    const local = { id: 201, account: 'atomic-local', domain: 'local' };
    const remote = {
      account: 'atomic-peer',
      domain: 'peer.test',
      namespaceId: 5,
    };
    let taskId: bigint | undefined;
    await expect(
      database.db.transaction(async (tx) => {
        await reverse.enqueueP2PInTx(tx, local, remote);
        const rows = await tx.query.durableTask.findMany();
        taskId = rows.find(
          (row) => row.payload.intentAuthorUserId === local.id,
        )?.id;
        expect(taskId).toBeDefined();
        throw new Error('rollback received page');
      }),
    ).rejects.toThrow('rollback received page');
    expect(
      await database.db.query.durableTask.findFirst({
        where: eq(durableTask.id, taskId!),
      }),
    ).toBeUndefined();
  });

  it('keeps automatic revocations in each actual author direction and permits user replacement', async () => {
    const queue = new DurableTaskQueueService(database);
    const scope = {
      type: 'USER_PAIR' as const,
      endpoints: [
        { account: 'a', domain: 'local' },
        { account: 'b', domain: 'peer.test' },
      ] as const,
    };
    const first = await queue.enqueueTask({
      scope,
      taskType: 'REVOKE_USER_RELATIONSHIP',
      actorUserId: systemId,
      payload: {
        threadId: 10,
        intentAuthorUserId: 101,
        expectedAuthorizationEpoch: 7,
      },
    });
    const second = await queue.enqueueTask({
      scope,
      taskType: 'REVOKE_USER_RELATIONSHIP',
      actorUserId: systemId,
      payload: {
        threadId: 10,
        intentAuthorUserId: 102,
        expectedAuthorizationEpoch: 7,
      },
    });
    expect(second.taskId).not.toBe(first.taskId);
    const stored = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, first.taskId),
    });
    expect(stored).toMatchObject({
      actorUserId: systemId,
      coalescingKey: JSON.stringify(['P2P_INTENT', 101]),
    });
    expect(
      await queue.enqueueTask({
        scope,
        taskType: 'ACCEPT_RELATIONSHIP_REQUEST',
        actorUserId: 101,
        payload: { peerUserId: 102 },
      }),
    ).toEqual(first);
    const replaced = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, first.taskId),
    });
    expect(replaced).toMatchObject({
      actorUserId: 101,
      payload: { peerUserId: 102 },
    });
    expect(replaced?.payload).not.toHaveProperty('intentAuthorUserId');
  });
});
