import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminsPage } from './admins-page';

const state = vi.hoisted(() => ({
  role: 'SUPER_ADMIN',
  targetRole: 'VIEWER',
  account: 'admin',
}));
const mutation = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-me', () => ({
  useMe: () => ({ data: { role: state.role } }),
}));
vi.mock('@/hooks/use-admins', () => ({
  useAdmins: () => ({
    data: {
      total: 1,
      list: [
        {
          id: 9,
          userId: 42,
          account: state.account,
          role: state.targetRole,
          enabled: true,
          twoFactorEnabled: false,
        },
      ],
    },
  }),
  useDisableAdmin: () => mutation,
  useEnableAdmin: () => mutation,
  useSetAdminRole: () => mutation,
  useResetAdminTwoFactor: () => mutation,
}));
function mount() {
  render(
    <MemoryRouter>
      <AdminsPage />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  state.role = 'SUPER_ADMIN';
  state.targetRole = 'VIEWER';
  state.account = 'admin';
  mutation.mutateAsync.mockReset().mockResolvedValue(undefined);
});
describe('admin role confirmation', () => {
  it('shows a role badge and only submits a role change after confirmation', async () => {
    mount();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('admins.add')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'admins.action.setRole' }),
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(
      screen.queryByRole('option', { name: 'roles.super' }),
    ).not.toBeInTheDocument();
    const option = await screen.findByRole('option', { name: 'roles.admin' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    expect(mutation.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await waitFor(() =>
      expect(mutation.mutateAsync).toHaveBeenCalledWith({
        id: 9,
        role: 'ADMIN',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });
  it.each(['ADMIN', 'VIEWER'])('does not expose management to %s', (role) => {
    state.role = role;
    mount();
    expect(
      screen.queryByRole('button', { name: 'admins.action.setRole' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'admins.action.disable' }),
    ).not.toBeInTheDocument();
  });
  it('protects super administrators by role regardless of account name', () => {
    state.targetRole = 'SUPER_ADMIN';
    state.account = 'another-root';
    mount();
    expect(
      screen.queryByRole('button', { name: 'admins.action.setRole' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'admins.action.disable' }),
    ).not.toBeInTheDocument();
  });
});
