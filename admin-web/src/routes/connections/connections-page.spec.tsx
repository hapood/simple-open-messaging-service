import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPage } from './connections-page';
const state = vi.hoisted(() => ({
  error: null as Error | null,
  refetch: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-connections', () => ({
  useConnections: () => ({
    data: {
      total: 3,
      uniqueUsers: 2,
      clients: [
        { userId: 42, account: 'alice', connections: 2, since: 1 },
        { userId: 43, account: 'bob', connections: 1, since: 2 },
      ],
    },
    isLoading: false,
    isFetching: false,
    dataUpdatedAt: 1000,
    error: state.error,
    refetch: state.refetch,
  }),
}));
describe('ConnectionsPage', () => {
  beforeEach(() => {
    state.error = null;
    state.refetch.mockReset();
  });
  it('scopes to a linked user and allows returning to all connections', () => {
    render(
      <MemoryRouter initialEntries={['/connections?userId=42']}>
        <ConnectionsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'alice' })).toHaveAttribute(
      'href',
      '/users/42',
    );
    expect(screen.queryByRole('link', { name: 'bob' })).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'connections.clearFilter' }),
    );
    expect(screen.getByRole('link', { name: 'bob' })).toBeInTheDocument();
  });
  it('reports paused polling on failure and offers manual recovery', () => {
    state.error = new Error('offline');
    render(
      <MemoryRouter>
        <ConnectionsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('connections.paused');
    fireEvent.click(
      screen.getByRole('button', { name: 'connections.refresh' }),
    );
    expect(state.refetch).toHaveBeenCalledOnce();
  });
});
