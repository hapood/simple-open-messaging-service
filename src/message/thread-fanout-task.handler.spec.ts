import { describe, expect, it, vi } from 'vitest';
import { ThreadFanoutTaskHandler } from './thread-fanout-task.handler.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';

function setup() {
  const dispatcher = new DurableTaskDispatcherService();
  const participants = {
    getActiveParticipantUserIds: vi.fn().mockResolvedValue([
      { userId: 1, blocked: false, muted: true },
      { userId: 2, blocked: true, muted: false },
    ]),
  };
  const feed = {
    readEndId: vi.fn().mockResolvedValue(12),
    notifyFeedUpdates: vi.fn(),
  };
  const push = { enqueueForMessage: vi.fn() };
  const progress = {
    read: vi.fn().mockResolvedValue({ phase: 'FEED', afterAccountId: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
    projectBatch: vi
      .fn()
      .mockImplementation(async (_task, _target, ids: number[]) =>
        ids.map((userId) => ({
          userId,
          unreadCountChanged: userId !== 2,
          previewChanged: false,
        })),
      ),
    yieldToNewer: vi.fn().mockResolvedValue(false),
  };
  const handler = new ThreadFanoutTaskHandler(
    dispatcher,
    participants as never,
    feed as never,
    push as never,
    progress as never,
    {
      onThreadFeedUpdated: (
        userId: number,
        data: { threadFeedEndId: number },
      ) => feed.notifyFeedUpdates([{ userId, feedId: data.threadFeedEndId }]),
    } as never,
  );
  handler.onModuleInit();
  const task = {
    id: 1n,
    kind: 'PROJECTION',
    scopeType: 'THREAD',
    taskType: 'FAN_OUT_THREAD_CONTENT',
    scopeKey: '["THREAD_FANOUT",7]',
    payload: {
      threadId: 7,
      messageEndSeq: 10,
      tombstoneEndSeq: 2,
    },
  // Partial double: the handler only reads identity/scope/payload here; the
  // row's bookkeeping columns are irrelevant to these paths.
  } as unknown as DurableTask;
  return {
    dispatcher,
    participants,
    feed,
    push,
    progress,
    handler,
    task,
  };
}

describe('durable thread fanout handler', () => {
  it.each([0, 1, 2, 50, 51, 101])(
    'uses the same direct batch loop for %s recipients',
    async (count) => {
      const h = setup();
      h.progress.read.mockResolvedValue({ phase: 'FEED', afterAccountId: 0 });
      h.participants.getActiveParticipantUserIds.mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({
          userId: count - i,
          blocked: false,
          muted: false,
        })),
      );
      await h.handler.execute(h.task);
      expect(h.progress.projectBatch).toHaveBeenCalledTimes(
        Math.ceil(count / 50),
      );
      expect(
        h.progress.projectBatch.mock.calls.flatMap((call) => call[2]),
      ).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      expect(h.progress.yieldToNewer).toHaveBeenCalledTimes(
        Math.ceil(count / 50),
      );
      expect(h.progress.save).toHaveBeenLastCalledWith(h.task.id, {
        phase: 'DONE',
        afterAccountId: 0,
      });
    },
  );

  it('resumes the same loop after the committed account checkpoint', async () => {
    const h = setup();
    h.progress.read.mockResolvedValue({ phase: 'FEED', afterAccountId: 50 });
    h.participants.getActiveParticipantUserIds.mockResolvedValue(
      Array.from({ length: 53 }, (_, i) => ({
        userId: i + 1,
        blocked: false,
        muted: false,
      })),
    );
    await h.handler.execute(h.task);
    expect(h.progress.projectBatch).toHaveBeenCalledExactlyOnceWith(
      h.task.id,
      h.task.payload,
      [51, 52, 53],
    );
  });

  it('still fails on database projection errors without issuing notification hints', async () => {
    const h = setup();
    h.progress.projectBatch.mockRejectedValue(new Error('database rollback'));
    await expect(h.handler.execute(h.task)).rejects.toThrow(
      'database rollback',
    );
    expect(h.feed.notifyFeedUpdates).not.toHaveBeenCalled();
    expect(h.push.enqueueForMessage).not.toHaveBeenCalled();
    expect(h.progress.save).not.toHaveBeenCalledWith(1n, {
      phase: 'DONE',
      afterAccountId: 0,
    });
  });

  it('yields after a committed database batch without processing remaining recipients', async () => {
    const h = setup();
    h.progress.read.mockResolvedValue({ phase: 'FEED', afterAccountId: 0 });
    h.participants.getActiveParticipantUserIds.mockResolvedValue(
      Array.from({ length: 75 }, (_, i) => ({
        userId: i + 1,
        blocked: false,
        muted: false,
      })),
    );
    h.progress.projectBatch.mockImplementationOnce(async () => {
      h.progress.yieldToNewer.mockResolvedValue(true);
      return [];
    });
    await h.handler.execute(h.task);
    expect(h.progress.projectBatch).toHaveBeenCalledTimes(1);
    expect(h.progress.projectBatch.mock.calls[0][2]).toHaveLength(50);
    expect(h.progress.save).not.toHaveBeenCalled();
  });

  it('does not replay completed batches while awaiting scheduler finalization', async () => {
    const h = setup();
    h.progress.read.mockResolvedValue({ phase: 'DONE', afterAccountId: 0 });
    await h.handler.execute(h.task);
    expect(h.participants.getActiveParticipantUserIds).not.toHaveBeenCalled();
    expect(h.push.enqueueForMessage).not.toHaveBeenCalled();
  });

  it('resumes database projection after its saved recipient cursor', async () => {
    const h = setup();
    h.progress.read.mockResolvedValue({ phase: 'FEED', afterAccountId: 1 });
    await h.handler.execute(h.task);
    expect(h.progress.projectBatch).toHaveBeenCalledWith(1n, h.task.payload, [
      2,
    ]);
    expect(h.progress.save).toHaveBeenLastCalledWith(1n, {
      phase: 'DONE',
      afterAccountId: 0,
    });
  });

  it('does not fail database fanout when a push attempt rejects', async () => {
    const h = setup();
    h.push.enqueueForMessage.mockImplementationOnce(() => {
      throw new Error('provider unavailable');
    });
    await expect(h.dispatcher.execute(h.task)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(h.push.enqueueForMessage).toHaveBeenCalled());
    expect(h.progress.save).toHaveBeenLastCalledWith(1n, {
      phase: 'DONE',
      afterAccountId: 0,
    });
  });

  it('sends every projection to SSE and only count or preview changes to Push', async () => {
    const h = setup();
    h.progress.projectBatch.mockResolvedValue([
      { userId: 1, unreadCountChanged: false, previewChanged: false },
      { userId: 2, unreadCountChanged: true, previewChanged: false },
      { userId: 3, unreadCountChanged: false, previewChanged: true },
    ]);
    await h.handler.execute(h.task);
    await vi.waitFor(() =>
      expect(h.feed.notifyFeedUpdates).toHaveBeenCalledTimes(3),
    );
    expect(
      h.push.enqueueForMessage.mock.calls.flatMap(([targets]) => targets),
    ).toEqual([
      { userId: 2, threadFeedEndId: 12 },
      { userId: 3, threadFeedEndId: 12 },
    ]);
  });

  it('does not fail database fanout when SSE hint registration throws', async () => {
    const h = setup();
    h.feed.notifyFeedUpdates.mockImplementation(() => {
      throw new Error('hint failed');
    });
    await expect(h.handler.execute(h.task)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(h.feed.notifyFeedUpdates).toHaveBeenCalled());
    expect(h.push.enqueueForMessage).toHaveBeenCalled();
    expect(h.progress.save).toHaveBeenLastCalledWith(1n, {
      phase: 'DONE',
      afterAccountId: 0,
    });
  });

  it('rejects mismatched scopes before waiting and unregisters on shutdown', async () => {
    const h = setup();
    await expect(
      h.handler.execute({ ...h.task, scopeKey: '["THREAD_FANOUT",8]' }),
    ).rejects.toThrow('scope mismatch');
    h.handler.onModuleDestroy();
    expect(h.dispatcher.supportedTaskTypes).not.toContain(
      'FAN_OUT_THREAD_CONTENT',
    );
  });
});
