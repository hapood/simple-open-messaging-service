import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAccessDialog } from './admin-access-dialog';
import type { User } from '@/types/api';
const state = vi.hoisted(() => ({
  role: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-admins', () => ({
  useSetAdminRole: () => ({ mutateAsync: state.role }),
  useDisableAdmin: () => ({ mutateAsync: state.disable }),
  useEnableAdmin: () => ({ mutateAsync: state.enable }),
  useResetAdminTwoFactor: () => ({ mutateAsync: state.reset }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const user = {
  id: 42,
  adminId: 8,
  account: 'alice',
  adminRole: 'VIEWER',
  adminEnabled: true,
} as User;
describe('AdminAccessDialog', () => {
  beforeEach(() => {
    for (const mock of Object.values(state))
      mock.mockReset().mockResolvedValue(undefined);
  });
  it('changes roles only after confirmation and uses the admin ID, not user ID', async () => {
    render(
      <AdminAccessDialog target={{ user, action: 'role' }} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'ADMIN' },
    });
    expect(state.role).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await waitFor(() =>
      expect(state.role).toHaveBeenCalledWith({ id: 8, role: 'ADMIN' }),
    );
  });
  it.each(['toggle', 'reset'] as const)(
    'confirms %s operations',
    async (action) => {
      render(<AdminAccessDialog target={{ user, action }} onClose={vi.fn()} />);
      expect(state.disable).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
      await waitFor(() =>
        expect(
          action === 'toggle' ? state.disable : state.reset,
        ).toHaveBeenCalledWith(8),
      );
    },
  );
  it('restores access without conflating account enablement', async () => {
    render(
      <AdminAccessDialog
        target={{ user: { ...user, adminEnabled: false }, action: 'toggle' }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await waitFor(() => expect(state.enable).toHaveBeenCalledWith(8));
  });
});
