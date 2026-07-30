import {
  ChangeDetectorRef,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MEDIA_STATUS, type AlbumImage, type ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';
import { layoutAlbum } from './layout';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { assetUrl } from '../../../services/runtime';
import { formatBytes, formatDuration } from '../file-meta.util';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';
import { ImageDownloadService } from '../../../services/image-download.service';

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
    DateRowComponent,
    UserAvatarComponent,
    TranslocoPipe,
    MatProgressSpinnerModule,
    MatIconModule,
    AudioPlayerComponent,
  ],
  templateUrl: './media-row.component.html',
  styleUrl: './media-row.component.scss',
})
export class MediaRowComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly downloads = inject(ImageDownloadService);
  readonly UserAvatarType = UserAvatarType;
  /** Exposed for the template (status comparisons use MEDIA_STATUS.* — no bare literals). */
  readonly MEDIA_STATUS = MEDIA_STATUS;
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input<boolean>(false);
  /** Correlates an optimistic media row with its app-scoped upload task. Empty on persisted rows. */
  readonly clientMessageId = input('');

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);
  readonly statusTick = computed(
    () => this.data().isSelf && !!this.data().status,
  );
  readonly isSending = computed(
    () => this.data().isSelf && this.data().status === 'sending',
  );
  readonly isFailed = computed(
    () => this.data().isSelf && this.data().status === 'failed',
  );
  readonly retry = output<number>();
  readonly cancel = output<number>();
  readonly openImage = output<{ images: AlbumImage[]; index: number }>();

  constructor(private readonly thresholdSvc: MediaSizeThresholdService) {
    // Message rows are imperatively mounted outside ApplicationRef. Observe the app-scoped task store
    // explicitly so progress painted in the gallery/global header also repaints this detached row.
    effect(() => {
      this.downloads.tasks();
      queueMicrotask(() => this.render());
    });
  }

  private readonly layout = computed(() =>
    layoutAlbum(this.data().images ?? []),
  );
  readonly totalH = computed(() => this.layout().totalH);
  readonly containerW = computed(() => this.layout().containerW);
  readonly moreCount = computed(() => this.layout().moreCount);

  /** Per-cell render data. `kind` drives the inner content branch (background-image / <video> / placeholder). */
  readonly cells = computed(() => {
    const imgs = this.data().images ?? [];
    const moreIdx =
      this.layout().moreCount > 0 ? this.layout().rects.length - 1 : -1;
    const failed = this.unplayableVideos();
    const thr = this.threshold();
    this.downloads.tasks();
    // Read the service signal through isLoaded below. It is intentionally shared across row remounts.
    return this.layout().rects.map((rect, i) => {
      const m = imgs[i];
      const kind = m?.kind ?? 'image';
      const size = m?.size ?? 0;
      const mediaKey = this.mediaKey(m, i);
      const task = m ? this.downloads.task(m) : undefined;
      const gated =
        kind === 'image' &&
        thr > 0 &&
        size > thr &&
        !this.thresholdSvc.isLoaded(mediaKey) &&
        !task?.blobUrl;
      return {
        rect,
        kind,
        src: m ? this.downloads.displayUrl(m) : assetUrl(''),
        duration: m?.duration,
        isMore: i === moreIdx,
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

  /** The +N tile replaces the last visible thumbnail, so aggregate every represented media item from
   * that cell onward. Each file has equal weight; byte sizes deliberately do not skew the album rail. */
  readonly moreTransfer = computed(() => {
    this.downloads.tasks();
    const images = this.data().images ?? [];
    const shown = this.layout().rects.length;
    if (this.layout().moreCount === 0 || shown === 0)
      return { active: false, progress: 0, completed: 0, total: 0, failed: 0 };
    const hidden = images.slice(shown - 1);
    let completed = 0;
    let partial = 0;
    let failed = 0;
    let active = false;
    for (const media of hidden) {
      const task = this.downloads.task(media);
      if (!task) continue;
      if (
        task.status === 'loaded' ||
        task.status === 'saving' ||
        task.status === 'saved'
      ) {
        completed++;
        partial++;
      } else if (task.status === 'downloading') {
        active = true;
        partial += task.total > 0 ? Math.min(1, task.loaded / task.total) : 0;
      } else if (task.status === 'failed') {
        failed++;
      }
    }
    return {
      active: active || completed > 0 || failed > 0,
      progress: hidden.length > 0 ? (partial / hidden.length) * 100 : 0,
      completed,
      total: hidden.length,
      failed,
    };
  });

  /** Indices of video cells whose <video> failed to decode (unsupported codec) → gray placeholder. */
  readonly unplayableVideos = signal<Set<number>>(new Set());
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
  readonly threshold = computed(() => this.thresholdSvc.threshold());
  /** Cell click: images and videos open the singleton mixed-media viewer (after the optional image
   *  size gate). Audio owns its interaction inside AudioPlayerComponent. */
  onCellClick(i: number): void {
    const cell = this.cells()[i];
    if (cell.kind === 'video') {
      // Even a card whose first-frame probe failed must remain openable: the detail viewer gives the
      // user a precise playback error plus retry/download actions.
      if (cell.status === MEDIA_STATUS.READY)
        this.openImage.emit({ images: this.data().images ?? [], index: i });
      return;
    }
    if (cell.kind !== 'image') return;
    this.openImage.emit({ images: this.data().images ?? [], index: i });
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

  private mediaKey(media: AlbumImage | undefined, index: number): string {
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
    return { images, videos, audios, time: this.data().time };
  });

  readonly formatDuration = formatDuration;
}
