import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { GroupMetaHeadFanoutTaskHandler } from './group-projection-task.handlers.js';

const task = {
  id: 1n,
  parentTaskId: null,
  kind: 'PROJECTION',
  scopeType: 'GROUP',
  scopeKey: 'group',
  taskType: 'FAN_OUT_GROUP_META_HEAD',
  actorUserId: null,
  payload: { threadId: 7 },
  checkpoint: { afterAudienceId: '0' },
  coalescingKey: 'projection',
  supersededByTaskId: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('GroupMetaHeadFanoutTaskHandler', () => {
  it('registers, validates, and delegates the closed payload', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const execute = vi.fn().mockResolvedValue(undefined);
    const handler = new GroupMetaHeadFanoutTaskHandler(dispatcher, {
      execute,
    } as never);
    handler.onModuleInit();

    await dispatcher.execute(task);

    expect(execute).toHaveBeenCalledWith(task, { threadId: 7 });
    handler.onModuleDestroy();
    expect(dispatcher.supportedTaskTypes).toEqual([]);
  });
});
