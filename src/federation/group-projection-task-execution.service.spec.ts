import { describe, expect, it, vi } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';
import { GroupProjectionTaskExecutionService } from './group-projection-task-execution.service.js';

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

describe('GroupProjectionTaskExecutionService', () => {
  it('publishes only audience hints retained after the page commit', async () => {
    const notifyFeedUpdates = vi.fn();
    const emit = vi.fn();
    const service = Object.create(
      GroupProjectionTaskExecutionService.prototype,
    ) as GroupProjectionTaskExecutionService;
    const processNextPage = vi
      .fn()
      .mockResolvedValueOnce({
        processed: true,
        clientUpdates: [{ audienceId: 3n, userId: 2, feedId: 9 }],
        peerTargets: [
          { audienceId: 4n, peerDomain: 'b.test' },
          { audienceId: 5n, peerDomain: 'c.test' },
        ],
      })
      .mockResolvedValueOnce({
        processed: false,
        clientUpdates: [],
        peerTargets: [],
      });
    const retainCurrentAudience = vi.fn().mockResolvedValue({
      processed: true,
      clientUpdates: [{ audienceId: 3n, userId: 2, feedId: 9 }],
      peerTargets: [{ audienceId: 4n, peerDomain: 'b.test' }],
    });
    Object.assign(service, {
      clientStateFeed: { notifyFeedUpdates },
      events: { emit },
      processNextPage,
      retainCurrentAudience,
    });

    await service.execute(task, { threadId: 7 });

    expect(processNextPage).toHaveBeenCalledTimes(2);
    expect(retainCurrentAudience).toHaveBeenCalledOnce();
    expect(notifyFeedUpdates).toHaveBeenCalledOnce();
    expect(notifyFeedUpdates).toHaveBeenCalledWith([{ userId: 2, feedId: 9 }]);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(FEDERATION_STATE_FEED_PUSH, {
      peerDomain: 'b.test',
    });
  });

  it('yields at the page boundary when a newer pending task exists', async () => {
    const notifyFeedUpdates = vi.fn();
    const emit = vi.fn();
    const limit = vi
      .fn()
      .mockResolvedValueOnce([{ account: '!group', domain: 'local' }])
      .mockResolvedValueOnce([{ id: 2n }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi
      .fn()
      .mockReturnValue({ where, innerJoin: () => ({ where }) });
    const select = vi.fn().mockReturnValue({ from });
    const transactionContext = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            status: 'PROCESSING',
            taskType: 'FAN_OUT_GROUP_META_HEAD',
            coalescingKey: 'projection',
            afterAudienceId: '10',
          },
        ],
      }),
      select,
    };
    const transaction = vi.fn(
      (callback: (tx: typeof transactionContext) => Promise<unknown>) =>
        callback(transactionContext),
    );
    const service = Object.create(
      GroupProjectionTaskExecutionService.prototype,
    ) as GroupProjectionTaskExecutionService;
    Object.assign(service, {
      database: { db: { transaction } },
      clientStateFeed: { notifyFeedUpdates },
      peerStateFeed: { writeManyInTx: vi.fn() },
      events: { emit },
    });

    await service.execute(task, { threadId: 7 });

    expect(transaction).toHaveBeenCalledOnce();
    expect(transactionContext.execute).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledTimes(2);
    expect(notifyFeedUpdates).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
