import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTable } from './session-table';

const state = vi.hoisted(() => ({ canManage: true, mutateAsync: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}));
vi.mock('@/hooks/use-me', () => ({ useIsAdminPlus: () => state.canManage }));
vi.mock('@/hooks/use-sessions', () => ({
  useRevokeSession: () => ({
    mutateAsync: state.mutateAsync,
    isPending: false,
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const session = {
  id: 11,
  userId: 42,
  user: { id: 42, account: 'alice' },
  client: 'web',
  device: 'Chrome',
  userAgent: null,
  ip: '192.0.2.1',
  lastSeenIp: '192.0.2.2',
  createdAt: 1,
  lastSeenAt: 2,
  expiresAt: 1000,
  autoTerminateDays: 90,
};
const renderTable = () =>
  render(
    <MemoryRouter>
      <SessionTable sessions={[session]} showUser />
    </MemoryRouter>,
  );

describe('SessionTable', () => {
  beforeEach(() => {
    state.canManage = true;
    state.mutateAsync.mockReset().mockResolvedValue(undefined);
  });
  it('links to the user and requires confirmation before revoking one credential', async () => {
    renderTable();
    expect(screen.getByRole('link', { name: 'alice' })).toHaveAttribute(
      'href',
      '/users/42',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'userSessions.revoke' }),
    );
    expect(state.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'userSessions.confirmRevoke' }),
    );
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledWith(11));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'userSessions.confirmRevoke' }),
      ).not.toBeInTheDocument(),
    );
  });
  it.each([7, 30, 90, 180, 365])(
    'shows the %s-day inactivity policy alongside the current deadline',
    (days) => {
      render(
        <MemoryRouter>
          <SessionTable sessions={[{ ...session, autoTerminateDays: days }]} />
        </MemoryRouter>,
      );
      expect(
        screen.getByRole('columnheader', {
          name: 'userSessions.col.inactivity',
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(`userSessions.inactivityDays:${days}`),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('columnheader', { name: 'userSessions.col.expires' }),
      ).toBeInTheDocument();
      expect(screen.queryByText('common.neverExpires')).not.toBeInTheDocument();
    },
  );
  it('does not expose revocation to viewers', () => {
    state.canManage = false;
    renderTable();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('allows cancelling confirmation without a mutation', () => {
    renderTable();
    fireEvent.click(
      screen.getByRole('button', { name: 'userSessions.revoke' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });
  it('keeps the confirmation available when revocation fails', async () => {
    state.mutateAsync.mockRejectedValue(new Error('offline'));
    renderTable();
    fireEvent.click(
      screen.getByRole('button', { name: 'userSessions.revoke' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'userSessions.confirmRevoke' }),
    );
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledWith(11));
    expect(
      screen.getByRole('button', { name: 'userSessions.confirmRevoke' }),
    ).toBeInTheDocument();
  });
});
