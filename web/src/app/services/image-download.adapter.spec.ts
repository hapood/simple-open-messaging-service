import type { Mock } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NativeImageDownloadAdapter } from './image-download.adapter';

describe('NativeImageDownloadAdapter', () => {
  type NativeWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: {
      core: {
        invoke: Mock;
      };
      event: {
        listen: Mock;
      };
    };
  };

  let invoke: Mock;
  let eventHandler: ((event: { payload: unknown }) => void) | undefined;
  let unlisten: Mock;
  let adapter: NativeImageDownloadAdapter;

  beforeEach(() => {
    invoke = vi.fn().mockName('invoke');
    unlisten = vi.fn().mockName('unlisten');
    eventHandler = undefined;
    const nativeWindow = window as unknown as NativeWindow;
    nativeWindow.__TAURI_INTERNALS__ = {};
    nativeWindow.__TAURI__ = {
      core: { invoke },
      event: {
        listen: vi
          .fn()
          .mockName('listen')
          .mockImplementation(
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
    invoke.mockImplementation(
      (command: string) =>
        command === 'download_media' &&
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const events: unknown[] = [];
    adapter
      .download('/uploads/photo.jpg')
      .subscribe((event) => events.push(event));
    await vi.waitFor(() =>
      expect(
        vi.mocked(invoke).mock.calls.some((call) => call[0] === 'download_media'),
      ).toBe(true),
    );
    const downloadCall = vi
      .mocked(invoke)
      .mock.calls.find((call) => call[0] === 'download_media');
    const taskId = downloadCall?.[1].taskId as string;
    eventHandler?.({
      payload: { taskId, loaded: 1024, total: 2048 },
    });
    resolveDownload?.({
      path: '/private/cache/media.bin',
      contentType: 'image/jpeg',
      size: 2048,
    });

    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'progress',
          loaded: 1024,
          total: 2048,
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'completed',
          artifact: expect.objectContaining({
            displayUrl: 'media://localhost/uploads/photo.jpg',
            savePath: '/uploads/photo.jpg',
            size: 2048,
          }),
        }),
      );
    });
  });

  it('cancels the Rust task when the observable is unsubscribed', async () => {
    let resolveDownload: ((value: unknown) => void) | undefined;
    invoke.mockImplementation((command: string) => {
      if (command === 'cancel_media_download') return Promise.resolve(true);
      return new Promise((resolve) => {
        resolveDownload = resolve;
      });
    });

    const subscription = adapter.download('/uploads/photo.jpg').subscribe();
    await vi.waitFor(() =>
      expect(
        vi.mocked(invoke).mock.calls.some((call) => call[0] === 'download_media'),
      ).toBe(true),
    );
    const taskId = vi
      .mocked(invoke)
      .mock.calls.find((call) => call[0] === 'download_media')?.[1]
      .taskId as string;
    subscription.unsubscribe();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('cancel_media_download', { taskId });
      expect(unlisten).toHaveBeenCalled();
    });
    resolveDownload?.({
      path: '/private/cache/media.bin',
      size: 2048,
    });
  });
});
