import type { Mock } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import type { AlbumMedia } from '../components/message-cards/chat-item';
import {
  IMAGE_DOWNLOAD_ADAPTER,
  type ImageDownloadEvent,
} from './image-download.adapter';
import { ImageDownloadService } from './image-download.service';

describe('ImageDownloadService', () => {
  const media: AlbumMedia = {
    kind: 'image',
    src: '/uploads/photo.jpg',
    w: 800,
    h: 600,
    size: 2000,
    name: 'photo.jpg', mimeType: 'image/jpeg', senderName: null, sentAt: null,
    msgId: 42,
  };
  let events: Subject<ImageDownloadEvent>;
  let teardown: Mock;
  let service: ImageDownloadService;

  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    events = new Subject<ImageDownloadEvent>();
    teardown = vi.fn().mockName('teardown');
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
      ],
    });
    service = TestBed.inject(ImageDownloadService);
  });

  afterEach(() => { delete window.__TAURI_INTERNALS__; });

  it('rejects browser task admission without starting a transport', () => {
    delete window.__TAURI_INTERNALS__;
    expect(() => service.start(media, 7)).toThrow('Browser images');
    expect(service.tasks()).toEqual([]);
    expect(events.observed).toBe(false);
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
        contentType: 'image/jpeg',
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

  it('shares an in-flight preview without starting another request', () => {
    service.start(media, 7);
    service.start(media, 7);
    expect(teardown).not.toHaveBeenCalled();
    expect(service.tasks()).toHaveLength(1);
  });
});
