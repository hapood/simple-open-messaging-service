import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadActivityService } from './upload-activity.service.js';

const task = { taskId: 'upload', userId: 1 };

describe('UploadActivityService', () => {
  let activity: UploadActivityService;
  beforeEach(() => {
    vi.useFakeTimers();
    activity = new UploadActivityService();
  });
  afterEach(() => {
    activity.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('expires a new waiting upload at exactly 30s; repeated watch is not progress', async () => {
    const fail = vi.fn();
    const handle = activity.watch(task, fail);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(activity.watch(task, fail)).toBe(handle);
    activity.waiting(handle);
    expect(fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fail).toHaveBeenCalledOnce();
    expect(fail.mock.calls[0][0].isCurrent()).toBe(true);
  });

  it('renews only positive body bytes, not headers or zero-length activity', async () => {
    const fail = vi.fn();
    const cancel = vi.fn();
    const handle = activity.watch(task, fail);
    await vi.advanceTimersByTimeAsync(20_000);
    const receive = activity.beginReceiving(handle, cancel)!;
    activity.activity(receive, 0);
    await vi.advanceTimersByTimeAsync(9_999);
    activity.activity(receive, 1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fail).not.toHaveBeenCalled();
    activity.activity(receive, -1);
    activity.activity(receive, Number.NaN);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledWith('idle');
    expect(fail).toHaveBeenCalledOnce();
  });

  it('does not let another owner, stale attempt, or concurrent receiver alter a timer', async () => {
    const fail = vi.fn();
    const handle = activity.watch(task, fail);
    expect(
      activity.beginReceiving({ task: { ...task, userId: 2 } }, vi.fn()),
    ).toBeUndefined();
    expect(
      activity.beginReceiving({ task: { ...task } }, vi.fn()),
    ).toBeUndefined();
    const receive = activity.beginReceiving(handle, vi.fn())!;
    expect(activity.beginReceiving(handle, vi.fn())).toBeUndefined();
    activity.activity(receive, 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fail).toHaveBeenCalledOnce();
  });

  it('has no idle timer during processing, and starts 30s between chunks', async () => {
    const fail = vi.fn();
    const handle = activity.watch(task, fail);
    const receive = activity.beginReceiving(handle, vi.fn())!;
    activity.activity(receive, 8);
    activity.endReceiving(receive);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fail).not.toHaveBeenCalled();
    activity.releaseReceiving(receive);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fail).toHaveBeenCalledOnce();
    activity.stop(handle);
  });

  it('does not rearm a domain-suspended receive when its response finishes', async () => {
    const fail = vi.fn();
    const handle = activity.watch(task, fail);
    const receive = activity.beginReceiving(handle, vi.fn())!;
    activity.endReceiving(receive);
    activity.suspend(handle);
    activity.releaseReceiving(receive);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fail).not.toHaveBeenCalled();
    activity.waiting(handle);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fail).toHaveBeenCalledOnce();
  });

  it('disconnect retains the last positive byte deadline, rather than granting another 30s', async () => {
    const fail = vi.fn();
    const handle = activity.watch(task, fail);
    const receive = activity.beginReceiving(handle, vi.fn())!;
    activity.activity(receive, 1);
    await vi.advanceTimersByTimeAsync(25_000);
    activity.releaseReceiving(receive);
    activity.releaseReceiving(receive);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fail).toHaveBeenCalledOnce();
  });

  it('invalidates already-queued timeout callbacks on stop/retry and rejects stale cleanup', async () => {
    const oldFail = vi.fn();
    const old = activity.watch(task, oldFail);
    const oldReceive = activity.beginReceiving(old, vi.fn())!;
    await vi.advanceTimersByTimeAsync(30_000);
    const timeout = oldFail.mock.calls[0][0];
    const fail = vi.fn();
    activity.stop(old);
    const next = activity.watch(task, fail);
    expect(activity.beginReceiving(old, vi.fn())).toBeUndefined();
    expect(timeout.isCurrent()).toBe(false);
    activity.stop(old);
    activity.endReceiving(oldReceive);
    activity.releaseReceiving(oldReceive);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fail).toHaveBeenCalledOnce();
    expect(next).not.toBe(old);
  });

  it('invalidates queued failure before it acquires a domain processing lock', async () => {
    const fail = vi.fn();
    const handle = activity.watch(task, fail);
    await vi.advanceTimersByTimeAsync(30_000);
    const timeout = fail.mock.calls[0][0];
    activity.suspend(handle);
    expect(timeout.isCurrent()).toBe(false);
  });

  it('uses elapsed time despite wall-clock changes and does not renew on empty bodies', async () => {
    const fail = vi.fn();
    const handle = activity.watch(task, fail);
    await vi.advanceTimersByTimeAsync(20_000);
    vi.setSystemTime(new Date('2040-01-01'));
    const receive = activity.beginReceiving(handle, vi.fn())!;
    activity.endReceiving(receive);
    activity.releaseReceiving(receive);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fail).toHaveBeenCalledOnce();
  });

  it('shutdown cancels active receivers and prevents new timers', async () => {
    const fail = vi.fn();
    const cancel = vi.fn();
    const handle = activity.watch(task, fail);
    activity.beginReceiving(handle, cancel);
    activity.onApplicationShutdown();
    expect(cancel).toHaveBeenCalledWith('stopped');
    activity.watch(task, fail);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
