import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BansPage } from './bans-page';
import { MemoryRouter } from 'react-router-dom';
vi.mock('@/hooks/use-me', () => ({ useIsAdminPlus: () => true }));
const state = vi.hoisted(() => ({
  type: 'otp',
  userId: null as number | null,
  mutateAsync: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-bans', () => ({
  useBans: () => ({
    data: [
      {
        userId: state.userId,
        key: 'ban',
        type: state.type,
        value: 'alice',
        until: Date.now() + 60000,
        remainingMs: 500,
      },
    ],
    isLoading: false,
  }),
  useUnban: () => ({ mutateAsync: state.mutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
describe('Login protection release', () => {
  beforeEach(() => {
    state.type = 'otp';
    state.userId = null;
    state.mutateAsync.mockReset().mockResolvedValue(undefined);
  });
  it.each([42, null])('links only a resolved local account (%s)', (userId) => {
    state.userId = userId;
    render(
      <MemoryRouter>
        <BansPage />
      </MemoryRouter>,
    );
    if (userId !== null) {
      expect(screen.getByRole('link', { name: 'alice' })).toHaveAttribute(
        'href',
        '/users/42',
      );
    } else {
      expect(
        screen.queryByRole('link', { name: 'alice' }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('alice')).toBeInTheDocument();
    }
  });
  it('explains all account dimensions before releasing an OTP restriction', async () => {
    render(
      <MemoryRouter>
        <BansPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'bans.unban' }));
    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText('bans.confirmAccount')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'bans.release' }));
    await waitFor(() =>
      expect(state.mutateAsync).toHaveBeenCalledWith({ account: 'alice' }),
    );
  });
  it('uses the IP scope and lets an operator cancel', () => {
    state.type = 'ip';
    render(
      <MemoryRouter>
        <BansPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'bans.unban' }));
    expect(screen.getByText('bans.confirmIp')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });
});
