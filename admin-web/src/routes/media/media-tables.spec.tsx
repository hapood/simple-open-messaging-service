import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MediaDownloadsPanel,
  MediaFilesPanel,
  MediaUploadsPanel,
} from './media-tables';
import en from '@/locales/en/translation.json';
import zh from '@/locales/zh-CN/translation.json';
import { formatMediaBytes } from './media-format';

const mocks = vi.hoisted(() => ({
  files: vi.fn(),
  uploads: vi.fn(),
  downloads: vi.fn(),
  busy: false,
  mutate: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-media', () => ({
  useMediaFiles: mocks.files,
  useMediaUploads: mocks.uploads,
  useMediaDownloads: mocks.downloads,
  useMediaCommand: () => ({ isPending: mocks.busy, mutateAsync: mocks.mutate }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.busy = false;
  mocks.downloads.mockReturnValue({
    data: {
      total: 100,
      list: [
        {
          batchId: 'batch-id',
          status: 'pending',
          users: [],
          totalFiles: 1,
          completedFiles: 0,
          bytesTotal: '32',
          bytesReceived: '8',
          files: [],
        },
      ],
    },
    isLoading: false,
    isFetching: false,
  });
  mocks.files.mockReturnValue({
    data: {
      total: 100,
      bytes: '32',
      list: [
        {
          digest: 'a'.repeat(64),
          bytes: '32',
          status: 'available',
          users: [{ account: 'alice', namespaceId: 0 }],
          userCount: 1,
          originalName: 'private-contract.pdf',
        },
      ],
    },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  });
  mocks.uploads.mockReturnValue({
    data: {
      total: 1,
      bytes: '32',
      list: [
        {
          id: 'upload-id',
          userId: 7,
          digest: null,
          bytes: '32',
          bytesReceived: '8',
          status: 'UPLOADING',
          originalName: 'private-upload.txt',
        },
      ],
    },
    isLoading: false,
    isFetching: false,
  });
  mocks.mutate.mockResolvedValue({});
});

afterEach(() => vi.restoreAllMocks());

describe('reusable privacy-safe media panels', () => {
  it('uses the same user-filtered paginated inventory without rendering file names', () => {
    render(
      <MemoryRouter>
        <MediaFilesPanel userId={7} />
      </MemoryRouter>,
    );
    expect(mocks.files).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 7, skip: 0, take: 25 }),
      false,
    );
    expect(screen.queryByText('private-contract.pdf')).toBeNull();
    expect(screen.getByText(/alice/)).toBeTruthy();
    fireEvent.click(screen.getByText('common.next'));
    expect(mocks.files).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 7, skip: 25 }),
      false,
    );
    fireEvent.change(screen.getByLabelText('media.digestSearch'), {
      target: { value: 'ABCxyz' },
    });
    expect(mocks.files).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 7, skip: 0, digest: 'abc' }),
      false,
    );
  });

  it('stops uploads using only the session identifier after explicit confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <MemoryRouter>
        <MediaUploadsPanel userId={7} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('private-upload.txt')).toBeNull();
    expect(screen.getByText('media.pendingDigest')).toBeTruthy();
    fireEvent.click(screen.getByText('media.stop'));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        kind: 'upload-stop',
        id: 'upload-id',
      }),
    );
    expect(window.confirm).toHaveBeenCalledWith('media.uploadStopConfirm');
    vi.restoreAllMocks();
  });

  it.each(['UPLOADING', 'COMPLETING', 'FAILED', 'STOPPED'])(
    'offers only the appropriate action for upload status %s',
    async (status) => {
      const result = mocks.uploads();
      result.data.list[0].status = status;
      render(
        <MemoryRouter>
          <MediaUploadsPanel />
        </MemoryRouter>,
      );
      const retryable = ['FAILED', 'STOPPED'].includes(status);
      expect(
        screen.queryByRole('button', { name: 'media.stop' }) !== null,
      ).toBe(!retryable);
      expect(
        screen.queryByRole('button', { name: 'media.retry' }) !== null,
      ).toBe(retryable);
      expect(screen.queryByText('media.clean')).toBeNull();
      if (retryable) {
        fireEvent.click(screen.getByRole('button', { name: 'media.retry' }));
        await waitFor(() =>
          expect(mocks.mutate).toHaveBeenCalledWith({
            kind: 'upload-retry',
            id: 'upload-id',
          }),
        );
      }
    },
  );

  it.each(['pending', 'downloading', 'failed', 'stopped', 'ready'])(
    'offers stop or retry without task deletion for download status %s',
    async (status) => {
      const result = mocks.downloads();
      result.data.list[0].status = status;
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<MediaDownloadsPanel userId={7} />);
      const active = ['pending', 'downloading'].includes(status);
      const retryable = ['failed', 'stopped'].includes(status);
      expect(
        screen.queryByRole('button', { name: 'media.stop' }) !== null,
      ).toBe(active);
      expect(
        screen.queryByRole('button', { name: 'media.retry' }) !== null,
      ).toBe(retryable);
      expect(screen.queryByRole('button', { name: 'media.clean' })).toBeNull();
      if (active || retryable) {
        fireEvent.click(
          screen.getByRole('button', {
            name: active ? 'media.stop' : 'media.retry',
          }),
        );
        await waitFor(() =>
          expect(mocks.mutate).toHaveBeenCalledWith({
            kind: active ? 'download-stop' : 'download-retry',
            id: 'batch-id',
          }),
        );
        if (active)
          expect(window.confirm).toHaveBeenCalledWith(
            'media.downloadStopConfirm',
          );
        else expect(window.confirm).not.toHaveBeenCalled();
      }
    },
  );

  it('filters stopped downloads and resets pagination', () => {
    render(<MediaDownloadsPanel userId={7} />);
    fireEvent.click(screen.getByText('common.next'));
    expect(mocks.downloads).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 25 }),
    );
    fireEvent.change(screen.getByLabelText('media.status'), {
      target: { value: 'stopped' },
    });
    expect(mocks.downloads).toHaveBeenLastCalledWith({
      userId: 7,
      skip: 0,
      take: 25,
      status: 'stopped',
    });
  });

  it('does not stop an upload when confirmation is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <MemoryRouter>
        <MediaUploadsPanel />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'media.stop' }));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('disables retry while a command is pending', () => {
    mocks.busy = true;
    mocks.uploads().data.list[0].status = 'STOPPED';
    render(
      <MemoryRouter>
        <MediaUploadsPanel />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'media.retry' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'media.retry' }));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('explicitly explains non-destructive stopping in both locales', () => {
    expect(en.media.stop).toBe('Stop');
    expect(zh.media.stop).toBe('停止');
    for (const key of ['uploadStopConfirm', 'downloadStopConfirm'] as const) {
      expect(en.media[key]).toContain('task and temporary files are preserved');
      expect(zh.media[key]).toContain('任务和临时文件均会保留');
    }
  });

  it.each([
    [null, 'media.unknownBytes / 32 B'],
    ['0', '0 B / 32 B'],
    ['8', '8 B / 32 B'],
  ])(
    'renders upload checkpoint %s without inventing progress',
    (bytesReceived, progress) => {
      mocks.uploads().data.list[0].bytesReceived = bytesReceived;
      render(
        <MemoryRouter>
          <MediaUploadsPanel />
        </MemoryRouter>,
      );
      expect(screen.getByRole('cell', { name: progress })).toBeTruthy();
      if (bytesReceived === null) {
        expect(screen.queryByText('0 B / 32 B')).toBeNull();
      } else {
        expect(screen.queryByText(/media.unknownBytes/)).toBeNull();
      }
    },
  );

  it('distinguishes unknown byte totals from an actual empty file', () => {
    expect(formatMediaBytes(null)).toBe('—');
    expect(formatMediaBytes('0')).toBe('0 B');
    expect(formatMediaBytes('1024')).toBe('1.0 KiB');
  });
});
