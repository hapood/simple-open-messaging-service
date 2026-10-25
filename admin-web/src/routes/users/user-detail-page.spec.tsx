import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserDetailPage } from './user-detail-page';

const state = vi.hoisted(() => ({
  canManage: false,
  isDeleted: false,
  adminRole: null as string | null,
  adminEnabled: false,
  adminTwoFactorEnabled: false,
  adminLastLoginAt: null as number | null,
}));
const disable = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const enable = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const forceLogout = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-sessions', () => ({
  useRevokeSession: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('@/hooks/use-me', () => ({
  useIsAdminPlus: () => state.canManage,
  useMe: () => ({
    data: {
      account: 'admin',
      name: 'Admin',
      role: 'SUPER_ADMIN',
      somsDomain: 'alpha.test',
    },
  }),
}));
vi.mock('@/hooks/use-public-config', () => ({
  usePublicConfig: () => ({
    data: { registrationOpen: false, loginMode: 1 },
  }),
}));
vi.mock('@/hooks/use-user-detail', () => ({
  useUserDetail: () => ({
    isLoading: false,
    error: null,
    data: {
      user: {
        id: 42,
        adminRole: state.adminRole,
        adminEnabled: state.adminEnabled,
        adminTwoFactorEnabled: state.adminTwoFactorEnabled,
        adminLastLoginAt: state.adminLastLoginAt,
        account: 'alice',
        name: 'Alice',
        avatar: '',
        bio: '',
        namespaceId: 0,
        isDeleted: state.isDeleted,
        createdAt: 1,
        updatedAt: 1,
      },
      groups: [],
      sessions: [],
      pushTokens: [],
    },
  }),
}));
vi.mock('@/hooks/use-user-mutations', () => ({
  useDisableUser: () => disable,
  useEnableUser: () => enable,
  useForceLogoutUser: () => forceLogout,
}));
vi.mock('./issue-login-code-dialog', () => ({
  IssueLoginCodeDialog: () => null,
}));
vi.mock('./generate-initial-password-dialog', () => ({
  GenerateInitialPasswordDialog: () => null,
}));
vi.mock('./login-codes-section', () => ({ LoginCodesSection: () => null }));
vi.mock('./user-quota-panel', () => ({ UserQuotaPanel: () => null }));
vi.mock('./user-access-status', () => ({ UserAccessStatus: () => null }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/users/42']}>
      <Routes>
        <Route path="/users/:id" element={<UserDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('UserDetailPage mutation authorization', () => {
  beforeEach(() => {
    state.canManage = false;
    state.isDeleted = false;
    state.adminRole = null;
    state.adminEnabled = false;
    state.adminTwoFactorEnabled = false;
    state.adminLastLoginAt = null;
    vi.clearAllMocks();
    disable.mutateAsync.mockResolvedValue(undefined);
    enable.mutateAsync.mockResolvedValue(undefined);
    forceLogout.mutateAsync.mockResolvedValue(undefined);
  });

  it.each([true, false])(
    'shows console access and authenticator state independently (%s)',
    (enabled) => {
      state.adminRole = 'VIEWER';
      state.adminEnabled = enabled;
      state.adminTwoFactorEnabled = enabled;
      state.adminLastLoginAt = enabled ? 1700000000000 : null;
      renderPage();
      expect(screen.getByText('roles.viewer')).toBeInTheDocument();
      expect(
        screen.getByText(
          enabled ? 'userDetail.adminEnabled' : 'users.adminAccessDisabled',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(enabled ? 'security.totp.on' : 'security.totp.off'),
      ).toBeInTheDocument();
      expect(screen.getByText('users.status.active')).toBeInTheDocument();
      const login = screen.getByText(
        'userDetail.adminLastLogin',
      ).parentElement!;
      expect(login.textContent).not.toBe('userDetail.adminLastLogin');
      if (!enabled) expect(login).toHaveTextContent('—');
      else expect(login).not.toHaveTextContent('—');
    },
  );

  it('hides administrator observations for an ordinary user', () => {
    renderPage();
    expect(
      screen.queryByText('userDetail.adminLastLogin'),
    ).not.toBeInTheDocument();
  });

  it('explains active-session scope and how browsers register push devices', () => {
    renderPage();
    expect(screen.getByText('userDetail.sessionsDesc')).toBeInTheDocument();
    expect(screen.getByText('userDetail.push.desc')).toBeInTheDocument();
    expect(screen.getByText('userDetail.push.emptyHint')).toBeInTheDocument();
  });

  it('does not expose user mutations to a VIEWER', () => {
    renderPage();

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'users.action.ban' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'users.action.forceLogout' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'users.action.issueLoginCode' }),
    ).not.toBeInTheDocument();
  });

  it('lets ADMIN+ disable and force-logout the routed user', async () => {
    state.canManage = true;
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'users.action.ban' }));
    await waitFor(() => expect(disable.mutateAsync).toHaveBeenCalledWith(42));
    expect(toast.success).toHaveBeenCalledWith('users.toast.banned');

    fireEvent.click(
      screen.getByRole('button', { name: 'users.action.forceLogout' }),
    );
    await waitFor(() =>
      expect(forceLogout.mutateAsync).toHaveBeenCalledWith(42),
    );
    expect(toast.success).toHaveBeenCalledWith('users.toast.forceLoggedOut');
  });

  it('does not offer login-code issuance for a disabled user', () => {
    state.canManage = true;
    state.isDeleted = true;
    renderPage();

    expect(
      screen.queryByRole('button', { name: 'users.action.issueLoginCode' }),
    ).not.toBeInTheDocument();
  });
});
