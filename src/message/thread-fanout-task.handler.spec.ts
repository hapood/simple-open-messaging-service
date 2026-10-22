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
  const push = { enqueueForMessage: vi.fn().mockResolvedValue(undefined) };
  const sse = { onThreadFeedUpdated: vi.fn() };
  sse.onThreadFeedUpdated.mockImplementation(
    (userId: number, data: { threadFeedEndId: number }) =>
      feed.notifyFeedUpdates([{ userId, feedId: data.threadFeedEndId }]),
  );
  const progress = {
    read: vi.fn().mockResolvedValue({ phase: 'FEED', afterAccountId: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
    projectActiveAccount: vi
      .fn()
      .mockImplementation(async (_task, _target, userId: number) => [
        {
          userId,
          unreadCountChanged: userId !== 2,
          previewChanged: false,
        },
      ]),
    yieldToNewer: vi.fn().mockResolvedValue(false),
  };
  const handler = new ThreadFanoutTaskHandler(
    dispatcher,
    participants as never,
    feed as never,
    push as never,
    progress as never,
    sse as never,
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
    sse,
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
      expect(h.progress.projectActiveAccount).toHaveBeenCalledTimes(count);
      expect(
        h.progress.projectActiveAccount.mock.calls.map((call) => call[2]),
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
    expect(h.progress.projectActiveAccount.mock.calls).toEqual(
      [51, 52, 53].map((userId) => [h.task.id, h.task.payload, userId]),
    );
  });

  it('still fails on database projection errors without issuing notification hints', async () => {
    const h = setup();
    h.progress.projectActiveAccount.mockRejectedValue(
      new Error('database rollback'),
    );
    await expect(h.handler.execute(h.task)).rejects.toThrow(
      'database rollback',
    );
    expect(h.feed.notifyFeedUpdates).not.toHaveBeenCalled();
    expect(h.sse.onThreadFeedUpdated).not.toHaveBeenCalled();
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
    h.progress.projectActiveAccount.mockImplementationOnce(async () => {
      h.progress.yieldToNewer.mockResolvedValue(true);
      return [];
    });
    await h.handler.execute(h.task);
    expect(h.progress.projectActiveAccount).toHaveBeenCalledTimes(50);
    expect(h.progress.save).not.toHaveBeenCalled();
  });

  it('does not replay completed batches while awaiting scheduler finalization', async () => {
    const h = setup();
    h.progress.read.mockResolvedValue({ phase: 'DONE', afterAccountId: 0 });
    await h.handler.execute(h.task);
    expect(h.participants.getActiveParticipantUserIds).not.toHaveBeenCalled();
    expect(h.sse.onThreadFeedUpdated).not.toHaveBeenCalled();
  });

  it('resumes database projection after its saved recipient cursor', async () => {
    const h = setup();
    h.progress.read.mockResolvedValue({ phase: 'FEED', afterAccountId: 1 });
    await h.handler.execute(h.task);
    expect(h.progress.projectActiveAccount).toHaveBeenCalledWith(
      1n,
      h.task.payload,
      2,
    );
    expect(h.progress.save).toHaveBeenLastCalledWith(1n, {
      phase: 'DONE',
      afterAccountId: 0,
    });
  });

  it('marks only count or preview changes as receipt-bearing SSE hints', async () => {
    const h = setup();
    h.participants.getActiveParticipantUserIds.mockResolvedValue(
      [1, 2, 3].map((userId) => ({
        userId,
        blocked: false,
        muted: false,
      })),
    );
    h.progress.projectActiveAccount.mockImplementation(
      async (_task, _target, userId: number) => [
        {
          userId,
          unreadCountChanged: userId === 2,
          previewChanged: userId === 3,
        },
      ],
    );
    await h.handler.execute(h.task);
    await vi.waitFor(() =>
      expect(h.feed.notifyFeedUpdates).toHaveBeenCalledTimes(3),
    );
    expect(
      h.sse.onThreadFeedUpdated.mock.calls.map(([userId, data]) => [
        userId,
        data.notificationRelevant,
      ]),
    ).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
  });

  it('does not fail database fanout when SSE hint registration throws', async () => {
    const h = setup();
    h.feed.notifyFeedUpdates.mockImplementation(() => {
      throw new Error('hint failed');
    });
    await expect(h.handler.execute(h.task)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(h.feed.notifyFeedUpdates).toHaveBeenCalled());
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
