import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSessionsPage } from './admin-sessions-page';
const state = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  foreignAllowed: false,
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-admin-sessions', () => ({
  useRevokeAdminSession: () => ({
    mutateAsync: state.mutateAsync,
    isPending: false,
  }),
  useAdminSessions: () => ({
    isLoading: false,
    refetch: vi.fn(),
    data: {
      total: 3,
      list: [
        {
          id: '1',
          adminId: 1,
          admin: { account: 'current' },
          isCurrent: true,
          canRevoke: false,
        },
        {
          id: '2',
          adminId: 1,
          admin: { account: 'own-other' },
          isCurrent: false,
          canRevoke: true,
        },
        {
          id: '3',
          adminId: 2,
          admin: { account: 'foreign' },
          isCurrent: false,
          canRevoke: state.foreignAllowed,
        },
      ].map((row) => ({
        ...row,
        createdAt: 1,
        lastAccessedAt: 1,
        expiresAt: 1000,
        ip: '192.0.2.1',
        userAgent: 'browser',
      })),
    },
  }),
}));
const mount = () =>
  render(
    <MemoryRouter>
      <AdminSessionsPage />
    </MemoryRouter>,
  );
describe('AdminSessionsPage', () => {
  beforeEach(() => {
    state.foreignAllowed = false;
    state.mutateAsync.mockReset().mockResolvedValue(undefined);
  });
  it('only offers allowed actions and requires confirmation', async () => {
    mount();
    expect(
      screen.getAllByRole('button', { name: 'adminSessions.revoke' }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'adminSessions.revoke' }),
    );
    expect(state.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'adminSessions.revoke',
      }),
    );
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledWith('2'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });
  it('allows an authorized foreign session but never offers the current session', () => {
    state.foreignAllowed = true;
    mount();
    expect(
      screen.getAllByRole('button', { name: 'adminSessions.revoke' }),
    ).toHaveLength(2);
    const current = screen.getByText('current').closest('tr')!;
    expect(within(current).queryByRole('button')).not.toBeInTheDocument();
  });
  it('cancels without signing out', () => {
    mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'adminSessions.revoke' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });
});
