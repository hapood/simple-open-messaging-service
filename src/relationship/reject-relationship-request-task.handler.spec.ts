import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { RejectRelationshipRequestTaskHandler } from './reject-relationship-request-task.handler.js';

function task(payload: Record<string, unknown> = {}): DurableTask {
  return {
    id: 2n,
    kind: 'MUTATION',
    scopeType: 'USER_PAIR',
    scopeKey: 'pair-key',
    taskType: 'REJECT_RELATIONSHIP_REQUEST',
    actorUserId: 7,
    payload: { peerUserId: 9, ...payload },
    checkpoint: {},
    coalescingKey: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

describe('RejectRelationshipRequestTaskHandler', () => {
  it('routes the persisted task to the shared execution service', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const reject = vi.fn().mockResolvedValue(undefined);
    const handler = new RejectRelationshipRequestTaskHandler(dispatcher, {
      reject,
    } as never);
    handler.onModuleInit();

    await dispatcher.execute(task());

    expect(reject).toHaveBeenCalledWith(9, 7);
  });

  it('rejects malformed persisted payloads', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const reject = vi.fn();
    const handler = new RejectRelationshipRequestTaskHandler(dispatcher, {
      reject,
    } as never);
    handler.onModuleInit();

    await expect(
      dispatcher.execute(task({ peerUserId: 'not-an-id' })),
    ).rejects.toThrow('invalid peer user ID');
    expect(reject).not.toHaveBeenCalled();
  });
});
