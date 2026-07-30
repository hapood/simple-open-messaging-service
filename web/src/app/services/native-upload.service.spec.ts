import {
  NativeUploadError,
  NativeUploadSelection,
  NativeUploadService,
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
      pickPhotos: jasmine.createSpy('pickPhotos'),
      pickFile: jasmine.createSpy('pickFile'),
      upload: jasmine.createSpy('upload'),
      cancel: jasmine.createSpy('cancel'),
      release: jasmine.createSpy('release'),
      discard: jasmine.createSpy('discard'),
      getState: jasmine.createSpy('getState').and.returnValue('selected'),
      finish: jasmine.createSpy('finish'),
    };
    window.SomsUpload = bridge;
    service = new NativeUploadService();
  });

  afterEach(() => {
    delete window.SomsUpload;
    delete window.__SOMS_UPLOAD_PICKED__;
    delete window.__SOMS_UPLOAD_PROGRESS__;
    delete window.__SOMS_UPLOAD_COMPLETED__;
    delete window.__SOMS_UPLOAD_FAILED__;
  });

  it('ignores a stale completion and resolves only the matching attempt', async () => {
    let resolved = false;
    const result = service
      .upload<{ code: number }>(selection, 'cid-1', {})
      .then((value) => {
        resolved = true;
        return value;
      });
    const args = (bridge.upload as jasmine.Spy).calls.mostRecent().args;
    const attemptId = args[1] as string;

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
    await expectAsync(result).toBeResolvedTo({ code: 0 });
  });

  it('cancel rejects the active attempt and passes its id to native', async () => {
    const result = service.upload(selection, 'cid-1', {});
    const attemptId = (bridge.upload as jasmine.Spy).calls.mostRecent()
      .args[1] as string;

    service.cancel(selection.uploadId);

    await expectAsync(result).toBeRejectedWithError('upload cancelled');
    expect(bridge.cancel).toHaveBeenCalledOnceWith(
      selection.uploadId,
      attemptId,
    );
  });

  it('release does not cancel or detach an active completion', async () => {
    const result = service.upload<{ code: number }>(selection, 'cid-1', {});
    const attemptId = (bridge.upload as jasmine.Spy).calls.mostRecent()
      .args[1] as string;

    service.release(selection.uploadId);
    expect(bridge.release).toHaveBeenCalledOnceWith(selection.uploadId);
    expect(bridge.cancel).not.toHaveBeenCalled();

    window.__SOMS_UPLOAD_COMPLETED__?.({
      uploadId: selection.uploadId,
      attemptId,
      response: { code: 0 },
    });
    await expectAsync(result).toBeResolvedTo({ code: 0 });
  });

  it('preserves structured server quota metadata without disabling retry', async () => {
    const result = service.upload(selection, 'cid-1', {});
    const attemptId = (bridge.upload as jasmine.Spy).calls.mostRecent()
      .args[1] as string;

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
      fail('expected quota rejection');
    } catch (error) {
      expect(error).toEqual(jasmine.any(NativeUploadError));
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
