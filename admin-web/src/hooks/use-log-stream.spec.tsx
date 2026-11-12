import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStream } from './use-log-stream';
import { consumeSse } from '../../../shared/sse-client';
import { forceLogout } from '@/auth/force-logout';

vi.mock('../../../shared/sse-client', () => ({ consumeSse: vi.fn() }));
vi.mock('@/auth/force-logout', () => ({ forceLogout: vi.fn() }));

type Options = Parameters<typeof consumeSse>[1];
let attempts: { options: Options; close: () => void }[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  attempts = [];
  vi.mocked(consumeSse).mockImplementation(
    (_url, options) =>
      new Promise<void>((resolve) => {
        attempts.push({ options, close: resolve });
        options.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
      }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('admin log stream projection', () => {
  it('replaces the replay snapshot after reconnect rather than appending duplicates', async () => {
    const hook = renderHook(() => useLogStream());
    act(() => {
      attempts[0].options.onOpen?.();
      attempts[0].options.onFrame({ event: 'log', data: '{"msg":"one"}' });
    });
    expect(hook.result.current.lines).toHaveLength(1);
    await act(async () => {
      attempts[0].close();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(attempts).toHaveLength(2);
    act(() => {
      attempts[1].options.onOpen?.();
      attempts[1].options.onFrame({ event: 'log', data: '{"msg":"one"}' });
    });
    expect(hook.result.current.lines).toHaveLength(1);
    hook.unmount();
  });

  it('cancels a pending backoff on unmount without opening another stream', async () => {
    const hook = renderHook(() => useLogStream());
    await act(async () => {
      attempts[0].close();
    });
    hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].options.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs out on 401 and does not retry', async () => {
    const hook = renderHook(() => useLogStream());
    await act(async () => {
      attempts[0].options.onResponse?.({ status: 401 } as Response);
    });
    expect(forceLogout).toHaveBeenCalledOnce();
    expect(hook.result.current.state).toBe('closed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(attempts).toHaveLength(1);
    hook.unmount();
  });
});
