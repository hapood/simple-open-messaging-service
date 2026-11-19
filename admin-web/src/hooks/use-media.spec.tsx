import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '@/api/client';
import { useMediaCommand } from './use-media';

vi.mock('@/api/client', () => ({ request: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('media lifecycle command wiring', () => {
  it.each([
    ['upload-stop', '/admin/media/uploads/task-id/stop'],
    ['upload-retry', '/admin/media/uploads/task-id/retry'],
    ['download-stop', '/admin/media/downloads/task-id/stop'],
    ['download-retry', '/admin/media/downloads/task-id/retry'],
  ] as const)(
    'routes %s and refreshes media and dashboard data',
    async (kind, path) => {
      vi.mocked(request).mockResolvedValue({});
      const client = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      });
      const keys = [
        ['admin', 'media'],
        ['admin', 'dashboard'],
      ];
      for (const key of keys) client.setQueryData(key, {});
      client.setQueryData(['admin', 'users'], {});
      const wrapper = ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result, unmount } = renderHook(() => useMediaCommand(), {
        wrapper,
      });
      await act(async () => {
        await result.current.mutateAsync({ kind, id: 'task-id' });
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(path);
      for (const key of keys)
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      expect(client.getQueryState(['admin', 'users'])?.isInvalidated).toBe(
        false,
      );
      unmount();
      client.clear();
    },
  );
});
