import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NativeImageDownloadAdapter } from './image-download.adapter';

describe('NativeImageDownloadAdapter', () => {
  type NativeWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: {
      core: { invoke: jasmine.Spy };
      event: { listen: jasmine.Spy };
    };
  };

  let invoke: jasmine.Spy;
  let eventHandler: ((event: { payload: unknown }) => void) | undefined;
  let unlisten: jasmine.Spy;
  let adapter: NativeImageDownloadAdapter;

  beforeEach(() => {
    invoke = jasmine.createSpy('invoke');
    unlisten = jasmine.createSpy('unlisten');
    eventHandler = undefined;
    const nativeWindow = window as unknown as NativeWindow;
    nativeWindow.__TAURI_INTERNALS__ = {};
    nativeWindow.__TAURI__ = {
      core: { invoke },
      event: {
        listen: jasmine
          .createSpy('listen')
          .and.callFake(
            async (
              _event: string,
              handler: (event: { payload: unknown }) => void,
            ) => {
              eventHandler = handler;
              return unlisten;
            },
          ),
      },
    };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    adapter = TestBed.inject(NativeImageDownloadAdapter);
  });

  afterEach(() => {
    const nativeWindow = window as unknown as NativeWindow;
    delete nativeWindow.__TAURI_INTERNALS__;
    delete nativeWindow.__TAURI__;
  });

  it('maps native progress and returns the media:// display URL', async () => {
    let resolveDownload: ((value: unknown) => void) | undefined;
    invoke
      .withArgs('download_media', {
        path: '/uploads/photo.jpg',
        taskId: jasmine.any(String),
      })
      .and.returnValue(
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
      );
    const events: unknown[] = [];
    adapter.download('/uploads/photo.jpg').subscribe((event) => events.push(event));
    await tick();
    const downloadCall = invoke.calls
      .all()
      .find((call) => call.args[0] === 'download_media');
    const taskId = downloadCall?.args[1].taskId as string;
    eventHandler?.({
      payload: { taskId, loaded: 1024, total: 2048 },
    });
    resolveDownload?.({
      path: '/private/cache/media.bin',
      contentType: 'image/jpeg',
      size: 2048,
    });
    await tick();

    expect(events).toContain(
      jasmine.objectContaining({
        type: 'progress',
        loaded: 1024,
        total: 2048,
      }),
    );
    expect(events).toContain(
      jasmine.objectContaining({
        type: 'completed',
        artifact: jasmine.objectContaining({
          displayUrl: 'media://localhost/uploads/photo.jpg',
          savePath: '/uploads/photo.jpg',
          size: 2048,
        }),
      }),
    );
  });

  it('cancels the Rust task when the observable is unsubscribed', async () => {
    let resolveDownload: ((value: unknown) => void) | undefined;
    invoke
      .withArgs('download_media', jasmine.any(Object))
      .and.returnValue(
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
      );
    invoke
      .withArgs('cancel_media_download', jasmine.any(Object))
      .and.resolveTo(true);

    const subscription = adapter.download('/uploads/photo.jpg').subscribe();
    await tick();
    const taskId = invoke.calls
      .all()
      .find((call) => call.args[0] === 'download_media')?.args[1].taskId as string;
    subscription.unsubscribe();
    await tick();

    expect(invoke).toHaveBeenCalledWith('cancel_media_download', { taskId });
    expect(unlisten).toHaveBeenCalled();
    resolveDownload?.({
      path: '/private/cache/media.bin',
      size: 2048,
    });
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
