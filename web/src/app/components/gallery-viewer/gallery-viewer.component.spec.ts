import type { Mock } from 'vitest';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of, Subject } from 'rxjs';
import {
  MediaFileProgressService,
  type MediaFileProgress,
} from '../../services/media-file-progress.service';
import { MEDIA_STATUS, type AlbumMedia } from '../message-cards/chat-item';
import type { ImageDownloadTask } from '../../services/image-download.service';
import { ImageDownloadService } from '../../services/image-download.service';
import { DownloadService } from '../../services/download.service';
import { MessageRepository } from '../../services/message-repository.service';
import { MsgService } from '../../services/message.service';
import { ToastService } from '../../services/toast.service';

import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { GalleryViewerComponent } from './gallery-viewer.component';

describe('GalleryViewerComponent — deferred image actions', () => {
  const media: AlbumMedia = {
    kind: 'image',
    src: '/uploads/photo.jpg',
    w: 800,
    h: 600,
    size: 1536,
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    senderName: null,
    sentAt: null,
    msgId: 42,
  };
  let deleted: Subject<{
    threadId: number;
    deletions: Array<{
      seq: number;
      type: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
    }>;
  }>;
  let downloads: FakeGalleryDownloads;
  let toast: {
    info: Mock;
    warn: Mock;
  };

  beforeEach(async () => {
    deleted = new Subject();
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
          provide: MediaFileProgressService,
          useValue: {
            observe: vi.fn(() =>
              of({
                status: 'ready',
                loaded: 100,
                total: 100,
                bytesPerSecond: null,
              }),
            ),
          },
        },
        {
          provide: MsgService,
          useValue: {
            relocalizeMedia: vi.fn(() =>
              of({ code: 0, data: { status: MEDIA_STATUS.PENDING } }),
            ),
          },
        },
        {
          provide: MessageRepository,
          useValue: { deletedLive$: deleted.asObservable() },
        },

        {
          provide: DownloadService,
          useValue: { download: vi.fn(async () => undefined) },
        },
        { provide: ToastService, useValue: toast },
      ],
    });
    const i18n = TestBed.inject(TranslocoService);
    await firstValueFrom(i18n.load('en'));
    i18n.setActiveLang('en');
  });

  it('keeps load and download as distinct intents', async () => {
    const fixture = await mount();
    const component = fixture.componentInstance;

    expect(component.currentNeedsLoad()).toBe(true);
    expect(component.formatBytes(media.size ?? 0)).toBe('1.5 KB');

    component.loadCurrent();
    expect(downloads.start).not.toHaveBeenCalled();
    expect(component.currentNeedsLoad()).toBe(false);

    component.saveCurrent(new MouseEvent('click'));
    expect(downloads.start).not.toHaveBeenCalled();
    expect(TestBed.inject(DownloadService).download).toHaveBeenCalledWith(
      expect.objectContaining({ path: media.src, threadId: 7 }),
    );
  });

  it('preserves the actual MIME type when saving media', async () => {
    const component = create([
      {
        ...media,
        src: '/uploads/animation.webp',
        mimeType: 'image/webp',
        name: 'animation.webp',
      },
    ]);
    await component.saveCurrent(new MouseEvent('click'));
    expect(TestBed.inject(DownloadService).download).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'image/webp',
        filename: 'animation.webp',
      }),
    );
  });

  it('does not infer a file format from the media category', async () => {
    const component = create([media]);
    await component.saveCurrent(new MouseEvent('click'));
    expect(TestBed.inject(DownloadService).download).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'image/jpeg',
        filename: 'photo.jpg',
      }),
    );
  });

  it('does not infer download completion from unrelated image cache tasks', async () => {
    const component = create();
    component.saveCurrent(new MouseEvent('click'));

    downloads.set(task('loaded', 1536, 1536));
    TestBed.flushEffects();
    await Promise.resolve();
    expect(toast.info).not.toHaveBeenCalled();

    downloads.tasks.set([...downloads.tasks()]);
    TestBed.flushEffects();
    await Promise.resolve();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('shows thumbnails for paused video and hides them while video is playing', () => {
    const component = create([
      media,
      {
        kind: 'video',
        duration: 12,
        size: 4096,
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        senderName: null,
        sentAt: null,
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
    const video: AlbumMedia = {
      kind: 'video',
      duration: 12,
      size: 4096,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      senderName: null,
      sentAt: null,
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

  it('starts the active Android video through Rust without a second play-button tap', async () => {
    const video: AlbumMedia = {
      kind: 'video',
      duration: 12,
      size: 4096,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      senderName: null,
      sentAt: null,
      src: '/uploads/video',
      w: 1080,
      h: 1920,
      msgId: 43,
    };
    const component = create([video, video]);
    Object.defineProperty(component, 'isAndroidApp', { value: true });
    const stream = {
      streamUrl: 'http://localhost:1234/video/capability',
    };
    const internals = component as unknown as {
      nativeVideo: { stream(path: string): Promise<typeof stream> };
      mountVideoPlayer(element: HTMLElement, index: number): Promise<void>;
      createVideoPlayer(
        element: HTMLElement,
        media: AlbumMedia,
        index: number,
        local: typeof stream,
      ): Promise<void>;
    };
    const request = vi
      .spyOn(internals.nativeVideo, 'stream')
      .mockResolvedValue(stream);
    const mount = vi
      .spyOn(internals, 'createVideoPlayer')
      .mockResolvedValue(undefined);
    const container = document.createElement('div');
    container.className = 'gv-slide-video';
    document.body.append(container);
    try {
      await internals.mountVideoPlayer(container, 1);
      expect(request).not.toHaveBeenCalled();
      await internals.mountVideoPlayer(container, 0);
      expect(request).toHaveBeenCalledWith(video.src);
      expect(mount).toHaveBeenCalledWith(container, video, 0, stream);
    } finally {
      container.remove();
    }
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

  it('mounts an independent thumbnail cell for every visual resource beyond six items', async () => {
    const observe = TestBed.inject(MediaFileProgressService).observe;
    const fixture = TestBed.createComponent(GalleryViewerComponent);
    const images = Array.from({ length: 8 }, (_, index) => ({
      ...media,
      msgId: index + 1,
    }));
    fixture.componentRef.setInput('images', images);
    fixture.componentRef.setInput('threadId', 7);
    fixture.componentRef.setInput('startIndex', 0);
    // Isolate rail composition from the original-media player lifecycle.
    vi.spyOn(fixture.componentInstance, 'ngAfterViewInit').mockImplementation(
      () => undefined,
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelectorAll('.gv-thumb app-album-media-cell'),
    ).toHaveLength(8);
    // Eight rail cells plus the current detail surface own their observations.
    expect(observe).toHaveBeenCalledTimes(9);
    fixture.destroy();
  });

  const managedMedia: AlbumMedia = {
    ...media,
    src: `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}?threadId=7&seq=42`,
    msgId: 999,
  };

  it('retries the authorizing carrier rather than the snapshot display ID', async () => {
    const fixture = await mount([managedMedia]);
    fixture.componentRef.setInput('threadId', 0);
    const observe = vi.mocked(TestBed.inject(MediaFileProgressService).observe);
    const before = observe.mock.calls.length;
    await fixture.componentInstance.relocalizeCurrent();
    await fixture.whenStable();
    expect(
      TestBed.inject(MsgService).relocalizeMedia,
    ).toHaveBeenCalledExactlyOnceWith(7, 42);
    expect(observe).toHaveBeenCalledTimes(before + 1);
    fixture.destroy();
  });

  it('keeps download history in the opening context without rewriting the authorized URL', async () => {
    const fixture = await mount([managedMedia]);
    fixture.componentRef.setInput('threadId', 0);
    await fixture.componentInstance.saveCurrent(new MouseEvent('click'));
    expect(
      TestBed.inject(DownloadService).download,
    ).toHaveBeenCalledExactlyOnceWith({
      threadId: 0,
      path: managedMedia.src,
      filename: managedMedia.name,
      mimeType: managedMedia.mimeType,
    });
    fixture.destroy();
  });

  it('does not reopen progress when localization retry is rejected', async () => {
    vi.mocked(TestBed.inject(MsgService).relocalizeMedia).mockReturnValue(
      of({ code: 1, message: 'retry rejected' }),
    );
    const fixture = await mount([managedMedia]);
    const observe = vi.mocked(TestBed.inject(MediaFileProgressService).observe);
    const before = observe.mock.calls.length;
    await fixture.componentInstance.relocalizeCurrent();
    await fixture.whenStable();
    expect(observe).toHaveBeenCalledTimes(before);
    expect(fixture.componentInstance.loadErrors().has(0)).toBe(true);
    fixture.destroy();
  });

  it('ignores retry completion for the observation of a different current file', async () => {
    const response = new Subject<{
      code: number;
      message: string;
      data: { status: 'pending' };
    }>();
    vi.mocked(TestBed.inject(MsgService).relocalizeMedia).mockReturnValue(
      response,
    );
    const fixture = await mount([
      managedMedia,
      { ...media, src: '/uploads/other.jpg', msgId: 43 },
    ]);
    const pending = fixture.componentInstance.relocalizeCurrent();
    fixture.componentInstance.goTo(1);
    await fixture.whenStable();
    const observe = vi.mocked(TestBed.inject(MediaFileProgressService).observe);
    const before = observe.mock.calls.length;
    response.next({ code: 0, message: '', data: { status: 'pending' } });
    await pending;
    await fixture.whenStable();
    expect(observe).toHaveBeenCalledTimes(before);
    expect(fixture.componentInstance.current()?.msgId).toBe(43);
    fixture.destroy();
  });

  it('ignores an older retry failure after a newer retry succeeds', async () => {
    const older = new Subject<{ code: number; message: string }>();
    const retry = vi.mocked(TestBed.inject(MsgService).relocalizeMedia);
    retry.mockReturnValueOnce(older);
    const fixture = await mount([managedMedia]);
    const pending = fixture.componentInstance.relocalizeCurrent();
    await fixture.componentInstance.relocalizeCurrent();
    await fixture.whenStable();
    older.next({ code: 1, message: 'obsolete rejection' });
    await pending;
    expect(fixture.componentInstance.loadErrors().size).toBe(0);
    fixture.destroy();
  });

  it('ignores localization errors after the viewer is destroyed', async () => {
    const response = new Subject<{ code: number; message: string }>();
    vi.mocked(TestBed.inject(MsgService).relocalizeMedia).mockReturnValueOnce(
      response,
    );
    const fixture = await mount([managedMedia]);
    const pending = fixture.componentInstance.relocalizeCurrent();
    fixture.destroy();
    response.error(new Error('late network failure'));
    await pending;
    expect(fixture.componentInstance.loadErrors().size).toBe(0);
  });

  it('does not interpret download authorization as a timeline deletion coordinate', async () => {
    const fixture = await mount([managedMedia]);
    fixture.componentRef.setInput('threadId', 0);
    await fixture.whenStable();
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);
    deleted.next({
      threadId: 7,
      deletions: [{ seq: 999, type: 'USER_RETRACTION' }],
    });
    deleted.next({
      threadId: 0,
      deletions: [{ seq: 42, type: 'USER_RETRACTION' }],
    });
    expect(close).not.toHaveBeenCalled();
    deleted.next({
      threadId: 7,
      deletions: [{ seq: 42, type: 'MODERATION_REMOVAL' }],
    });
    expect(close).not.toHaveBeenCalled();
    fixture.destroy();
    expect(deleted.observed).toBe(false);
  });

  it('replaces the timeline deletion subscription when the current attachment changes', async () => {
    const fixture = await mount([
      media,
      { ...media, src: '/uploads/other.jpg', msgId: 43 },
    ]);
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);
    fixture.componentInstance.goTo(1);
    await fixture.whenStable();
    expect(fixture.componentInstance.current()?.msgId).toBe(43);
    deleted.next({
      threadId: 7,
      deletions: [{ seq: 42, type: 'USER_RETRACTION' }],
    });
    expect(close).not.toHaveBeenCalled();
    deleted.next({
      threadId: 7,
      deletions: [{ seq: 43, type: 'USER_RETRACTION' }],
    });
    expect(close).toHaveBeenCalledOnce();
    fixture.destroy();
  });

  it('shows only server speed in the detail mask and closes when the current file is deleted', async () => {
    const progress = new Subject<MediaFileProgress>();
    vi.mocked(TestBed.inject(MediaFileProgressService).observe).mockReturnValue(
      progress,
    );
    const fixture = await mount([{ ...media, kind: 'file' }]);
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);
    downloads.set(task('downloading', 700, 1000));
    progress.next({
      status: 'downloading',
      loaded: 50,
      total: 100,
      bytesPerSecond: 2048,
    });
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('.gv-server-download .speed')
        .textContent,
    ).toBe('2.0 KB/s');
    expect(
      fixture.nativeElement
        .querySelector('.gv-server-download [role="progressbar"]')
        .getAttribute('aria-valuenow'),
    ).toBe('50');
    progress.next({
      status: 'ready',
      loaded: 100,
      total: 100,
      bytesPerSecond: null,
    });
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('.gv-server-download'),
    ).toBeNull();
    expect(fixture.nativeElement.querySelector('.gv-load-progress')).toBeNull();
    deleted.next({
      threadId: 8,
      deletions: [{ seq: 42, type: 'USER_RETRACTION' }],
    });
    expect(close).not.toHaveBeenCalled();
    deleted.next({
      threadId: 7,
      deletions: [{ seq: 42, type: 'USER_RETRACTION' }],
    });
    expect(close).toHaveBeenCalledOnce();
    fixture.destroy();
    expect(progress.observed).toBe(false);
  });

  it('switches type-specific metadata and uses the same original-file download action', async () => {
    const file: AlbumMedia = {
      kind: 'file',
      src: '/uploads/report.pdf',
      name: 'report.pdf',
      size: 2048,
      mimeType: 'application/pdf',
      senderName: 'Alice',
      sentAt: 1700000000000,
      msgId: 43,
    };
    const audio: AlbumMedia = {
      kind: 'audio',
      src: '/uploads/voice.ogg',
      name: 'voice.ogg',
      size: 4096,
      mimeType: 'audio/ogg',
      duration: 12,
      senderName: 'Bob',
      sentAt: 1700000001000,
      msgId: 44,
    };
    const fixture = await mount([media, file, audio]);
    const component = fixture.componentInstance;
    const metadata = () =>
      fixture.nativeElement.querySelector('app-attachment-metadata')
        .textContent;
    expect(metadata()).toContain('800 × 600');
    component.goTo(1);
    await fixture.whenStable();
    expect(metadata()).toContain('report.pdf');
    expect(metadata()).toContain('application/pdf');
    expect(metadata()).toContain('Alice');
    expect(metadata()).not.toContain('800 × 600');
    expect(
      fixture.nativeElement.querySelector('.gv-file-content'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.gv-load-button')).toBeNull();
    fixture.nativeElement.querySelector('.gv-download').click();
    expect(TestBed.inject(DownloadService).download).toHaveBeenCalledWith({
      threadId: 7,
      path: file.src,
      filename: file.name,
      mimeType: file.mimeType,
    });
    component.goTo(2);
    await fixture.whenStable();
    expect(metadata()).toContain('voice.ogg');
    expect(metadata()).toContain('0:12');
    expect(fixture.nativeElement.querySelector('.gv-file-content')).toBeNull();
    expect(
      fixture.nativeElement
        .querySelector('.gv-audio-content audio')
        .getAttribute('src'),
    ).toBe(audio.src);
    component.goTo(1);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('.gv-audio-content audio'),
    ).toBeNull();
    fixture.destroy();
  });

  async function mount(images: AlbumMedia[] = [media]) {
    const fixture = TestBed.createComponent(GalleryViewerComponent);
    fixture.componentRef.setInput('images', images);
    fixture.componentRef.setInput('startIndex', 0);
    fixture.componentRef.setInput('threadId', 7);
    vi.spyOn(fixture.componentInstance, 'ngAfterViewInit').mockImplementation(
      () => undefined,
    );
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  function create(images: AlbumMedia[] = [media]): GalleryViewerComponent {
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
      blobUrl: status === 'loaded' ? 'blob:photo' : null,
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

  key(media: Pick<AlbumMedia, 'msgId' | 'src'>): string {
    return `${media.msgId ?? 0}:${media.src}`;
  }

  task(): ImageDownloadTask | undefined {
    this.tasks();
    return this.current;
  }

  thumbnailUrl(media: AlbumMedia): string {
    return media.src;
  }

  displayUrl(media: AlbumMedia): string {
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
