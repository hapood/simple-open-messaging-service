import type { Mock } from 'vitest';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { MEDIA_STATUS, type AlbumImage } from '../message-cards/chat-item';
import type { ImageDownloadTask } from '../../services/image-download.service';
import { ImageDownloadService } from '../../services/image-download.service';
import { MediaSizeThresholdService } from '../../services/media-size-threshold.service';
import { MediaSaveService } from '../../services/media-save.service';
import { MessageRepository } from '../../services/message-repository.service';
import { MsgService } from '../../services/message.service';
import { ToastService } from '../../services/toast.service';
import { MediaAvailabilityService } from '../../services/media-availability.service';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { GalleryViewerComponent } from './gallery-viewer.component';

describe('GalleryViewerComponent — deferred image actions', () => {
  const media: AlbumImage = {
    kind: 'image',
    src: '/uploads/photo.jpg',
    w: 800,
    h: 600,
    size: 1536,
    msgId: 42,
  };
  let downloads: FakeGalleryDownloads;
  let toast: {
    info: Mock;
    warn: Mock;
  };

  beforeEach(async () => {
    downloads = new FakeGalleryDownloads();
    toast = {
      info: vi.fn().mockName('info'),
      warn: vi.fn().mockName('warn'),
    };
    TestBed.configureTestingModule({
      imports: [GalleryViewerComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        { provide: ImageDownloadService, useValue: downloads },
        {
          provide: MediaSizeThresholdService,
          useValue: { shouldDefer: (size: number) => size > 1024 },
        },
        { provide: MsgService, useValue: {} },
        { provide: MessageRepository, useValue: {} },
        {
          provide: MediaAvailabilityService,
          useValue: {
            register: vi.fn(() => ({
              status: signal(MEDIA_STATUS.READY),
              subscribe: vi.fn(() => () => undefined),
              onWithdrawn: vi.fn(() => () => undefined),
              unregister: vi.fn(),
            })),
            retry: vi.fn().mockResolvedValue(MEDIA_STATUS.READY),
          },
        },
        { provide: MediaSaveService, useValue: {} },
        { provide: ToastService, useValue: toast },
      ],
    });
    const i18n = TestBed.inject(TranslocoService);
    await firstValueFrom(i18n.load('en'));
    i18n.setActiveLang('en');
  });

  it('keeps load and download as distinct intents', () => {
    const component = create();

    expect(component.currentNeedsLoad()).toBe(true);
    expect(component.formatBytes(media.size ?? 0)).toBe('1.5 KB');

    component.loadCurrent();
    expect(downloads.start).toHaveBeenCalledWith(media, 7);

    component.saveCurrent(new MouseEvent('click'));
    expect(downloads.start).toHaveBeenCalledWith(media, 7, true);
  });

  it('shows dynamic byte units and delegates cancellation for the current image', () => {
    const component = create();
    downloads.set(task('downloading', 768, 1536));

    expect(component.currentProgress()).toBe(50);
    expect(component.currentProgressText()).toBe('768 B / 1.5 KB');

    component.cancelCurrent();
    expect(downloads.cancel).toHaveBeenCalledWith(media);
  });

  it('treats cancelling a queued save as neutral and does not toast later task changes', async () => {
    const component = create();
    component.saveCurrent(new MouseEvent('click'));
    component.cancelCurrent();

    downloads.set(task('failed', 768, 1536));
    TestBed.flushEffects();
    await Promise.resolve();

    expect(toast.warn).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('toasts a queued save exactly once when the shared task reaches saved', async () => {
    const component = create();
    component.saveCurrent(new MouseEvent('click'));

    downloads.set(task('saved', 1536, 1536));
    TestBed.flushEffects();
    await Promise.resolve();
    expect(toast.info).toHaveBeenCalledTimes(1);

    downloads.tasks.set([...downloads.tasks()]);
    TestBed.flushEffects();
    await Promise.resolve();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it('shows thumbnails for paused video and hides them while video is playing', () => {
    const component = create([
      media,
      {
        kind: 'video',
        src: '/uploads/clip.mp4',
        w: 1280,
        h: 720,
        msgId: 43,
      },
    ]);

    expect(component.showThumbs()).toBe(true);
    component.index.set(1);
    expect(component.currentIsVideo()).toBe(true);
    expect(component.showThumbs()).toBe(true);
    component.videoPlaying.set(true);
    expect(component.showThumbs()).toBe(false);
    component.videoPlaying.set(false);
    expect(component.showThumbs()).toBe(true);
  });

  it('uses one shared visibility state for the viewer chrome', () => {
    const component = create();

    expect(component.chromeVisible()).toBe(true);
    component.toggleChrome();
    expect(component.chromeVisible()).toBe(false);
    component.toggleChrome();
    expect(component.chromeVisible()).toBe(true);
  });

  it('leaves normal video gestures to PhotoSwipe and isolates them only in fullscreen', () => {
    const component = create();
    const parent = document.createElement('div');
    const container = document.createElement('div');
    parent.append(container);
    const pointerDown = vi.fn().mockName('pointerDown');
    parent.addEventListener('pointerdown', pointerDown);
    const setIsolation = (
      component as unknown as {
        prepareVideoGestureIsolation(
          element: HTMLElement,
        ): (active: boolean) => void;
      }
    ).prepareVideoGestureIsolation(container);

    container.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pointerDown).toHaveBeenCalledTimes(1);

    setIsolation(true);
    container.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pointerDown).toHaveBeenCalledTimes(1);

    setIsolation(false);
    container.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pointerDown).toHaveBeenCalledTimes(2);
  });

  it('fully destroys an inactive video player so its media resources are released', () => {
    const component = create();
    const destroy = vi.fn().mockName('destroy');
    const internals = component as unknown as {
      videoPlayers: Map<
        number,
        {
          destroy(clearHtml: boolean): void;
        }
      >;
      destroyVideoPlayer(index: number): void;
    };
    internals.videoPlayers.set(1, { destroy });

    internals.destroyVideoPlayer(1);

    expect(destroy).toHaveBeenCalledTimes(1);

    expect(destroy).toHaveBeenCalledWith(true);
    expect(internals.videoPlayers.has(1)).toBe(false);
  });

  it('destroys video A on image switch and rebuilds it only when returning', () => {
    const video: AlbumImage = {
      kind: 'video',
      src: '/uploads/a.mp4',
      w: 1280,
      h: 720,
      msgId: 43,
    };
    const component = create([video, media]);
    const destroy = vi.fn().mockName('destroy');
    const contentElement = document.createElement('div');
    const internals = component as unknown as {
      videoPlayers: Map<
        number,
        {
          destroy(clearHtml: boolean): void;
          play(): Promise<void>;
        }
      >;
      pswp: {
        currSlide: {
          content: {
            element: HTMLElement;
          };
        };
        destroy(): void;
      };
      activateVideo(index: number): void;
      mountVideoPlayer(element: HTMLElement, index: number): Promise<void>;
    };
    internals.videoPlayers.set(0, {
      destroy,
      play: () => Promise.resolve(),
    });

    component.index.set(1);
    internals.activateVideo(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(true);
    expect(internals.videoPlayers.size).toBe(0);

    internals.pswp = {
      currSlide: { content: { element: contentElement } },
      destroy: () => undefined,
    };
    const mount = vi
      .spyOn(internals, 'mountVideoPlayer')
      .mockResolvedValue(undefined);
    component.index.set(0);
    internals.activateVideo(0);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledWith(contentElement, 0);
  });

  it('destroys every mounted player when the viewer closes', () => {
    const component = create();
    const destroyA = vi.fn().mockName('destroyA');
    const destroyB = vi.fn().mockName('destroyB');
    const internals = component as unknown as {
      videoPlayers: Map<
        number,
        {
          destroy(clearHtml: boolean): void;
        }
      >;
      destroyVideoPlayers(): void;
    };
    internals.videoPlayers.set(0, { destroy: destroyA });
    internals.videoPlayers.set(2, { destroy: destroyB });

    internals.destroyVideoPlayers();

    expect(destroyA).toHaveBeenCalledTimes(1);

    expect(destroyA).toHaveBeenCalledWith(true);
    expect(destroyB).toHaveBeenCalledTimes(1);
    expect(destroyB).toHaveBeenCalledWith(true);
    expect(internals.videoPlayers.size).toBe(0);
  });

  it('renders video errors inside the player with an error-specific action', () => {
    const component = create();
    const internals = component as unknown as {
      videoErrorLayers: Map<number, HTMLElement>;
      createVideoErrorLayer(index: number): HTMLElement;
      setVideoError(index: number, error: 'network' | 'unsupported'): void;
      retryVideoAt(index: number): void;
      saveVideo(index: number): Promise<void>;
    };
    const layer = internals.createVideoErrorLayer(0);
    internals.videoErrorLayers.set(0, layer);
    const retry = vi
      .spyOn(internals, 'retryVideoAt')
      .mockReturnValue(undefined);
    const save = vi.spyOn(internals, 'saveVideo').mockResolvedValue(undefined);
    const action = layer.querySelector<HTMLButtonElement>(
      '.gv-video-error__action',
    )!;

    internals.setVideoError(0, 'network');
    expect(layer.hidden).toBe(false);
    expect(layer.textContent).toContain(
      "Video couldn't be loaded. Check your connection and try again.",
    );
    expect(action.textContent).toBe('Retry');
    action.click();
    expect(retry).toHaveBeenCalledWith(0);

    internals.setVideoError(0, 'unsupported');
    expect(layer.textContent).toContain(
      "This video format or codec isn't supported on this device.",
    );
    expect(action.textContent).toBe('Download video');
    action.click();
    expect(save).toHaveBeenCalledWith(0);
  });

  function create(images: AlbumImage[] = [media]): GalleryViewerComponent {
    const fixture = TestBed.createComponent(GalleryViewerComponent);
    fixture.componentRef.setInput('images', images);
    fixture.componentRef.setInput('startIndex', 0);
    fixture.componentRef.setInput('threadId', 7);
    return fixture.componentInstance;
  }

  function task(
    status: ImageDownloadTask['status'],
    loaded: number,
    total: number,
  ): ImageDownloadTask {
    return {
      key: downloads.key(media),
      threadId: 7,
      msgId: 42,
      src: media.src,
      name: 'photo.jpg',
      expectedSize: 1536,
      loaded,
      total,
      status,
      saveAfterLoad: true,
      blobUrl: status === 'saved' ? 'blob:photo' : null,
      startedAt: 1,
    };
  }
});

class FakeGalleryDownloads {
  readonly tasks = signal<ImageDownloadTask[]>([]);
  readonly start = vi.fn().mockName('start');
  readonly cancel = vi.fn().mockName('cancel');
  readonly retry = vi.fn().mockName('retry');
  private current: ImageDownloadTask | undefined;

  key(media: Pick<AlbumImage, 'msgId' | 'src'>): string {
    return `${media.msgId ?? 0}:${media.src}`;
  }

  task(): ImageDownloadTask | undefined {
    this.tasks();
    return this.current;
  }

  displayUrl(media: AlbumImage): string {
    return this.current?.blobUrl ?? media.src;
  }

  isLoaded(): boolean {
    return Boolean(this.current?.blobUrl);
  }

  set(task: ImageDownloadTask): void {
    this.current = task;
    this.tasks.set([task]);
  }
}
