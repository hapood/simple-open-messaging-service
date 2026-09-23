import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CallHistoryService,
  type CallHistorySnapshot,
} from './call-history.service.js';
import { DatabaseService } from '../database/database.service.js';

const snapshot: CallHistorySnapshot = {
  key: 'test-call',
  threadId: 1,
  revision: 1,
  content: {
    type: 'CALL_ENDED',
    callId: 'test-call',
    caller: {
      account: 'alice',
      domain: 'a.test',
      namespaceId: 1,
      profileRev: 0,
    },
    callee: { account: 'bob', domain: 'b.test', namespaceId: 2, profileRev: 0 },
    mediaType: 'AUDIO',
    outcome: 'missed',
    initiatedAt: 100,
    endedAt: 500,
  },
};

describe('CallHistoryService scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('scans once on startup and performs no idle polling', async () => {
    vi.useFakeTimers();
    const where = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: () => ({ where }) }));
    const history = new CallHistoryService({
      db: { select },
    } as unknown as DatabaseService);
    await history.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(select).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry failed startup recovery', async () => {
    vi.useFakeTimers();
    const where = vi.fn().mockResolvedValue([
      {
        key: snapshot.key,
        threadId: snapshot.threadId,
        revision: snapshot.revision,
        terminal: true,
        snapshot: snapshot.content,
      },
    ]);
    const select = vi.fn(() => ({ from: () => ({ where }) }));
    const transaction = vi.fn().mockRejectedValue(new Error('recovery failed'));
    const history = new CallHistoryService({
      db: { select, transaction },
    } as unknown as DatabaseService);
    await history.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(select).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a failed terminal write without scheduling a retry', async () => {
    vi.useFakeTimers();
    const transaction = vi.fn().mockRejectedValue(new Error('write failed'));
    const history = new CallHistoryService({
      db: { transaction },
    } as unknown as DatabaseService);
    await expect(history.finish(snapshot)).rejects.toThrow('write failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
