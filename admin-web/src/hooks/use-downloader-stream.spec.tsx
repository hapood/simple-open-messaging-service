import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeSse } from '../../../shared/sse-client';
import { forceLogout } from '@/auth/force-logout';
import { useDownloaderStream } from './use-downloader-stream';

vi.mock('../../../shared/sse-client', () => ({ consumeSse: vi.fn() }));
vi.mock('@/auth/force-logout', () => ({ forceLogout: vi.fn() }));
type Options = Parameters<typeof consumeSse>[1];
let attempts: { url: string; options: Options; close: () => void }[];
beforeEach(() => {
  vi.useFakeTimers();
  attempts = [];
  vi.mocked(consumeSse).mockImplementation(
    (url, options) =>
      new Promise<void>((resolve) => {
        attempts.push({ url, options, close: resolve });
        options.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
      }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('downloader SSE snapshots', () => {
  it('replaces snapshots after reconnect rather than appending stale transfers', async () => {
    const hook = renderHook(() => useDownloaderStream(0, 25));
    act(() =>
      attempts[0].options.onFrame({
        event: 'snapshot',
        data: JSON.stringify({ total: 1, list: [{ digest: 'a' }] }),
      }),
    );
    expect(hook.result.current.state).toBe('open');
    await act(async () => attempts[0].close());
    expect(hook.result.current.state).toBe('reconnecting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() =>
      attempts[1].options.onFrame({
        event: 'snapshot',
        data: JSON.stringify({ total: 0, list: [] }),
      }),
    );
    expect(hook.result.current.snapshot?.list).toEqual([]);
    hook.unmount();
  });

  it('aborts the old page connection and clears its snapshot when paging', () => {
    const hook = renderHook(({ page }) => useDownloaderStream(page, 25), {
      initialProps: { page: 0 },
    });
    act(() =>
      attempts[0].options.onFrame({
        event: 'snapshot',
        data: '{"total":1,"list":[]}',
      }),
    );
    hook.rerender({ page: 1 });
    expect(attempts[0].options.signal.aborted).toBe(true);
    expect(attempts[1].url).toContain('skip=25&take=25');
    expect(hook.result.current.snapshot).toBeUndefined();
    hook.unmount();
  });

  it('ends access without retrying after role revocation', async () => {
    const hook = renderHook(() => useDownloaderStream(0, 25));
    act(() =>
      attempts[0].options.onFrame({ event: 'access-revoked', data: '{}' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(hook.result.current.state).toBe('closed');
    expect(attempts).toHaveLength(1);
    expect(hook.result.current.snapshot).toBeUndefined();
    hook.unmount();
  });

  it('logs out on 401 and releases retry timers on unmount', async () => {
    const hook = renderHook(() => useDownloaderStream(0, 25));
    await act(async () =>
      attempts[0].options.onResponse?.({ status: 401 } as Response),
    );
    expect(forceLogout).toHaveBeenCalledOnce();
    hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(attempts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
