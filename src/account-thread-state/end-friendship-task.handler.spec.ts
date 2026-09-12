import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { EndFriendshipTaskHandler } from './end-friendship-task.handler.js';

const task = {
  id: 5n,
  kind: 'MUTATION',
  scopeType: 'USER_PAIR',
  scopeKey: 'pair-key',
  taskType: 'END_FRIENDSHIP',
  actorUserId: 7,
  payload: { threadId: 12 },
  checkpoint: {},
  coalescingKey: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('EndFriendshipTaskHandler', () => {
  it.each([false, true])(
    'runs the existing transaction and treats network fan-out as hints (migrated system actor: %s)',
    async (system) => {
      const dispatcher = new DurableTaskDispatcherService();
      const systemMessage = { threadId: 12, seq: 3 };
      const endP2P = vi.fn().mockResolvedValue({
        transitioned: true,
        statePeers: ['peer.test'],
        systemMessage,
      });
      const emit = vi.fn();
      const handler = new EndFriendshipTaskHandler(
        dispatcher,
        { endP2P } as never,
        { emit } as never,
      );
      handler.onModuleInit();

      await expect(
        dispatcher.execute(
          system
            ? {
                ...task,
                actorUserId: 99,
                payload: { ...task.payload, intentAuthorUserId: 7 },
              }
            : task,
        ),
      ).resolves.toBeUndefined();

      expect(endP2P).toHaveBeenCalledWith(12, 7, undefined, system ? 99 : 7);
      expect(emit).toHaveBeenCalledWith('federation.state-feed.push', {
        peerDomain: 'peer.test',
      });
    },
  );
});
