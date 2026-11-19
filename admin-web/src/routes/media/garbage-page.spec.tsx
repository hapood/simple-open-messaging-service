import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GarbagePage } from './garbage-page';
import { toast } from 'sonner';
import { NAV_GROUPS } from '@/components/layout/nav-config';

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  clean: vi.fn(),
  superAdmin: true,
}));
vi.mock('@/api/garbage', () => ({
  scanGarbage: mocks.scan,
  cleanGarbage: mocks.clean,
}));
vi.mock('@/hooks/use-me', () => ({ useIsSuperAdmin: () => mocks.superAdmin }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.superAdmin = true;
  mocks.scan.mockResolvedValue({
    total: 1,
    limit: 20,
    list: [
      {
        token: 'ticket',
        root: 'resumable',
        kind: 'directory',
        name: 'unexpected',
        files: ['unexpected'],
        bytes: null,
        modifiedAt: '2026-01-01',
        tasks: [],
        canDelete: true,
        blockedReason: null,
      },
    ],
  });
  mocks.clean.mockResolvedValue({ cleaned: true });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
describe('Garbage file cleanup', () => {
  it('has dedicated navigation and never scans on mount or after deletion', async () => {
    expect(
      NAV_GROUPS.flatMap((group) => group.items).find(
        (item) => item.to === '/garbage',
      )?.key,
    ).toBe('garbage');
    render(<GarbagePage />);
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(screen.getByText('garbage.notScanned')).toBeTruthy();
    fireEvent.click(screen.getByText('garbage.scan'));
    await waitFor(() => expect(screen.getByText('common.delete')).toBeTruthy());
    fireEvent.click(screen.getByText('common.delete'));
    await waitFor(() =>
      expect(mocks.clean).toHaveBeenCalledWith('ticket', true),
    );
    expect(window.confirm).toHaveBeenCalledWith('garbage.directoryConfirm');
    expect(mocks.scan).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('common.next')).toBeNull();
  });
  it('does not delete without explicit confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<GarbagePage />);
    fireEvent.click(screen.getByText('garbage.scan'));
    await waitFor(() => expect(screen.getByText('common.delete')).toBeTruthy());
    fireEvent.click(screen.getByText('common.delete'));
    expect(mocks.clean).not.toHaveBeenCalled();
  });
  it('reports cleanup failure, keeps the candidate, and retries only on an explicit click', async () => {
    mocks.clean.mockRejectedValueOnce(new Error('unlink failed'));
    render(<GarbagePage />);
    fireEvent.click(screen.getByText('garbage.scan'));
    await screen.findByText('common.delete');
    fireEvent.click(screen.getByText('common.delete'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(screen.getByText('common.delete')).toBeEnabled();
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(mocks.clean).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('common.delete'));
    await waitFor(() => expect(screen.queryByText('common.delete')).toBeNull());
    expect(mocks.clean).toHaveBeenCalledTimes(2);
    expect(mocks.scan).toHaveBeenCalledOnce();
  });

  it('does not expose cleanup to non-super administrators', () => {
    mocks.superAdmin = false;
    render(<GarbagePage />);
    expect(screen.queryByText('garbage.scan')).toBeNull();
    expect(mocks.scan).not.toHaveBeenCalled();
  });
});
