import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersPage } from './users-page';
const state = vi.hoisted(() => ({
  role: 'SUPER_ADMIN',
  adminRole: null as string | null,
}));
const grant = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-me', () => ({
  useMe: () => ({ data: { role: state.role } }),
  useIsAdminPlus: () => state.role !== 'VIEWER',
}));
vi.mock('@/hooks/use-admins', () => ({ useGrantViewer: () => grant }));
vi.mock('@/hooks/use-admin-users', () => ({
  useAdminUsers: () => ({
    data: {
      total: 1,
      list: [
        {
          id: 42,
          account: 'admin',
          namespaceId: 0,
          adminRole: state.adminRole,
          isDeleted: false,
          createdAt: 1,
        },
      ],
    },
  }),
}));
vi.mock('@/hooks/use-public-config', () => ({
  usePublicConfig: () => ({ data: { loginMode: 1 } }),
}));
vi.mock('@/hooks/use-user-mutations', () => ({
  useDisableUser: () => grant,
  useEnableUser: () => grant,
  useForceLogoutUser: () => grant,
  useBatchUsers: () => grant,
}));
vi.mock('./sessions-dialog', () => ({ SessionsDialog: () => null }));
vi.mock('./create-user-dialog', () => ({ CreateUserDialog: () => null }));
vi.mock('./issue-login-code-dialog', () => ({
  IssueLoginCodeDialog: () => null,
}));
vi.mock('./generate-initial-password-dialog', () => ({
  GenerateInitialPasswordDialog: () => null,
}));
function mount() {
  render(
    <MemoryRouter>
      <UsersPage />
    </MemoryRouter>,
  );
}
async function openMenu() {
  const trigger = screen
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-haspopup') === 'menu')!;
  fireEvent.click(trigger);
  await screen.findByRole('menu');
}
beforeEach(() => {
  state.role = 'SUPER_ADMIN';
  state.adminRole = null;
  grant.mutateAsync.mockReset().mockResolvedValue({ id: 8 });
});
describe('user admin grant', () => {
  it('requires confirmation and sends only the target ID, regardless of account name', async () => {
    mount();
    await openMenu();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'users.action.grantViewer' }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(grant.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await waitFor(() => expect(grant.mutateAsync).toHaveBeenCalledWith(42));
  });
  it.each(['ADMIN', 'VIEWER'])('hides grants from %s', async (role) => {
    state.role = role;
    mount();
    await openMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'users.action.grantViewer' }),
    ).not.toBeInTheDocument();
    if (role === 'VIEWER')
      expect(
        screen.queryByRole('menuitem', { name: 'users.action.ban' }),
      ).not.toBeInTheDocument();
  });
  it('does not re-grant or offer account takeover actions to existing administrators', async () => {
    state.adminRole = 'VIEWER';
    mount();
    await openMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'users.action.grantViewer' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'users.action.ban' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'users.action.issueLoginCode' }),
    ).not.toBeInTheDocument();
  });
});
