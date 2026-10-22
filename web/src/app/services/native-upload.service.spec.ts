// @vitest-environment jsdom
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  NativeUploadError,
  NativeUploadSelection,
  NativeUploadService,
  NATIVE_UPLOAD_IDLE_TIMEOUT_MS,
  NATIVE_PICK_INSPECTION_TIMEOUT_MS,
  isSuccessfulUploadResponse,
} from './native-upload.service';

describe('NativeUploadService attempt routing', () => {
  let service: NativeUploadService;
  let bridge: NonNullable<Window['SomsUpload']>;

  const selection: NativeUploadSelection = {
    uploadId: 'upload-1',
    kind: 'image',
    name: 'one.jpg',
    mimeType: 'image/jpeg',
    size: 10,
    w: 1,
    h: 1,
    duration: 0,
    preview: null,
  };

  beforeEach(() => {
    bridge = {
      pickPhotos: vi.fn().mockName('pickPhotos'),
      pickFile: vi.fn().mockName('pickFile'),
      upload: vi.fn().mockName('upload'),
      cancel: vi.fn().mockName('cancel'),
      release: vi.fn().mockName('release'),
      discard: vi.fn().mockName('discard'),
      getState: vi.fn().mockName('getState').mockReturnValue('selected'),
      finish: vi.fn().mockName('finish'),
    };
    window.SomsUpload = bridge;
    service = new NativeUploadService();
  });

  afterEach(() => {
    delete window.SomsUpload;
    delete window.__SOMS_UPLOAD_PICKED__;
    delete window.__SOMS_UPLOAD_INSPECTING__;
    delete window.__SOMS_UPLOAD_PROGRESS__;
    delete window.__SOMS_UPLOAD_COMPLETED__;
    delete window.__SOMS_UPLOAD_FAILED__;
  });

  it('times out file inspection only after the system picker returns', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(service, 'supported').mockReturnValue(true);
      const pending = service.pick('image');
      const failure = expect(pending).rejects.toThrow(
        'File inspection timed out',
      );
      const requestId = vi.mocked(bridge.pickPhotos as Mock).mock
        .lastCall![0] as string;
      await vi.advanceTimersByTimeAsync(NATIVE_PICK_INSPECTION_TIMEOUT_MS * 2);
      window.__SOMS_UPLOAD_INSPECTING__?.({ requestId });
      await vi.advanceTimersByTimeAsync(NATIVE_PICK_INSPECTION_TIMEOUT_MS);
      await failure;
      window.__SOMS_UPLOAD_PICKED__?.({ requestId, items: [selection] });
      expect(bridge.discard).toHaveBeenCalledWith(selection.uploadId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a stale completion and resolves only the matching attempt', async () => {
    let resolved = false;
    const result = service
      .upload<{
        code: number;
      }>(selection, 'cid-1', {})
      .then((value) => {
        resolved = true;
        return value;
      });
    const args = vi.mocked(bridge.upload as Mock).mock.lastCall;
    const attemptId = args![1] as string;

    window.__SOMS_UPLOAD_COMPLETED__?.({
      uploadId: selection.uploadId,
      attemptId: 'stale-attempt',
      response: { code: 99 },
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    window.__SOMS_UPLOAD_COMPLETED__?.({
      uploadId: selection.uploadId,
      attemptId,
      response: { code: 0 },
    });
    await expect(result).resolves.toEqual({ code: 0 });
  });

  it('cancel rejects the active attempt and passes its id to native', async () => {
    const result = service.upload(selection, 'cid-1', {});
    const attemptId = vi.mocked(bridge.upload as Mock).mock
      .lastCall![1] as string;

    service.cancel(selection.uploadId);

    await expect(result).rejects.toThrowError('upload cancelled');
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(bridge.cancel).toHaveBeenCalledWith(selection.uploadId, attemptId);
  });

  it('cancels a stalled native bridge attempt and ignores its late callback', async () => {
    vi.useFakeTimers();
    try {
      const result = expect(
        service.upload(selection, 'cid-1', {}),
      ).rejects.toThrow('Upload stalled');
      const attemptId = vi.mocked(bridge.upload as Mock).mock
        .lastCall![1] as string;
      await vi.advanceTimersByTimeAsync(NATIVE_UPLOAD_IDLE_TIMEOUT_MS - 1);
      window.__SOMS_UPLOAD_PROGRESS__?.({
        uploadId: selection.uploadId,
        attemptId,
        loaded: 1,
        total: 10,
      });
      await vi.advanceTimersByTimeAsync(NATIVE_UPLOAD_IDLE_TIMEOUT_MS);
      await result;
      expect(bridge.cancel).toHaveBeenCalledWith(selection.uploadId, attemptId);
      window.__SOMS_UPLOAD_COMPLETED__?.({
        uploadId: selection.uploadId,
        attemptId,
        response: { code: 0 },
      });
      expect(service.state(selection.uploadId)).toBe('selected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('release does not cancel or detach an active completion', async () => {
    const result = service.upload<{
      code: number;
    }>(selection, 'cid-1', {});
    const attemptId = vi.mocked(bridge.upload as Mock).mock
      .lastCall![1] as string;

    service.release(selection.uploadId);
    expect(bridge.release).toHaveBeenCalledTimes(1);
    expect(bridge.release).toHaveBeenCalledWith(selection.uploadId);
    expect(bridge.cancel).not.toHaveBeenCalled();

    window.__SOMS_UPLOAD_COMPLETED__?.({
      uploadId: selection.uploadId,
      attemptId,
      response: { code: 0 },
    });
    await expect(result).resolves.toEqual({ code: 0 });
  });

  it('preserves structured server quota metadata without disabling retry', async () => {
    const result = service.upload(selection, 'cid-1', {});
    const attemptId = vi.mocked(bridge.upload as Mock).mock
      .lastCall![1] as string;

    window.__SOMS_UPLOAD_FAILED__?.({
      uploadId: selection.uploadId,
      attemptId,
      category: 'api',
      message: 'daily images quota reached',
      retryable: true,
      status: 200,
      code: 10008,
      retryAfter: 3600,
    });

    try {
      await result;
      throw new Error('expected quota rejection');
    } catch (error) {
      expect(error).toEqual(expect.any(NativeUploadError));
      const uploadError = error as NativeUploadError;
      expect(uploadError.code).toBe(10008);
      expect(uploadError.retryAfter).toBe(3600);
      expect(uploadError.retryable).toBe(true);
    }

    // Metadata is advisory: after a terminal failed event, another attempt is still allowed.
    service.upload(selection, 'cid-1', {}).catch(() => undefined);
    expect(bridge.upload).toHaveBeenCalledTimes(2);
  });

  it('keeps the selected file when HTTP succeeds with a failed API envelope', () => {
    expect(isSuccessfulUploadResponse({ code: 10008 })).toBe(false);
    expect(isSuccessfulUploadResponse({ code: 0 })).toBe(true);
    expect(isSuccessfulUploadResponse(undefined)).toBe(false);
  });
});
