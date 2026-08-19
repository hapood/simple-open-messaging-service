import type { Mock } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import type { AlbumImage } from '../components/message-cards/chat-item';
import {
  IMAGE_DOWNLOAD_ADAPTER,
  type ImageDownloadEvent,
} from './image-download.adapter';
import { ImageDownloadService } from './image-download.service';
import {
  MediaSaveCancelledError,
  MediaSaveService,
} from './media-save.service';

describe('ImageDownloadService', () => {
  const media: AlbumImage = {
    kind: 'image',
    src: '/uploads/photo.jpg',
    w: 800,
    h: 600,
    size: 2000,
    msgId: 42,
  };
  let events: Subject<ImageDownloadEvent>;
  let teardown: Mock;
  let save: Mock;
  let service: ImageDownloadService;

  beforeEach(() => {
    events = new Subject<ImageDownloadEvent>();
    teardown = vi.fn().mockName('teardown');
    save = vi.fn().mockName('save').mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: IMAGE_DOWNLOAD_ADAPTER,
          useValue: {
            download: () =>
              new Observable<ImageDownloadEvent>((subscriber) => {
                const subscription = events.subscribe(subscriber);
                return () => {
                  subscription.unsubscribe();
                  teardown();
                };
              }),
          },
        },
        { provide: MediaSaveService, useValue: { save } },
      ],
    });
    service = TestBed.inject(ImageDownloadService);
  });

  it('shares byte progress and exposes the completed local artifact', () => {
    service.start(media, 7);
    events.next({ type: 'progress', loaded: 750, total: 2000 });
    expect(service.task(media)).toEqual(
      expect.objectContaining({
        loaded: 750,
        total: 2000,
        status: 'downloading',
      }),
    );

    events.next({
      type: 'completed',
      artifact: {
        displayUrl: 'blob:test',
        savePath: 'blob:test',
        size: 2000,
        release: vi.fn().mockName('release'),
      },
    });
    expect(service.task(media)).toEqual(
      expect.objectContaining({ status: 'loaded', blobUrl: 'blob:test' }),
    );
  });

  it('coalesces bursty progress events while preserving the newest byte count', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1000));
      service.start(media, 7);
      events.next({ type: 'progress', loaded: 100, total: 2000 });
      events.next({ type: 'progress', loaded: 300, total: 2000 });
      events.next({ type: 'progress', loaded: 500, total: 2000 });

      expect(service.task(media)?.loaded).toBe(100);
      vi.advanceTimersByTime(100);
      expect(service.task(media)?.loaded).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the adapter subscription and removes the task on cancel', () => {
    service.start(media, 7);
    service.cancel(media);
    expect(teardown).toHaveBeenCalled();
    expect(service.task(media)).toBeUndefined();
  });

  it('clears save-after-load intent when a save download is cancelled', () => {
    service.start(media, 7, true);
    expect(service.task(media)?.saveAfterLoad).toBe(true);

    service.cancel(media);
    expect(service.task(media)).toBeUndefined();

    service.start(media, 7);
    expect(service.task(media)?.saveAfterLoad).toBe(false);
  });

  it('upgrades an in-flight view load to save-after-load without a second request', async () => {
    service.start(media, 7);
    service.start(media, 7, true);
    events.next({
      type: 'completed',
      artifact: {
        displayUrl: 'blob:test',
        savePath: 'blob:test',
        size: 2000,
        release: vi.fn().mockName('release'),
      },
    });
    await Promise.resolve();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'blob:test' }),
    );
  });

  it('keeps a downloaded image loaded when the platform save picker is cancelled', async () => {
    save.mockRejectedValue(new MediaSaveCancelledError());
    service.start(media, 7, true);
    events.next({
      type: 'completed',
      artifact: {
        displayUrl: 'blob:test',
        savePath: 'blob:test',
        size: 2000,
        release: vi.fn().mockName('release'),
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(service.task(media)).toEqual(
      expect.objectContaining({
        status: 'loaded',
        saveAfterLoad: false,
        blobUrl: 'blob:test',
      }),
    );
  });
});
