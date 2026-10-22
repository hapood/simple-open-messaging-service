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

  it('uses the shared Rust cache and Android MediaStore bridge', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 14)',
      configurable: true,
    });
    const save = vi.fn().mockName('save').mockReturnValue('content://saved/1');
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    windowMock.SomsMedia = { save };
    invoke.mockResolvedValue({ path: '/private/cache/media/hash.bin' });

    await service.save({
      path: '/uploads/photo.jpg',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
    });

    expect(save).toHaveBeenCalledWith(
      expect.any(String),
      '/private/cache/media/hash.bin',
      'photo.jpg',
      'image/jpeg',
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
    });
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

  it('reports closing the legacy Android document picker as cancellation', async () => {
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
