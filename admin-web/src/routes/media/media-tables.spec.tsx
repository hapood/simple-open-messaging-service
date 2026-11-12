import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaFilesPanel, MediaUploadsPanel } from './media-tables';
import { formatMediaBytes } from './media-format';

const mocks = vi.hoisted(() => ({
  files: vi.fn(),
  uploads: vi.fn(),
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
  useMediaDownloads: vi.fn(),
  useMediaCommand: () => ({ isPending: false, mutateAsync: mocks.mutate }),
}));
beforeEach(() => {
  vi.clearAllMocks();
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
          uploadId: 'upload-id',
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

  it('cleans uploads using only the session identifier after explicit confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <MemoryRouter>
        <MediaUploadsPanel userId={7} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('private-upload.txt')).toBeNull();
    expect(screen.getByText('media.pendingDigest')).toBeTruthy();
    fireEvent.click(screen.getByText('media.stopAndClean'));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        kind: 'upload-stop',
        id: 'upload-id',
      }),
    );
    expect(window.confirm).toHaveBeenCalledWith('media.uploadStopConfirm');
    vi.restoreAllMocks();
  });

  it('distinguishes unknown byte totals from an actual empty file', () => {
    expect(formatMediaBytes(null)).toBe('—');
    expect(formatMediaBytes('0')).toBe('0 B');
    expect(formatMediaBytes('1024')).toBe('1.0 KiB');
  });
});
