import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { RevokeRelationshipRequestTaskHandler } from './revoke-relationship-request-task.handler.js';

const task = {
  id: 3n,
  kind: 'MUTATION',
  scopeType: 'USER_PAIR',
  scopeKey: 'pair-key',
  taskType: 'REVOKE_RELATIONSHIP_REQUEST',
  actorUserId: 7,
  payload: { peerUserId: 9 },
  checkpoint: {},
  coalescingKey: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('RevokeRelationshipRequestTaskHandler', () => {
  it('routes the persisted task to the shared execution service', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const revoke = vi.fn().mockResolvedValue(undefined);
    const handler = new RevokeRelationshipRequestTaskHandler(dispatcher, {
      revoke,
    } as never);
    handler.onModuleInit();

    await dispatcher.execute(task);

    expect(revoke).toHaveBeenCalledWith(9, 7);
  });
});
