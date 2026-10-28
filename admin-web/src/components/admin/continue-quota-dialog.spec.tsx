import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContinueQuotaDialog } from './continue-quota-dialog';
import type { BreakerStatus } from '@/types/api';

const peer = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const user = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-quota', () => ({
  useContinuePeer: () => peer,
  useContinueUser: () => user,
}));

const breaker = (scope: 'peer' | 'user'): BreakerStatus => ({
  maxFileBytes: 1024 ** 3,
  entity: scope === 'peer' ? 'peer.test' : '42',
  userId: scope === 'user' ? 42 : undefined,
  scope,
  requests: { count: 0, limit: 50 },
  signals: { count: 0, limit: 10000 },
  tripped: true,
  trippedDims: ['messages', 'fileBytes'],
  retryAfter: Date.now() + 60_000,
  msg: { count: 11, limit: 10 },
  file: { count: 2, limit: 10 },
  fileBytes: { bytes: String(3 * 1024 * 1024), limit: 2 * 1024 * 1024 },
});

describe('ContinueQuotaDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    peer.mutateAsync.mockResolvedValue({ ...breaker('peer'), tripped: false });
    user.mutateAsync.mockResolvedValue({ ...breaker('user'), tripped: false });
  });

  it('converts the peer byte allowance from MB and resumes its breaker', async () => {
    const onClose = vi.fn();
    render(<ContinueQuotaDialog breaker={breaker('peer')} onClose={onClose} />);
    const [, , messages, files, megabytes] = screen.getAllByRole('spinbutton');

    fireEvent.change(messages, { target: { value: '2' } });
    fireEvent.change(files, { target: { value: '1' } });
    fireEvent.change(megabytes, { target: { value: '1.5' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'quota.breaker.apply' }),
    );

    await waitFor(() =>
      expect(peer.mutateAsync).toHaveBeenCalledWith({
        domain: 'peer.test',
        input: {
          addMsg: 2,
          addFile: 1,
          addFileBytes: 1.5 * 1024 * 1024,
        },
      }),
    );
    expect(user.mutateAsync).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('quota.breaker.toastResumed');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('targets a local user and keeps the dialog open for invalid input', async () => {
    const onClose = vi.fn();
    render(<ContinueQuotaDialog breaker={breaker('user')} onClose={onClose} />);
    const [, , messages] = screen.getAllByRole('spinbutton');

    fireEvent.change(messages, { target: { value: '-1' } });
    expect(
      screen.getByRole('button', { name: 'quota.breaker.apply' }),
    ).toBeDisabled();

    fireEvent.change(messages, { target: { value: '3' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'quota.breaker.apply' }),
    );

    await waitFor(() =>
      expect(user.mutateAsync).toHaveBeenCalledWith({
        userId: 42,
        input: { addMsg: 3, addFile: undefined, addFileBytes: undefined },
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});
