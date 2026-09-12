import { describe, expect, it, vi } from 'vitest';
import { FederationReverseRevokeService } from './federation-reverse-revoke.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';

vi.mock('../user/system-account.js', () => ({
  systemAccountIdInTx: vi.fn(async () => 99),
}));
vi.mock('../durable-task/task-checkpoint.js', () => ({
  saveTaskCheckpointInTx: vi.fn(),
}));

describe('reverse revocation commands', () => {
  function harness() {
    const tx = {
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue({ account: 'local-user' }),
        },
        durableTask: {
          findFirst: vi.fn().mockResolvedValue({ checkpoint: {} }),
        },
      },
    };
    const enqueueTaskInTx = vi.fn();
    const mutations = {
      writeP2PIntentInTx: vi.fn(async () => new Map()),
      writeMemberRelationshipIntentInTx: vi.fn(async () => new Map()),
      writeGroupRelationshipIntentInTx: vi.fn(async () => new Map()),
    };
    const service = new FederationReverseRevokeService(
      {
        db: { transaction: (run: (tx: unknown) => unknown) => run(tx) },
      } as never,
      { enqueueTaskInTx } as never,
      mutations as never,
      { notifyFeedUpdates: vi.fn() } as never,
      { emit: vi.fn() } as never,
    );
    return { service, tx, enqueueTaskInTx, mutations };
  }
  const remote = { account: 'peer', domain: 'peer.test', namespaceId: 5 };

  it('attributes P2P reverse work to system while preserving its local author', async () => {
    const h = harness();
    await h.service.enqueueP2PInTx(
      h.tx as never,
      { id: 7, account: 'local-user', domain: 'local' },
      remote,
    );
    expect(h.enqueueTaskInTx).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        taskType: 'REVOKE_USER_RELATIONSHIP',
        actorUserId: 99,
        payload: {
          operation: 'RESPOND_TO_REVOKE',
          intentAuthorUserId: 7,
          targetUserId: remote,
        },
      }),
    );
  });
  it.each(['GROUP', 'MEMBER'] as const)(
    'queues the local %s author, not the remote author',
    async (author) => {
      const h = harness();
      await h.service.enqueueGroupInTx(h.tx as never, {
        threadId: 12,
        group: {
          account: '!group',
          domain: author === 'GROUP' ? 'local' : 'peer.test',
        },
        memberUserId: author === 'GROUP' ? remote : 7,
        author,
      });
      expect(h.enqueueTaskInTx).toHaveBeenCalledWith(
        h.tx,
        expect.objectContaining({
          actorUserId: 99,
          taskType:
            author === 'GROUP'
              ? 'REVOKE_GROUP_RELATIONSHIP'
              : 'REVOKE_USER_RELATIONSHIP',
          payload: expect.objectContaining({
            memberUserId: author === 'GROUP' ? remote : 7,
            ...(author === 'MEMBER' ? { intentAuthorUserId: 7 } : {}),
          }),
        }),
      );
    },
  );
  it.each(['P2P', 'GROUP', 'MEMBER'] as const)(
    'executes the %s local writer and checkpoints in the same transaction',
    async (author) => {
      const h = harness();
      const task = {
        id: 3n,
        kind: 'MUTATION',
        scopeType: author === 'P2P' ? 'USER_PAIR' : 'GROUP',
        taskType:
          author === 'GROUP'
            ? 'REVOKE_GROUP_RELATIONSHIP'
            : 'REVOKE_USER_RELATIONSHIP',
        actorUserId: 99,
        checkpoint: {},
        payload: {
          operation: 'RESPOND_TO_REVOKE',
          intentAuthorUserId: 7,
          targetUserId: remote,
          memberUserId: remote,
          threadId: 12,
        },
      } as unknown as DurableTask;
      await h.service.execute(task);
      if (author === 'P2P')
        expect(h.mutations.writeP2PIntentInTx).toHaveBeenCalledWith(
          h.tx,
          7,
          remote,
          false,
          '',
          [],
        );
      else if (author === 'GROUP')
        expect(
          h.mutations.writeGroupRelationshipIntentInTx,
        ).toHaveBeenCalledWith(h.tx, 12, remote, '', 'REVOKED', []);
      else
        expect(
          h.mutations.writeMemberRelationshipIntentInTx,
        ).toHaveBeenCalledWith(h.tx, 12, 7, 'REVOKED', []);
      expect(saveTaskCheckpointInTx).toHaveBeenCalledWith(h.tx, 3n, {
        reverseRevokeDone: true,
      });
      await h.service.execute({
        ...task,
        checkpoint: { reverseRevokeDone: true },
      });
      expect(
        Object.values(h.mutations).reduce(
          (count, fn) => count + fn.mock.calls.length,
          0,
        ),
      ).toBe(1);
    },
  );
});
