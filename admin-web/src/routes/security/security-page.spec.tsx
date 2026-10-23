import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityPage } from './security-page';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  logout: vi.fn(),
  authenticate: vi.fn(),
  totp: false,
  passkey: false,
}));
vi.mock('@/api/client', () => ({ request: mocks.request }));
vi.mock('@/auth/force-logout', () => ({ forceLogout: mocks.logout }));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: mocks.authenticate,
  startRegistration: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      account: 'admin',
      role: 'SUPER_ADMIN',
      currentIp: '203.0.113.9',
      createdAt: 1,
      userAgent: 'test browser',
    },
  }),
}));
vi.mock('@/hooks/use-two-factor', () => ({
  useTwoFactorStatus: () => ({
    data: { enabled: mocks.totp, backupCodesRemaining: 10 },
  }),
}));
vi.mock('@/hooks/use-webauthn', () => ({
  useWebAuthnStatus: () => ({
    data: { enabled: mocks.passkey, available: true },
  }),
  useWebAuthnCredentials: () => ({ data: [] }),
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function openPassword() {
  fireEvent.click(
    screen.getByRole('button', { name: 'security.account.changePassword' }),
  );
  fireEvent.change(screen.getByLabelText('security.account.currentPassword'), {
    target: { value: 'OldPassword123!' },
  });
  fireEvent.change(screen.getByLabelText('security.account.newPassword'), {
    target: { value: 'NewPassword123!' },
  });
  fireEvent.change(screen.getByLabelText('security.account.confirmPassword'), {
    target: { value: 'NewPassword123!' },
  });
}

describe('My Account security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.totp = false;
    mocks.passkey = false;
    mocks.request.mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      configurable: true,
    });
  });
  it('shows the observed request IP and changes a password before signing out', async () => {
    render(<SecurityPage />);
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    openPassword();
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'security.account.changePassword' })
        .at(-1)!,
    );
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('/admin/account/password', {
        password: 'OldPassword123!',
        newPassword: 'NewPassword123!',
      }),
    );
    expect(mocks.logout).toHaveBeenCalledOnce();
  });
  it('requires and submits the enrolled authenticator proof', async () => {
    mocks.totp = true;
    render(<SecurityPage />);
    openPassword();
    const code = screen.getByLabelText('login.code');
    expect(code).toBeRequired();
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'security.account.changePassword' })
        .at(-1)!,
    );
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        '/admin/account/password',
        expect.objectContaining({ code: '123456' }),
      ),
    );
  });
  it('binds the passkey prompt to password change before submitting the assertion', async () => {
    mocks.passkey = true;
    mocks.request
      .mockResolvedValueOnce({
        options: { challenge: 'challenge' },
        pendingToken: 'bound-token',
      })
      .mockResolvedValueOnce({ ok: true });
    mocks.authenticate.mockResolvedValue({ id: 'credential' });
    render(<SecurityPage />);
    openPassword();
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'security.account.changePassword' })
        .at(-1)!,
    );
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        '/admin/account/password',
        expect.objectContaining({
          pendingToken: 'bound-token',
          assertionResponse: { id: 'credential' },
        }),
      ),
    );
    expect(mocks.request.mock.calls[0]).toEqual([
      '/admin/account/assertion',
      { action: 'password', password: 'OldPassword123!', target: undefined },
    ]);
  });
  it('keeps the session on a failed password change', async () => {
    mocks.request.mockRejectedValue(new Error('rejected'));
    render(<SecurityPage />);
    openPassword();
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'security.account.changePassword' })
        .at(-1)!,
    );
    await screen.findByRole('alert');
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});
