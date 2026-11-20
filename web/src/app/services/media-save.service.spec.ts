import type { Mock } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  MediaSaveCancelledError,
  MediaSaveService,
} from './media-save.service';

describe('MediaSaveService', () => {
  type MockWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: {
      core: {
        invoke: Mock;
      };
    };
    SomsMedia?: {
      save: Mock;
    };
  };

  const originalUserAgent = navigator.userAgent;
  let service: MediaSaveService;
  let invoke: Mock;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    service = TestBed.inject(MediaSaveService);
    invoke = vi.fn().mockName('invoke');
  });

  afterEach(() => {
    const windowMock = window as unknown as MockWindow;
    delete windowMock.__TAURI_INTERNALS__;
    delete windowMock.__TAURI__;
    delete windowMock.SomsMedia;
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    });
  });

  it('keeps browser saves on the standard HTTP download path', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockReturnValue(undefined);

    await service.save({
      path: '/uploads/photo.jpg',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
    });

    expect(click).toHaveBeenCalled();
    expect(document.querySelector('a[download="photo.jpg"]')).toBeNull();
  });

  it('asks Android to stream the remote media into the platform destination', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 14)',
      configurable: true,
    });
    const save = vi.fn().mockName('save').mockImplementation((requestId: string) => {
      queueMicrotask(() => window.__SOMS_MEDIA_SAVE_RESULT__?.({
        requestId, success: true, cancelled: false,
      }));
      return 'pending';
    });
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    windowMock.SomsMedia = { save };

    await service.save({
      path: '/uploads/photo.jpg',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
    }, 'task');

    expect(invoke).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(
      expect.any(String),
      '/uploads/photo.jpg',
      'photo.jpg',
      'image/jpeg',
      'task',
    );
  });

  it('uses the native desktop save command without a JS blob download', async () => {
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    invoke.mockResolvedValue('/Downloads/photo.jpg');

    await service.save({
      path: '/uploads/photo.jpg',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
    });

    expect(invoke).toHaveBeenCalledWith('save_media_desktop', {
      path: '/uploads/photo.jpg',
      filename: 'photo.jpg',
      taskId: null,
    });
  });

  it('treats a closed desktop Save As dialog as cancellation', async () => {
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    invoke.mockRejectedValue('media save cancelled');

    await expect(service.save({
      path: '/uploads/photo.jpg',
      filename: 'photo.jpg',
    })).rejects.toBeInstanceOf(MediaSaveCancelledError);
  });

  it('waits for the Android system document picker on legacy Android', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 9)',
      configurable: true,
    });
    const save = vi.fn().mockName('save').mockReturnValue('pending');
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    windowMock.SomsMedia = { save };
    invoke.mockResolvedValue({ path: '/private/cache/media/hash.bin' });

    let completed = false;
    const saving = service
      .save({
        path: '/uploads/photo.jpg',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
      })
      .then(() => (completed = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    const requestId = vi.mocked(save).mock.lastCall![0] as string;
    window.__SOMS_MEDIA_SAVE_RESULT__?.({ requestId, success: true });
    await saving;
    expect(completed).toBe(true);
  });

  it('propagates Android bridge failure rather than claiming the file was saved', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14)', configurable: true });
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    const save = vi.fn().mockImplementation(() => { throw new Error('bridge unavailable'); });
    windowMock.SomsMedia = { save };
    invoke.mockResolvedValue({ path: '/private/cache/media/hash.bin' });
    await expect(service.save({ path: '/uploads/file.bin', filename: 'file.bin' })).rejects.toThrow('bridge unavailable');
    const requestId = save.mock.calls[0][0] as string;
    expect(() => window.__SOMS_MEDIA_SAVE_RESULT__?.({ requestId, success: true })).not.toThrow();
  });

  it('reports closing the Android document picker as cancellation', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 9)',
      configurable: true,
    });
    const save = vi.fn().mockName('save').mockReturnValue('pending');
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    windowMock.SomsMedia = { save };
    invoke.mockResolvedValue({ path: '/private/cache/media/hash.bin' });

    const saving = service.save({
      path: '/uploads/photo.jpg',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
    await Promise.resolve();
    await Promise.resolve();

    const requestId = vi.mocked(save).mock.lastCall![0] as string;
    window.__SOMS_MEDIA_SAVE_RESULT__?.({
      requestId,
      success: false,
      cancelled: true,
    });

    await expect(saving).rejects.toThrowError(MediaSaveCancelledError);
  });
});
