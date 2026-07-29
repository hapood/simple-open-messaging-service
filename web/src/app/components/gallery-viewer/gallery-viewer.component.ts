import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { firstValueFrom } from 'rxjs';
import PhotoSwipe, { type SlideData } from 'photoswipe';
import {
  MEDIA_STATUS,
  type AlbumImage,
  type MediaStatus,
} from '../message-cards/chat-item';
import { assetUrl } from '../../services/runtime';
import { MsgService } from '../../services/message.service';
import { MessageRepository } from '../../services/message-repository.service';

/** Business metadata kept alongside PhotoSwipe's image data. */
interface GallerySlideData extends SlideData {
  galleryIndex: number;
  kind: AlbumImage['kind'];
}

type VideoPlaybackError = 'network' | 'unsupported';

/**
 * Fullscreen gallery powered by PhotoSwipe's gesture engine. Angular owns the chat-specific state
 * (media localization, retry and translated status surfaces); PhotoSwipe owns paging, pinch zoom,
 * double-tap zoom, pan bounds, momentum and vertical-drag dismissal.
 */
@Component({
  selector: 'app-gallery-viewer',
  standalone: true,
  imports: [TranslocoPipe, MatProgressSpinnerModule],
  templateUrl: './gallery-viewer.component.html',
  styleUrl: './gallery-viewer.component.scss',
})
export class GalleryViewerComponent implements AfterViewInit, OnDestroy {
  readonly images = input.required<AlbumImage[]>();
  readonly startIndex = input<number>(0);
  readonly threadId = input<number>(0);
  readonly close = output<void>();

  @ViewChild('mount', { static: true })
  private readonly mount?: ElementRef<HTMLElement>;
  @ViewChild('thumbRail')
  private readonly thumbRail?: ElementRef<HTMLElement>;

  readonly MEDIA_STATUS = MEDIA_STATUS;
  readonly index = signal(0);
  readonly statusOverrides = signal<Map<number, MediaStatus>>(new Map());
  readonly loadErrors = signal<Set<number>>(new Set());
  readonly videoErrors = signal<Map<number, VideoPlaybackError>>(new Map());
  readonly current = computed(() => this.images()[this.index()] ?? null);
  readonly currentStatus = computed<MediaStatus>(
    () =>
      this.statusOverrides().get(this.index()) ??
      this.current()?.status ??
      MEDIA_STATUS.READY,
  );
  readonly currentLoadFailed = computed(() =>
    this.loadErrors().has(this.index()),
  );
  readonly currentVideoError = computed(() =>
    this.videoErrors().get(this.index()) ?? null,
  );
  readonly currentUrl = computed(() =>
    assetUrl(this.current()?.src ?? ''),
  );

  private readonly retryKeys = new Map<number, number>();
  private readonly slides: GallerySlideData[] = [];
  private pswp: PhotoSwipe | null = null;
  private destroying = false;

  private readonly msg = inject(MsgService);
  private readonly repo = inject(MessageRepository);
  private readonly i18n = inject(TranslocoService);

  ngAfterViewInit(): void {
    const images = this.images();
    const mount = this.mount?.nativeElement;
    if (!mount || images.length === 0) {
      this.close.emit();
      return;
    }

    this.slides.push(
      ...images.map((image, galleryIndex) =>
        this.toSlide(image, galleryIndex),
      ),
    );
    const initialIndex = Math.max(
      0,
      Math.min(this.startIndex(), images.length - 1),
    );
    this.index.set(initialIndex);

    const pswp = new PhotoSwipe({
      dataSource: this.slides,
      index: initialIndex,
      appendToEl: mount,
      mainClass: 'soms-gallery-pswp',
      bgOpacity: 1,
      loop: images.length > 2,
      preload: [1, 1],
      allowPanToNext: true,
      // A normal pinch should zoom the photo. Avoid an accidental close when the
      // user momentarily pinches below the fitted size.
      pinchToClose: false,
      closeOnVerticalDrag: true,
      wheelToZoom: true,
      imageClickAction: false,
      bgClickAction: 'close',
      tapAction: 'toggle-controls',
      doubleTapAction: 'zoom',
      showHideAnimationType: 'fade',
      showAnimationDuration: 180,
      hideAnimationDuration: 180,
      zoomAnimationDuration: 280,
      maxZoomLevel: 5,
      secondaryZoomLevel: 2.5,
      closeTitle: this.i18n.translate('gallery.closeAria'),
      arrowPrevTitle: this.i18n.translate('gallery.prevAria'),
      arrowNextTitle: this.i18n.translate('gallery.nextAria'),
      errorMsg: this.i18n.translate('gallery.failed'),
    });

    pswp.on('change', () => {
      this.index.set(pswp.currIndex);
      this.pauseInactiveVideos(pswp.currIndex);
      queueMicrotask(() => this.scrollCurrentThumbIntoView());
    });
    pswp.on('loadComplete', ({ content, isError }) => {
      this.setLoadError(content.index, Boolean(isError));
    });
    pswp.on('loadError', ({ content }) => {
      this.setLoadError(content.index, true);
    });
    pswp.on('contentAppend', ({ content }) => {
      const slide = content.data as GallerySlideData;
      if (slide.kind !== 'video') return;
      const video = content.element?.querySelector<HTMLVideoElement>('.gv-slide-video');
      if (!video || video.dataset['errorBound'] === 'true') return;
      video.dataset['errorBound'] = 'true';
      video.addEventListener('loadeddata', () => this.setVideoError(slide.galleryIndex, null));
      video.addEventListener('error', () => {
        const code = video.error?.code;
        if (code === MediaError.MEDIA_ERR_ABORTED) return;
        this.setVideoError(
          slide.galleryIndex,
          code === MediaError.MEDIA_ERR_NETWORK ? 'network' : 'unsupported',
        );
      });
    });
    pswp.on('destroy', () => {
      this.pswp = null;
      if (!this.destroying) this.close.emit();
    });

    this.pswp = pswp;
    pswp.init();
  }

  ngOnDestroy(): void {
    this.destroying = true;
    this.pauseInactiveVideos(-1);
    this.pswp?.destroy();
    this.pswp = null;
  }

  goTo(index: number): void {
    this.pswp?.goTo(index);
  }

  mediaUrl(media: AlbumImage): string {
    return assetUrl(media.src);
  }

  /** Retry a transient image fetch with a cache-busted URL. */
  retryLoad(): void {
    const i = this.index();
    const image = this.images()[i];
    if (!image) return;
    this.retryKeys.set(i, (this.retryKeys.get(i) ?? 0) + 1);
    this.slides[i].src = this.imageUrl(image, i);
    this.setLoadError(i, false);
    this.pswp?.refreshSlideContent(i);
  }

  retryVideo(): void {
    const i = this.index();
    const media = this.images()[i];
    if (!media || media.kind !== 'video') return;
    this.retryKeys.set(i, (this.retryKeys.get(i) ?? 0) + 1);
    const src = this.imageUrl(media, i);
    const escaped = this.escapeAttribute(src);
    this.slides[i].html =
      `<video class="gv-slide-video" controls playsinline preload="metadata" ` +
      `data-gallery-index="${i}" src="${escaped}"></video>`;
    this.setVideoError(i, null);
    this.mount?.nativeElement
      .querySelectorAll<HTMLVideoElement>(`.gv-slide-video[data-gallery-index="${i}"]`)
      .forEach((video) => {
        video.src = src;
        video.load();
      });
    this.pswp?.refreshSlideContent(i);
  }

  /** Retry backend localization for a federated media item. */
  async relocalizeCurrent(): Promise<void> {
    const image = this.current();
    const threadId = this.threadId();
    if (!image?.msgId || threadId === 0) return;

    const i = this.index();
    this.setStatus(i, MEDIA_STATUS.DOWNLOADING);
    this.setLoadError(i, false);
    void this.repo.setMediaDownloading(threadId, image.msgId);

    try {
      const response = await firstValueFrom(
        this.msg.relocalizeMedia(threadId, image.msgId),
      );
      const status =
        response.code === 0 && response.data
          ? response.data.status
          : MEDIA_STATUS.FAILED;
      this.setStatus(i, status);
      if (status === MEDIA_STATUS.READY) {
        this.retryLoad();
      } else {
        this.setLoadError(i, true);
      }
    } catch {
      this.setStatus(i, MEDIA_STATUS.FAILED);
      this.setLoadError(i, true);
    }
  }

  private toSlide(image: AlbumImage, galleryIndex: number): GallerySlideData {
    if (image.kind === 'video') {
      const src = this.escapeAttribute(this.imageUrl(image, galleryIndex));
      return {
        html:
          `<video class="gv-slide-video" controls playsinline preload="metadata" ` +
          `data-gallery-index="${galleryIndex}" src="${src}"></video>`,
        width: Math.max(1, image.w),
        height: Math.max(1, image.h),
        galleryIndex,
        kind: image.kind,
      };
    }
    return {
      src: this.imageUrl(image, galleryIndex),
      width: Math.max(1, image.w),
      height: Math.max(1, image.h),
      alt: '',
      galleryIndex,
      kind: image.kind,
    };
  }

  private imageUrl(image: AlbumImage, index: number): string {
    const base = assetUrl(image.src);
    const retryKey = this.retryKeys.get(index) ?? 0;
    if (retryKey === 0 || /^(blob:|data:)/.test(base)) return base;
    return `${base}${base.includes('?') ? '&' : '?'}_r=${retryKey}`;
  }

  private setStatus(index: number, status: MediaStatus): void {
    this.statusOverrides.update((current) => {
      const next = new Map(current);
      next.set(index, status);
      return next;
    });
  }

  private setLoadError(index: number, failed: boolean): void {
    this.loadErrors.update((current) => {
      const next = new Set(current);
      if (failed) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  private setVideoError(index: number, error: VideoPlaybackError | null): void {
    this.videoErrors.update((current) => {
      const next = new Map(current);
      if (error) next.set(index, error);
      else next.delete(index);
      return next;
    });
  }

  private pauseInactiveVideos(activeIndex: number): void {
    const root = this.mount?.nativeElement;
    if (!root) return;
    // PhotoSwipe recycles three slide holders and does not expose their logical indices on the DOM.
    // Pause every video at a page boundary; the visible video keeps its position and can be resumed.
    void activeIndex;
    root.querySelectorAll<HTMLVideoElement>('.gv-slide-video').forEach((video) => video.pause());
  }

  private scrollCurrentThumbIntoView(): void {
    const current = this.thumbRail?.nativeElement.querySelector<HTMLElement>(
      `[data-index="${this.index()}"]`,
    );
    current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  private escapeAttribute(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }
}
