import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { firstValueFrom } from 'rxjs';
import type Artplayer from 'artplayer';
import PhotoSwipe, { type SlideData } from 'photoswipe';
import {
  MEDIA_STATUS,
  type AlbumImage,
  type MediaStatus,
} from '../message-cards/chat-item';
import { MsgService } from '../../services/message.service';
import { MessageRepository } from '../../services/message-repository.service';
import { MediaSaveService } from '../../services/media-save.service';
import { ToastService } from '../../services/toast.service';
import { ImageDownloadService } from '../../services/image-download.service';
import { MediaSizeThresholdService } from '../../services/media-size-threshold.service';
import { formatBytes } from '../message-cards/file-meta.util';
import { NativeVideoService } from '../../services/native-video.service';
import {
  ANDROID_MEDIA3_ENABLED,
  type LocalVideoStream,
  isAndroid,
  isTauri,
} from '../../services/runtime';

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
  readonly chromeVisible = signal(true);
  readonly videoFullscreen = signal(false);
  readonly videoPlaying = signal(false);
  readonly current = computed(() => this.images()[this.index()] ?? null);
  readonly currentIsVideo = computed(() => this.current()?.kind === 'video');
  readonly showThumbs = computed(
    () =>
      this.images().length > 1 &&
      (!this.currentIsVideo() || !this.videoPlaying()),
  );
  readonly currentStatus = computed<MediaStatus>(
    () =>
      this.statusOverrides().get(this.index()) ??
      this.current()?.status ??
      MEDIA_STATUS.READY,
  );
  readonly currentLoadFailed = computed(() =>
    this.loadErrors().has(this.index()),
  );
  readonly currentUrl = computed(() =>
    this.current() ? this.downloads.displayUrl(this.current()!) : '',
  );
  readonly currentTask = computed(() => {
    this.downloads.tasks();
    const media = this.current();
    return media ? this.downloads.task(media) : undefined;
  });
  readonly currentNeedsLoad = computed(() => {
    const media = this.current();
    return Boolean(media?.kind === 'image' && this.shouldGate(media));
  });
  readonly currentProgress = computed(() => {
    const task = this.currentTask();
    return task && task.total > 0
      ? Math.min(100, Math.round((task.loaded / task.total) * 100))
      : null;
  });
  readonly currentProgressText = computed(() => {
    const task = this.currentTask();
    if (!task) return '';
    const loaded = formatBytes(task.loaded);
    const total = formatBytes(task.total || task.expectedSize);
    return total
      ? `${loaded || '0 B'} / ${total}`
      : loaded
        ? this.i18n.translate('gallery.downloadedBytes', { size: loaded })
        : '';
  });
  readonly saving = computed(() => this.currentTask()?.status === 'saving');

  private readonly retryKeys = new Map<number, number>();
  private readonly slides: GallerySlideData[] = [];
  private readonly videoPlayers = new Map<number, Artplayer>();
  private readonly videoPlayerMounts = new Set<number>();
  private readonly videoErrorLayers = new Map<number, HTMLElement>();
  private pswp: PhotoSwipe | null = null;
  private destroying = false;
  private readonly saveToastKeys = new Set<string>();
  private readonly renderedBlobUrls = new Map<number, string>();

  private readonly msg = inject(MsgService);
  private readonly repo = inject(MessageRepository);
  private readonly i18n = inject(TranslocoService);
  private readonly mediaSave = inject(MediaSaveService);
  private readonly toast = inject(ToastService);
  readonly downloads = inject(ImageDownloadService);
  private readonly nativeVideo = inject(NativeVideoService);
  readonly isAndroidApp = isTauri() && isAndroid();
  readonly useNativeVideo = this.isAndroidApp && ANDROID_MEDIA3_ENABLED;
  readonly compactVideoControls =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(pointer: coarse)').matches ||
      window.innerWidth <= 768);
  private readonly threshold = inject(MediaSizeThresholdService);
  readonly formatBytes = formatBytes;

  constructor() {
    effect(() => {
      const tasks = this.downloads.tasks();
      for (const task of tasks) {
        if (task.status === 'saved' && this.saveToastKeys.delete(task.key)) {
          this.toast.info(this.i18n.translate('gallery.saved'));
        } else if (
          task.status === 'failed' &&
          this.saveToastKeys.delete(task.key)
        ) {
          this.toast.warn(this.i18n.translate('gallery.saveFailed'));
        }
      }
      queueMicrotask(() => this.refreshDownloadedSlides());
    });
  }

  ngAfterViewInit(): void {
    const images = this.images();
    const mount = this.mount?.nativeElement;
    if (!mount || images.length === 0) {
      this.close.emit();
      return;
    }

    this.slides.push(
      ...images.map((image, galleryIndex) => this.toSlide(image, galleryIndex)),
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
      // Artplayer owns taps while a video is active; letting both gesture engines toggle chrome would
      // immediately undo one another. Photo pages use the shared viewer chrome directly.
      tapAction: () => {
        if (!this.currentIsVideo()) this.toggleChrome();
      },
      doubleTapAction: 'zoom',
      showHideAnimationType: 'none',
      showAnimationDuration: 0,
      hideAnimationDuration: 0,
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
      this.chromeVisible.set(true);
      this.activateVideo(pswp.currIndex);
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
      // PhotoSwipe appends adjacent slides for preload. Only Android's lightweight poster needs setup
      // offscreen; a browser Artplayer is created exclusively for the active slide.
      if (!this.isAndroidApp && slide.galleryIndex !== pswp.currIndex) return;
      void this.mountVideoPlayer(content.element, slide.galleryIndex);
    });
    pswp.on('contentDestroy', ({ content }) => {
      const slide = content.data as GallerySlideData;
      if (slide.kind === 'video') this.destroyVideoPlayer(slide.galleryIndex);
    });
    pswp.on('destroy', () => {
      this.pswp = null;
      if (!this.destroying) this.close.emit();
    });

    this.pswp = pswp;
    pswp.init();
    this.activateVideo(initialIndex);
  }

  ngOnDestroy(): void {
    this.destroying = true;
    this.destroyVideoPlayers();
    this.pswp?.destroy();
    this.pswp = null;
  }

  goTo(index: number): void {
    this.pswp?.goTo(index);
  }

  dismiss(event: MouseEvent): void {
    event.stopPropagation();
    this.pswp?.close();
  }

  toggleChrome(): void {
    this.chromeVisible.update((visible) => !visible);
  }

  mediaUrl(media: AlbumImage): string {
    if (media.kind === 'video' && this.useNativeVideo)
      return this.nativeVideo.thumbnailUrl(media.src);
    return this.downloads.displayUrl(media);
  }

  async saveCurrent(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const media = this.current();
    if (!media || this.saving()) return;
    if (media.kind === 'image') {
      const key = this.downloads.key(media);
      this.saveToastKeys.add(key);
      this.downloads.start(media, this.threadId(), true);
      return;
    }
    await this.saveMedia(media, this.index());
  }

  loadCurrent(): void {
    const media = this.current();
    if (!media || media.kind !== 'image') return;
    this.downloads.start(media, this.threadId());
  }

  cancelCurrent(): void {
    const media = this.current();
    if (!media) return;
    // Cancellation is a neutral outcome. Drop the queued save notification before aborting so an
    // adapter's abort signal can never surface as either "save failed" or a later stale success toast.
    this.saveToastKeys.delete(this.downloads.key(media));
    this.downloads.cancel(media);
  }

  retryCurrentDownload(): void {
    const media = this.current();
    if (media) this.downloads.retry(media, this.threadId());
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
    this.retryVideoAt(this.index());
  }

  private retryVideoAt(i: number): void {
    const media = this.images()[i];
    if (!media || media.kind !== 'video') return;
    this.retryKeys.set(i, (this.retryKeys.get(i) ?? 0) + 1);
    this.destroyVideoPlayer(i);
    this.slides[i].html = this.videoSlideHtml(i);
    this.setVideoError(i, null);
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
    if (image.kind === 'file' || image.kind === 'audio') {
      return {
        html: `<div class="gv-unloaded-slide" aria-label="${escapeHtmlAttribute(image.name ?? 'file')}"><svg viewBox="0 0 24 24" width="72" height="72" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg></div>`,
        width: 280,
        height: 220,
        galleryIndex,
        kind: image.kind,
      };
    }
    if (image.kind === 'video') {
      return {
        html: this.videoSlideHtml(galleryIndex),
        width: Math.max(1, image.w),
        height: Math.max(1, image.h),
        galleryIndex,
        kind: image.kind,
      };
    }
    const gated = this.shouldGate(image);
    return {
      ...(gated
        ? { html: '<div class="gv-unloaded-slide" aria-hidden="true"></div>' }
        : { src: this.imageUrl(image, galleryIndex) }),
      width: Math.max(1, image.w),
      height: Math.max(1, image.h),
      alt: '',
      galleryIndex,
      kind: image.kind,
    };
  }

  private imageUrl(image: AlbumImage, index: number): string {
    const base = this.downloads.displayUrl(image);
    const retryKey = this.retryKeys.get(index) ?? 0;
    if (retryKey === 0 || /^(blob:|data:)/.test(base)) return base;
    return `${base}${base.includes('?') ? '&' : '?'}_r=${retryKey}`;
  }

  private defaultFilename(media: AlbumImage, index = this.index()): string {
    return `media-${media.msgId ?? index + 1}.${media.kind === 'video' ? 'mp4' : 'jpg'}`;
  }

  isMediaGated(media: AlbumImage): boolean {
    return media.kind === 'image' && this.shouldGate(media);
  }

  private shouldGate(media: AlbumImage): boolean {
    return (
      this.threshold.shouldDefer(media.size ?? 0) &&
      !this.downloads.isLoaded(media)
    );
  }

  private refreshDownloadedSlides(): void {
    if (!this.pswp) return;
    this.images().forEach((media, i) => {
      if (media.kind !== 'image' || !this.downloads.isLoaded(media)) return;
      const url = this.downloads.displayUrl(media);
      if (this.renderedBlobUrls.get(i) === url) return;
      this.renderedBlobUrls.set(i, url);
      const slide = this.slides[i];
      delete slide.html;
      slide.src = url;
      this.pswp?.refreshSlideContent(i);
    });
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

    const layer = this.videoErrorLayers.get(index);
    if (!layer) return;
    layer.hidden = error === null;
    if (!error) return;

    const message = layer.querySelector<HTMLElement>(
      '.gv-video-error__message',
    );
    const action = layer.querySelector<HTMLButtonElement>(
      '.gv-video-error__action',
    );
    if (message) {
      message.textContent = this.i18n.translate(
        error === 'network'
          ? 'gallery.videoNetworkFailed'
          : 'gallery.videoUnsupported',
      );
    }
    if (action) {
      action.textContent = this.i18n.translate(
        error === 'network' ? 'common.retry' : 'gallery.downloadVideo',
      );
    }
  }

  private videoSlideHtml(index: number): string {
    if (this.isAndroidApp) {
      const media = this.images()[index];
      const width = Math.max(1, media?.w ?? 1);
      const height = Math.max(1, media?.h ?? 1);
      const thumbnail = media ? this.nativeVideo.thumbnailUrl(media.src) : '';
      return `<div class="gv-native-video-shell" style="--gv-video-ratio:${width}/${height}">
        <div class="gv-slide-video gv-native-video-poster" data-gallery-index="${index}">
          ${thumbnail ? `<img class="gv-native-video-thumbnail" src="${thumbnail}" alt="">` : ''}
          <button type="button" class="gv-native-video-open" aria-label="${this.i18n.translate('gallery.openVideoAria')}">
            <span aria-hidden="true"></span>
          </button>
        </div>
      </div>`;
    }
    return `<div class="gv-slide-video" data-gallery-index="${index}"></div>`;
  }

  private async mountVideoPlayer(
    contentElement: HTMLElement | undefined,
    index: number,
  ): Promise<void> {
    const container = contentElement?.matches('.gv-slide-video')
      ? (contentElement as HTMLDivElement)
      : contentElement?.querySelector<HTMLDivElement>('.gv-slide-video');
    const media = this.images()[index];
    if (!container || media?.kind !== 'video') return;

    if (this.videoPlayers.has(index) || this.videoPlayerMounts.has(index))
      return;
    this.videoPlayerMounts.add(index);
    if (this.isAndroidApp) {
      container
        .querySelector<HTMLButtonElement>('.gv-native-video-open')
        ?.addEventListener('click', (event) => {
          event.stopPropagation();
          if (this.useNativeVideo) {
            void this.nativeVideo.open(media.src);
            return;
          }
          void this.nativeVideo.stream(media.src).then((stream) => {
            if (!stream || !container.isConnected) {
              this.setVideoError(index, 'network');
              return;
            }
            container.replaceChildren();
            void this.createVideoPlayer(container, media, index, stream);
          });
        });
      this.videoPlayerMounts.delete(index);
      return;
    }
    try {
      await this.createVideoPlayer(container, media, index, null);
    } finally {
      this.videoPlayerMounts.delete(index);
    }
  }

  private async createVideoPlayer(
    container: HTMLDivElement,
    media: AlbumImage,
    index: number,
    localStream: LocalVideoStream | null,
  ): Promise<void> {
    const { default: ArtplayerPlayer } = await import('artplayer');
    if (!container.isConnected || index !== this.index()) return;
    const setVideoGestureIsolation =
      this.prepareVideoGestureIsolation(container);

    const player = new ArtplayerPlayer({
      container,
      url: localStream?.streamUrl ?? this.imageUrl(media, index),
      // Old Android WebView otherwise injects an `android-webview-video-poster:` resource. Once the
      // video is CORS-enabled for canvas capture that private scheme fails CORS and emits a spurious
      // media error before the real localhost stream starts. An explicit inert poster avoids the probe.
      moreVideoAttr: localStream
        ? {
            crossOrigin: 'anonymous',
            poster:
              'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
          }
        : {},
      autoplay: index === this.index(),
      muted: false,
      playsInline: true,
      gesture: true,
      fastForward: true,
      lock: true,
      setting: true,
      playbackRate: true,
      pip:
        !this.compactVideoControls &&
        typeof document !== 'undefined' &&
        document.pictureInPictureEnabled === true,
      fullscreen: true,
      fullscreenWeb: !this.compactVideoControls,
      autoOrientation: true,
      mutex: true,
      backdrop: false,
      theme: '#5b8cff',
      lang: this.i18n.getActiveLang().toLowerCase().startsWith('zh')
        ? 'zh-cn'
        : 'en',
    });
    player.on('control', (visible: boolean) => {
      if (index === this.index() && !this.videoFullscreen()) {
        this.chromeVisible.set(visible);
      }
    });
    player.on('video:pause', () => {
      if (index === this.index() && !this.videoFullscreen()) {
        this.videoPlaying.set(false);
        this.chromeVisible.set(true);
      }
    });
    player.on('video:ended', () => {
      if (index === this.index()) this.videoPlaying.set(false);
    });
    const syncFullscreen = (active: boolean) => {
      if (index !== this.index()) return;
      setVideoGestureIsolation(active);
      this.videoFullscreen.set(active);
      this.chromeVisible.set(!active);
    };
    player.on('fullscreen', syncFullscreen);
    player.on('fullscreenWeb', syncFullscreen);
    this.videoPlayers.set(index, player);
    const errorLayer = this.createVideoErrorLayer(index);
    container.append(errorLayer);
    this.videoErrorLayers.set(index, errorLayer);

    let thumbnailRequested = false;
    const onPlayable = () => {
      this.setVideoError(index, null);
      if (index === this.index()) this.videoPlaying.set(true);
      if (!localStream || thumbnailRequested) return;
      thumbnailRequested = true;
      const capture = () =>
        void this.nativeVideo.captureThumbnail(
          player.video,
          localStream,
          media.src,
        );
      if ('requestVideoFrameCallback' in player.video) {
        player.video.requestVideoFrameCallback(() => capture());
      } else {
        setTimeout(capture, 100);
      }
    };
    player.on('video:loadeddata', () => this.setVideoError(index, null));
    player.on('video:playing', onPlayable);
    player.on('video:canplay', () => this.setVideoError(index, null));
    player.on('video:error', () => {
      const code = player.video.error?.code;
      console.warn(
        '[video-playback] media error',
        JSON.stringify({
          code: code ?? null,
          message: player.video.error?.message ?? '',
          readyState: player.video.readyState,
          networkState: player.video.networkState,
        }),
      );
      if (code === MediaError.MEDIA_ERR_ABORTED) return;
      if (code === MediaError.MEDIA_ERR_NETWORK)
        this.setVideoError(index, 'network');
      else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)
        this.setVideoError(index, 'unsupported');
    });
    if (index === this.index()) {
      void player.play().catch(() => {
        // Browsers may require one tap for audible autoplay; the play affordance stays visible.
      });
    }
  }

  private activateVideo(activeIndex: number): void {
    if (this.isAndroidApp) return;
    this.videoPlaying.set(false);
    for (const index of [...this.videoPlayers.keys()]) {
      if (index !== activeIndex) this.destroyVideoPlayer(index);
    }

    const player = this.videoPlayers.get(activeIndex);
    if (player) {
      void player.play().catch(() => {
        // Expected in browser engines that disallow audible autoplay.
      });
      return;
    }

    const media = this.images()[activeIndex];
    const contentElement = this.pswp?.currSlide?.content.element;
    if (media?.kind === 'video' && contentElement) {
      void this.mountVideoPlayer(contentElement, activeIndex);
    }
  }

  private destroyVideoPlayer(index: number): void {
    this.videoErrorLayers.delete(index);
    const player = this.videoPlayers.get(index);
    if (!player) return;
    if (index === this.index()) this.videoFullscreen.set(false);
    this.videoPlayers.delete(index);
    // `true` clears Artplayer's <video> element as well as its UI. This closes the media request and
    // releases decoder/buffer resources; the player is rebuilt on demand if the user returns.
    player.destroy(true);
  }

  /** Normal viewing keeps PhotoSwipe paging available over the video surface. Artplayer takes exclusive
   *  ownership only while it is fullscreen, where an outer-gallery gesture would be surprising. */
  private prepareVideoGestureIsolation(
    container: HTMLElement,
  ): (active: boolean) => void {
    let isolated = false;
    const stop = (event: Event) => {
      if (isolated) event.stopPropagation();
    };
    container.addEventListener('pointerdown', stop);
    container.addEventListener('pointermove', stop);
    container.addEventListener('pointerup', stop);
    container.addEventListener('pointercancel', stop);
    return (active: boolean) => {
      isolated = active;
    };
  }

  private createVideoErrorLayer(index: number): HTMLElement {
    const layer = document.createElement('div');
    layer.className = 'gv-video-error';
    layer.hidden = true;
    layer.setAttribute('role', 'alert');

    const icon = document.createElement('span');
    icon.className = 'gv-video-error__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';

    const message = document.createElement('p');
    message.className = 'gv-video-error__message';

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'gv-video-error__action';
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.videoErrors().get(index) === 'network') {
        this.retryVideoAt(index);
      } else {
        void this.saveVideo(index);
      }
    });

    layer.append(icon, message, action);
    return layer;
  }

  private async saveVideo(index: number): Promise<void> {
    const media = this.images()[index];
    if (media?.kind === 'video') await this.saveMedia(media, index);
  }

  private async saveMedia(media: AlbumImage, index: number): Promise<void> {
    try {
      await this.mediaSave.save({
        path: media.src,
        filename: media.name || this.defaultFilename(media, index),
        mimeType:
          media.kind === 'video'
            ? 'video/mp4'
            : media.kind === 'audio'
              ? 'audio/mpeg'
              : 'image/jpeg',
      });
      this.toast.info(this.i18n.translate('gallery.saved'));
    } catch (error) {
      console.error('[gallery] save failed:', error);
      this.toast.warn(this.i18n.translate('gallery.saveFailed'));
    }
  }

  private destroyVideoPlayers(): void {
    for (const index of [...this.videoPlayers.keys()]) {
      this.destroyVideoPlayer(index);
    }
  }

  private scrollCurrentThumbIntoView(): void {
    const current = this.thumbRail?.nativeElement.querySelector<HTMLElement>(
      `[data-index="${this.index()}"]`,
    );
    current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
