import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginCodeView } from '@/types/api';
import { LoginCodesSection } from './login-codes-section';

const state = vi.hoisted(() => ({
  data: [] as LoginCodeView[] | undefined,
  isLoading: false,
  error: null as Error | null,
  canManage: false,
}));
const revoke = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
vi.mock('@/hooks/use-me', () => ({
  useIsAdminPlus: () => state.canManage,
}));
vi.mock('@/hooks/use-user-mutations', () => ({
  useUserLoginCodes: () => state,
  useRevokeLoginCode: () => revoke,
}));
vi.mock('@/components/common/timestamp', () => ({
  Timestamp: ({ value }: { value: number }) => <span>{value}</span>,
}));

function code(
  id: number,
  overrides: Partial<LoginCodeView> = {},
): LoginCodeView {
  return {
    id,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    consumedAt: null,
    consumedIp: null,
    consumedDevice: null,
    producedSessionId: null,
    revokedAt: null,
    issuedBy: 1,
    ...overrides,
  };
}

beforeEach(() => {
  state.data = [];
  state.isLoading = false;
  state.error = null;
  state.canManage = false;
  revoke.mutateAsync.mockReset().mockResolvedValue(undefined);
});

describe('LoginCodesSection', () => {
  it('shows every code with its usage details and counts consumption, not sessions', () => {
    state.data = [
      code(4),
      code(3, {
        consumedAt: 1234,
        consumedIp: '192.0.2.1',
        consumedDevice: 'Browser A',
        producedSessionId: 42,
      }),
      code(2, { expiresAt: 2 }),
      code(1, { revokedAt: 3 }),
    ];
    render(<LoginCodesSection userId={7} />);
    expect(screen.getByText('loginCodes.desc')).toBeInTheDocument();
    expect(
      screen.getByText('loginCodes.summary {"issued":4,"consumed":1}'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(5);
    for (const status of ['pending', 'consumed', 'expired', 'revoked']) {
      expect(
        screen.getByText(`loginCodes.status.${status}`),
      ).toBeInTheDocument();
    }
    for (const value of ['1234', '192.0.2.1', 'Browser A', '#42']) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(
      screen.queryByRole('button', { name: 'loginCodes.revoke' }),
    ).not.toBeInTheDocument();
  });

  it('only lets managers revoke pending codes', async () => {
    state.canManage = true;
    state.data = [
      code(4),
      code(3, { consumedAt: 1234 }),
      code(2, { expiresAt: 2 }),
      code(1, { revokedAt: 3 }),
    ];
    render(<LoginCodesSection userId={7} />);
    const buttons = screen.getAllByRole('button', {
      name: 'loginCodes.revoke',
    });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(revoke.mutateAsync).toHaveBeenCalledWith(4));
  });

  it('does not disguise a failed request as an empty list or show stale totals', () => {
    state.data = [code(1)];
    state.error = new Error('Network unavailable');
    render(<LoginCodesSection userId={7} />);
    expect(screen.getByRole('alert')).toHaveTextContent('common.loadFailed');
    expect(screen.queryByText('loginCodes.empty')).not.toBeInTheDocument();
    expect(screen.queryByText(/loginCodes.summary/)).not.toBeInTheDocument();
  });

  it('shows an empty result with zero counts', () => {
    render(<LoginCodesSection userId={7} />);
    expect(screen.getByText('loginCodes.empty')).toBeInTheDocument();
    expect(
      screen.getByText('loginCodes.summary {"issued":0,"consumed":0}'),
    ).toBeInTheDocument();
  });
});
