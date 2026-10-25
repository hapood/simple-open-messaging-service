import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserAccessStatus } from './user-access-status';
const state = vi.hoisted(() => ({
  error: null as Error | null,
  loading: false,
  restricted: false,
  refetch: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === 'userAccess.connectionCount' || key === 'userAccess.pushCount'
        ? `${key}:${options?.count}`
        : key,
  }),
}));
vi.mock('@/hooks/use-bans', () => ({
  useBans: () => ({
    data: [
      { type: 'ip', value: 'alice', until: Date.now() + 10000 },
      { type: 'user', value: 'bob', until: Date.now() + 10000 },
      {
        type: 'otp',
        value: 'alice',
        until: state.restricted ? Date.now() + 10000 : 1,
      },
    ],
    error: state.error,
    isLoading: state.loading,
    refetch: state.refetch,
  }),
}));
vi.mock('@/hooks/use-connections', () => ({
  useConnections: () => ({
    data: {
      clients: [
        { userId: 42, connections: 2 },
        { userId: 43, connections: 8 },
      ],
    },
    error: state.error,
    isLoading: state.loading,
    dataUpdatedAt: 1,
    refetch: state.refetch,
  }),
}));
const mount = (disabled = false) =>
  render(
    <MemoryRouter>
      <UserAccessStatus
        userId={42}
        account="alice"
        disabled={disabled}
        pushRegistrations={3}
      />
    </MemoryRouter>,
  );
describe('UserAccessStatus', () => {
  beforeEach(() => {
    state.error = null;
    state.loading = false;
    state.restricted = false;
    state.refetch.mockClear();
  });
  it('keeps account, account-only restrictions, connections and registrations distinct', () => {
    mount();
    expect(screen.getByText('users.status.active')).toBeInTheDocument();
    expect(screen.getByText('userAccess.unrestricted')).toBeInTheDocument();
    expect(
      screen.getByText('userAccess.connectionCount:2'),
    ).toBeInTheDocument();
    expect(screen.getByText('userAccess.pushCount:3')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'userAccess.viewConnections' }),
    ).toHaveAttribute('href', '/connections?userId=42');
  });
  it('shows an account restriction independently from account disablement', () => {
    state.restricted = true;
    mount(true);
    expect(screen.getByText('userAccess.restricted')).toBeInTheDocument();
    expect(screen.getByText('users.status.banned')).toBeInTheDocument();
  });
  it('does not present stale observations as healthy after a query failure', () => {
    state.error = new Error('offline');
    mount();
    expect(screen.getAllByText('userAccess.unavailable')).toHaveLength(2);
    expect(
      screen.queryByText('userAccess.unrestricted'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('userAccess.connectionCount:2'),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'security.account.refresh' })[0],
    );
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it('does not show a zero or unrestricted state before queries complete', () => {
    state.loading = true;
    mount();
    expect(screen.getAllByText('common.loading')).toHaveLength(2);
  });
});
