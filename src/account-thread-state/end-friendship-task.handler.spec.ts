import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { EndFriendshipTaskHandler } from './end-friendship-task.handler.js';

const task = {
  id: 5n,
  parentTaskId: null,
  kind: 'MUTATION',
  scopeType: 'USER_PAIR',
  scopeKey: 'pair-key',
  taskType: 'END_FRIENDSHIP',
  actorUserId: 7,
  payload: { threadId: 12 },
  checkpoint: {},
  coalescingKey: null,
  supersededByTaskId: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('EndFriendshipTaskHandler', () => {
  it('runs the existing transaction and treats network fan-out as hints', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const systemMessage = { threadId: 12, seq: 3 };
    const endP2P = vi.fn().mockResolvedValue({
      transitioned: true,
      statePeers: ['peer.test'],
      systemMessage,
      localRecipientIds: [7, 9],
    });
    const emit = vi.fn();
    const dispatchToUsers = vi.fn().mockRejectedValue(new Error('offline'));
    const handler = new EndFriendshipTaskHandler(
      dispatcher,
      { endP2P } as never,
      { emit } as never,
      { dispatchToUsers } as never,
    );
    handler.onModuleInit();

    await expect(dispatcher.execute(task)).resolves.toBeUndefined();

    expect(endP2P).toHaveBeenCalledWith(12, 7);
    expect(emit).toHaveBeenCalledWith('federation.state-feed.push', {
      peerDomain: 'peer.test',
    });
    expect(dispatchToUsers).toHaveBeenCalledWith(systemMessage, [7, 9]);
  });
});
