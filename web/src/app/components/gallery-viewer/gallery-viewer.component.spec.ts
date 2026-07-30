import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import type { AlbumImage } from '../message-cards/chat-item';
import type { ImageDownloadTask } from '../../services/image-download.service';
import { ImageDownloadService } from '../../services/image-download.service';
import { MediaSizeThresholdService } from '../../services/media-size-threshold.service';
import { MediaSaveService } from '../../services/media-save.service';
import { MessageRepository } from '../../services/message-repository.service';
import { MsgService } from '../../services/message.service';
import { ToastService } from '../../services/toast.service';
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
  let toast: { info: jasmine.Spy; warn: jasmine.Spy };

  beforeEach(() => {
    downloads = new FakeGalleryDownloads();
    toast = {
      info: jasmine.createSpy('info'),
      warn: jasmine.createSpy('warn'),
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
          useValue: { threshold: signal(1024) },
        },
        { provide: MsgService, useValue: {} },
        { provide: MessageRepository, useValue: {} },
        { provide: MediaSaveService, useValue: {} },
        { provide: ToastService, useValue: toast },
      ],
    });
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
    const retry = spyOn(internals, 'retryVideoAt');
    const save = spyOn(internals, 'saveVideo').and.resolveTo();
    const action = layer.querySelector<HTMLButtonElement>(
      '.gv-video-error__action',
    )!;

    internals.setVideoError(0, 'network');
    expect(layer.hidden).toBe(false);
    expect(layer.textContent).toContain('gallery.videoNetworkFailed');
    expect(action.textContent).toBe('common.retry');
    action.click();
    expect(retry).toHaveBeenCalledWith(0);

    internals.setVideoError(0, 'unsupported');
    expect(layer.textContent).toContain('gallery.videoUnsupported');
    expect(action.textContent).toBe('gallery.downloadVideo');
    action.click();
    expect(save).toHaveBeenCalledWith(0);
  });

  function create(): GalleryViewerComponent {
    const fixture = TestBed.createComponent(GalleryViewerComponent);
    fixture.componentRef.setInput('images', [media]);
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
  readonly start = jasmine.createSpy('start');
  readonly cancel = jasmine.createSpy('cancel');
  readonly retry = jasmine.createSpy('retry');
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
