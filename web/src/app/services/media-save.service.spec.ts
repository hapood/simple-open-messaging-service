import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaSaveService } from './media-save.service';

describe('MediaSaveService', () => {
  type MockWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: { core: { invoke: jasmine.Spy } };
    SomsMedia?: { save: jasmine.Spy };
  };

  const originalUserAgent = navigator.userAgent;
  let service: MediaSaveService;
  let invoke: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    service = TestBed.inject(MediaSaveService);
    invoke = jasmine.createSpy('invoke');
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
    const click = spyOn(HTMLAnchorElement.prototype, 'click');

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
    const save = jasmine.createSpy('save').and.returnValue('content://saved/1');
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    windowMock.SomsMedia = { save };
    invoke
      .withArgs('cache_media', { path: '/uploads/photo.jpg' })
      .and.resolveTo({ path: '/private/cache/media/hash.bin' });

    await service.save({
      path: '/uploads/photo.jpg',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
    });

    expect(save).toHaveBeenCalledWith(
      jasmine.any(String),
      '/private/cache/media/hash.bin',
      'photo.jpg',
      'image/jpeg',
    );
  });

  it('uses the native desktop save command without a JS blob download', async () => {
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    invoke.and.resolveTo('/Downloads/photo.jpg');

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
    const save = jasmine.createSpy('save').and.returnValue('pending');
    const windowMock = window as unknown as MockWindow;
    windowMock.__TAURI_INTERNALS__ = {};
    windowMock.__TAURI__ = { core: { invoke } };
    windowMock.SomsMedia = { save };
    invoke.and.resolveTo({ path: '/private/cache/media/hash.bin' });

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
    expect(completed).toBeFalse();

    const requestId = save.calls.mostRecent().args[0] as string;
    window.__SOMS_MEDIA_SAVE_RESULT__?.({ requestId, success: true });
    await saving;
    expect(completed).toBeTrue();
  });
});
