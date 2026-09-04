import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { AcceptRelationshipRequestTaskHandler } from './accept-relationship-request-task.handler.js';

const task = {
  id: 4n,
  parentTaskId: null,
  kind: 'MUTATION',
  scopeType: 'USER_PAIR',
  scopeKey: 'pair-key',
  taskType: 'ACCEPT_RELATIONSHIP_REQUEST',
  actorUserId: 7,
  payload: { peerUserId: 9 },
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

describe('AcceptRelationshipRequestTaskHandler', () => {
  it('routes the persisted task to the shared execution service', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const accept = vi.fn().mockResolvedValue(undefined);
    const handler = new AcceptRelationshipRequestTaskHandler(dispatcher, {
      accept,
    } as never);
    handler.onModuleInit();

    await dispatcher.execute(task);

    expect(accept).toHaveBeenCalledWith(9, 7);
  });
});
