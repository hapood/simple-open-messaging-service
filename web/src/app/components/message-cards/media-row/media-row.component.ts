import {
  ChangeDetectorRef,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MEDIA_STATUS, type AlbumMedia, type ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { QuoteBlockComponent } from '../quote-block/quote-block.component';
import type { HistoryAnchor } from '../../../services/history-anchor';
import { AvatarComponent } from '../../user-avatar/avatar.component';
import type { AvatarView } from '../../user-avatar/avatar-view';
import { messageSenderPresentation } from '../message-sender';
import { layoutAlbum } from './layout';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import {
  ANDROID_MEDIA3_ENABLED,
  assetUrl,
  isAndroid,
  isTauri,
} from '../../../services/runtime';
import { formatBytes, formatDuration } from '../file-meta.util';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';
import { ImageDownloadService } from '../../../services/image-download.service';
import { NativeVideoService } from '../../../services/native-video.service';

const GALLERY_CARD_W = 280;

/**
 * Unified media message row (IMAGE / VIDEO / AUDIO).
 *
 * Single media = media area + bottom meta bar; album (multi-cell) = pure grid (no meta bar).
 * Media area per kind: image→background-image, video→<video preload=metadata> first frame (decode error→
 * gray placeholder), audio→gray placeholder cell. Video/audio carry a centered ▶ + a bottom-left
 * duration badge overlay; only image cells are click-to-open-gallery (video/audio interaction is
 * deferred — onCellClick is a no-op for them).
 *
 * Core invariant preserved: every cell's height is fixed by layoutAlbum before render (px), so media
 * load/decode never changes height and the virtual-scroll anchor stays stable. The bubble width
 * follows layoutAlbum's containerW (single media narrows to the cell width; album = full baseW).
 */
@Component({
  selector: 'app-msg-media-row',
  standalone: true,
  imports: [
    QuoteBlockComponent,
    DateRowComponent,
    AvatarComponent,
    TranslocoPipe,
    MatProgressSpinnerModule,
    MatIconModule,
    AudioPlayerComponent,
  ],
  templateUrl: './media-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './media-row.component.scss',
})
export class MediaRowComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly downloads = inject(ImageDownloadService);
  private readonly nativeVideo = inject(NativeVideoService);
  readonly isAndroidApp = isTauri() && isAndroid();
  readonly useNativeVideo = this.isAndroidApp && ANDROID_MEDIA3_ENABLED;
  readonly senderView = input<AvatarView>();
  /** Exposed for the template (status comparisons use MEDIA_STATUS.* — no bare literals). */
  readonly MEDIA_STATUS = MEDIA_STATUS;
  readonly data = input.required<ChatMsgData>();
  readonly quoteJump = output<HistoryAnchor>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input<boolean>(false);
  /** Correlates an optimistic media row with its app-scoped upload task. Empty on persisted rows. */
  readonly clientMessageId = input('');

  readonly sender = messageSenderPresentation(
    this.data,
    this.isShowHead,
    this.senderView,
  );
  readonly side = this.sender.side;
  readonly showAvatar = this.sender.showAvatar;
  readonly showName = this.sender.showName;
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly statusTick = computed(
    () => this.data().isSelf && !!this.data().status,
  );
  readonly isSending = computed(
    () => this.data().isSelf && this.data().status === 'sending',
  );
  readonly isFailed = computed(
    () => this.data().isSelf && this.data().status === 'failed',
  );
  /** Federated media status defaults to ready on both the wire and persisted historical rows. */
  readonly mediaStatus = computed(
    () => this.data().mediaStatus ?? MEDIA_STATUS.READY,
  );
  readonly retry = output<number>();
  readonly cancel = output<number>();
  readonly openImage = output<{ images: AlbumMedia[]; index: number }>();

  constructor(private readonly thresholdSvc: MediaSizeThresholdService) {
    // Message rows are imperatively mounted outside ApplicationRef. Observe the app-scoped task store
    // explicitly so progress painted in the gallery/global header also repaints this detached row.
    effect(() => {
      this.downloads.tasks();
      this.downloads.thumbnailVersion();
      queueMicrotask(() => this.render());
    });
  }

  private readonly displayedImages = computed(() => {
    const images = this.data().images ?? [];
    if (this.data().contentType !== 'GALLERY') return images;
    // Prefer the first image as the group cover; a file-only group falls back to its first file icon.
    // Oversized images remain this chosen cover but the size gate below paints the default image icon.
    const cover =
      images.find((image) => image.kind === 'image') ??
      images.find((image) => image.kind === 'file') ??
      images[0];
    return cover ? [cover] : [];
  });
  readonly galleryIcons = computed(() => {
    const items = this.data().images ?? [];
    this.downloads.tasks();
    this.downloads.thumbnailVersion();
    const visible = items.length > 6 ? items.slice(0, 5) : items.slice(0, 6);
    const icons: Array<{
      kind: AlbumMedia['kind'] | 'more';
      index: number;
      localPreview: boolean;
      thumbnail: string;
    }> = visible.map((item, index) => {
      const task = this.downloads.task(item);
      const localPreview =
        item.src.startsWith('blob:') || item.src.startsWith('data:');
      const oversized =
        item.kind === 'image' &&
        !localPreview &&
        this.thresholdSvc.shouldDefer(item.size ?? 0) &&
        !this.thresholdSvc.isLoaded(this.mediaKey(item, index)) &&
        !task?.blobUrl;
      return {
        kind: item.kind,
        index,
        localPreview,
        thumbnail:
          item.kind !== 'image'
            ? ''
            : oversized
              ? this.downloads.cachedThumbnailUrl(item)
              : this.downloads.thumbnailUrl(item),
      };
    });
    if (items.length > 6)
      icons.push({
        kind: 'more',
        index: 5,
        localPreview: false,
        thumbnail: '',
      });
    return icons;
  });
  readonly galleryOpenIndex = computed(() => {
    const images = this.data().images ?? [];
    const firstImage = images.findIndex((item) => item.kind === 'image');
    return firstImage >= 0 ? firstImage : 0;
  });
  private readonly layout = computed(() => layoutAlbum(this.displayedImages()));
  readonly totalH = computed(() => this.layout().totalH);
  readonly containerW = computed(() =>
    this.data().contentType === 'GALLERY'
      ? GALLERY_CARD_W
      : this.layout().containerW,
  );

  /** Per-cell render data. `kind` drives the inner content branch (background-image / <video> / placeholder). */
  readonly cells = computed(() => {
    const imgs = this.displayedImages();
    const failed = this.unplayableVideos();
    this.downloads.tasks();
    // Read the service signal through isLoaded below. It is intentionally shared across row remounts.
    return this.layout().rects.map((rect, i) => {
      const m = imgs[i];
      const kind = m?.kind ?? 'image';
      const size = m?.size ?? 0;
      const mediaKey = this.mediaKey(m, i);
      const task = m ? this.downloads.task(m) : undefined;
      const thumbnail =
        kind === 'video' && m ? this.nativeVideo.thumbnailUrl(m.src) : '';
      const gated =
        kind === 'image' &&
        this.thresholdSvc.shouldDefer(size) &&
        !this.thresholdSvc.isLoaded(mediaKey) &&
        !task?.blobUrl;
      return {
        rect,
        kind,
        src:
          m && kind === 'image'
            ? this.downloads.thumbnailUrl(m)
            : m
              ? this.downloads.displayUrl(m)
              : assetUrl(''),
        thumbnail,
        duration: m?.duration,
        name: m?.name,
        unplayable: kind === 'video' && failed.has(i),
        // Federated media localize status is message-level (all cells share it). Non-media defaults ready.
        status: this.data().mediaStatus ?? MEDIA_STATUS.READY,
        // Size-tiered placeholder: only IMAGE over threshold, not yet tapped-to-load. VIDEO/AUDIO are
        // unaffected (they are a gray cell / first-frame already).
        placeholder: gated,
        showGate: gated,
        transferStatus: task?.status,
        transferProgress:
          task && task.total > 0
            ? Math.min(100, (task.loaded / task.total) * 100)
            : null,
        sizeText: formatBytes(size),
      };
    });
  });

  /** Indices of video cells whose <video> failed to decode (unsupported codec) → gray placeholder. */
  readonly unplayableVideos = signal<Set<number>>(new Set());
  readonly loadedVideoFrames = signal<Set<number>>(new Set());
  onVideoLoaded(i: number): void {
    this.loadedVideoFrames.update((current) => {
      if (current.has(i)) return current;
      const next = new Set(current);
      next.add(i);
      return next;
    });
    this.render();
  }

  onThumbnailLoad(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    image.hidden = false;
  }

  onThumbnailError(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    image.hidden = true;
    console.warn('[video-thumbnail] message card load failed');
  }

  onGalleryThumbnailLoad(
    event: Event,
    index: number,
    markLoaded: boolean,
  ): void {
    (event.currentTarget as HTMLImageElement).style.opacity = '1';
    if (markLoaded) this.onImageLoad(index);
  }

  onGalleryThumbnailError(event: Event): void {
    (event.currentTarget as HTMLImageElement).style.opacity = '0';
  }
  onVideoError(i: number): void {
    this.unplayableVideos.update((s) => {
      if (s.has(i)) return s;
      const next = new Set(s);
      next.add(i);
      return next;
    });
    this.render();
  }

  /** Size-tiered lazy load: large images remain an inert card placeholder. Clicking always opens the
   * gallery; only that surface starts/cancels the shared download task. */
  /** Cell click: images and videos open the singleton mixed-media viewer (after the optional image
   *  size gate). Audio owns its interaction inside AudioPlayerComponent. */
  async onCellClick(i: number): Promise<void> {
    const cell = this.cells()[i];
    if (cell.kind === 'file') {
      const all = this.data().images ?? [];
      const displayed = this.displayedImages()[i];
      this.openImage.emit({
        images: all,
        index: Math.max(0, all.indexOf(displayed)),
      });
      return;
    }
    if (cell.kind === 'video') {
      // Even a card whose first-frame probe failed must remain openable: the detail viewer gives the
      // user a precise playback error plus retry/download actions.
      const media = this.data().images?.[i];
      if (
        cell.status === MEDIA_STATUS.READY &&
        media &&
        (await this.nativeVideo.open(media.src))
      )
        return;
      if (cell.status === MEDIA_STATUS.READY)
        this.openImage.emit({ images: this.data().images ?? [], index: i });
      return;
    }
    if (cell.kind !== 'image') return;
    const all = this.data().images ?? [];
    const displayed = this.displayedImages()[i];
    this.openImage.emit({
      images: all,
      index: Math.max(0, all.indexOf(displayed)),
    });
  }

  onGalleryClick(): void {
    this.openImage.emit({
      images: this.data().images ?? [],
      index: this.galleryOpenIndex(),
    });
  }

  onImageLoad(index: number): void {
    const media = this.data().images?.[index];
    if (!media) return;
    const key = this.mediaKey(media, index);
    this.thresholdSvc.markLoaded(key);
    this.render();
  }

  onImageError(index: number): void {
    const media = this.data().images?.[index];
    if (!media) return;
    const key = this.mediaKey(media, index);
    this.render();
  }

  private render(): void {
    this.cdr.detectChanges();
  }

  private mediaKey(media: AlbumMedia | undefined, index: number): string {
    return `${media?.msgId ?? this.data().msgId}:${media?.src ?? ''}:${index}`;
  }

  readonly isAudioOnly = computed(
    () =>
      this.data().images?.length === 1 &&
      this.data().images?.[0]?.kind === 'audio',
  );

  /** Media meta bar (EVERY media row — single OR album): media counts (images / videos / audios) on
   *  the left + the send time on the right. Replaces the prior single-only size bar and the prior
   *  cell-overlay timestamp (the time now lives here, not on the image). */
  readonly metaBar = computed(() => {
    const imgs = this.data().images ?? [];
    let images = 0,
      videos = 0,
      audios = 0;
    for (const m of imgs) {
      if (m.kind === 'image') images++;
      else if (m.kind === 'video') videos++;
      else if (m.kind === 'audio') audios++;
    }
    return {
      images,
      videos,
      audios,
      files: imgs.length,
      time: this.data().time,
    };
  });

  readonly formatDuration = formatDuration;
}
