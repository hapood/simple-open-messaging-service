import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { useGrantViewer } from './use-admins';
import { grantViewer } from '@/api/admins';

vi.mock('@/api/admins', () => ({
  grantViewer: vi.fn(),
}));

describe('useGrantViewer', () => {
  it('refreshes revoked consumer credentials and admin access without touching unrelated views', async () => {
    vi.mocked(grantViewer).mockResolvedValue({ id: 7 });
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const affected = [
      ['admin', 'users'],
      ['admin', 'users', 42, 'sessions'],
      ['admin', 'users', 42, 'detail'],
      ['admin', 'admin-sessions'],
      ['admin', 'sessions', { client: 'web' }],
      ['admin', 'connections'],
      ['admin', 'dashboard'],
    ];
    const unrelated = ['admin', 'federation'];
    for (const key of [...affected, unrelated]) client.setQueryData(key, {});
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useGrantViewer(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(42);
    });
    expect(grantViewer).toHaveBeenCalledWith(42);
    for (const key of affected)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
    unmount();
    client.clear();
  });
});
