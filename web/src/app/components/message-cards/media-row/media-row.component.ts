import { ChangeDetectorRef, Component, computed, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MEDIA_STATUS, type AlbumImage, type ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { layoutAlbum } from './layout';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { assetUrl } from '../../../services/runtime';
import { formatBytes, formatDuration } from '../file-meta.util';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';

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
  imports: [DateRowComponent, UserAvatarComponent, TranslocoPipe, MatProgressSpinnerModule, MatIconModule, AudioPlayerComponent],
  templateUrl: './media-row.component.html',
  styleUrl: './media-row.component.scss',
})
export class MediaRowComponent {
  private readonly cdr = inject(ChangeDetectorRef);
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
  readonly statusTick = computed(() => this.data().isSelf && !!this.data().status);
  readonly isSending = computed(() => this.data().isSelf && this.data().status === 'sending');
  readonly isFailed = computed(() => this.data().isSelf && this.data().status === 'failed');
  readonly retry = output<number>();
  readonly cancel = output<number>();
  readonly openImage = output<{ images: AlbumImage[]; index: number }>();

  constructor(private readonly thresholdSvc: MediaSizeThresholdService) {}

  private readonly layout = computed(() => layoutAlbum(this.data().images ?? []));
  readonly totalH = computed(() => this.layout().totalH);
  readonly containerW = computed(() => this.layout().containerW);
  readonly moreCount = computed(() => this.layout().moreCount);

  /** Per-cell render data. `kind` drives the inner content branch (background-image / <video> / placeholder). */
  readonly cells = computed(() => {
    const imgs = this.data().images ?? [];
    const moreIdx = this.layout().moreCount > 0 ? this.layout().rects.length - 1 : -1;
    const failed = this.unplayableVideos();
    const thr = this.threshold();
    const loading = this.loadingImages();
    const loadFailed = this.failedImages();
    // Read the service signal through isLoaded below. It is intentionally shared across row remounts.
    return this.layout().rects.map((rect, i) => {
      const m = imgs[i];
      const kind = m?.kind ?? 'image';
      const size = m?.size ?? 0;
      const mediaKey = this.mediaKey(m, i);
      return {
        rect,
        kind,
        src: assetUrl(m?.src ?? ''),
        duration: m?.duration,
        isMore: i === moreIdx,
        unplayable: kind === 'video' && failed.has(i),
        // Federated media localize status is message-level (all cells share it). Non-media defaults ready.
        status: this.data().mediaStatus ?? MEDIA_STATUS.READY,
        // Size-tiered placeholder: only IMAGE over threshold, not yet tapped-to-load. VIDEO/AUDIO are
        // unaffected (they are a gray cell / first-frame already).
        placeholder:
          kind === 'image' &&
          thr > 0 &&
          size > thr &&
          !this.thresholdSvc.isLoaded(mediaKey),
        loading: loading.has(mediaKey),
        loadFailed: loadFailed.has(mediaKey),
        showGate:
          kind === 'image' &&
          (loading.has(mediaKey) ||
            loadFailed.has(mediaKey) ||
            (thr > 0 && size > thr && !this.thresholdSvc.isLoaded(mediaKey))),
        sizeText: formatBytes(size),
      };
    });
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

  /** Size-tiered lazy load: IMAGE cells over the user threshold start as a "Tap to load" placeholder;
   *  the first click loads them (tracked here). Below threshold or already loaded → load immediately. */
  readonly threshold = computed(() => this.thresholdSvc.threshold());
  private readonly loadingImages = signal<ReadonlySet<string>>(new Set());
  private readonly failedImages = signal<ReadonlySet<string>>(new Set());
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
    if (cell.placeholder || cell.loadFailed) {
      this.loadImage(i);
      return;
    }
    this.openImage.emit({ images: this.data().images ?? [], index: i });
  }

  private loadImage(index: number): void {
    const media = this.data().images?.[index];
    if (!media) return;
    const key = this.mediaKey(media, index);
    if (this.loadingImages().has(key)) return;
    this.updateKeySet(this.failedImages, key, false);
    this.updateKeySet(this.loadingImages, key, true);
    // Grant rendering immediately so the real card <img> mounts underneath the loading gate. Its own
    // load/error events are the single source of truth; a detached `new Image()` can finish without the
    // dynamically-created row being refreshed, leaving the chat card gated even though the viewer works.
    this.thresholdSvc.markLoaded(key);
    // Message rows are imperatively created and not attached to ApplicationRef. Signal writes alone do
    // not repaint this detached view, so refresh now to mount the real <img> under the loading gate.
    this.render();
  }

  onImageLoad(index: number): void {
    const media = this.data().images?.[index];
    if (!media) return;
    const key = this.mediaKey(media, index);
    this.updateKeySet(this.loadingImages, key, false);
    this.updateKeySet(this.failedImages, key, false);
    this.thresholdSvc.markLoaded(key);
    this.render();
  }

  onImageError(index: number): void {
    const media = this.data().images?.[index];
    if (!media) return;
    const key = this.mediaKey(media, index);
    this.updateKeySet(this.loadingImages, key, false);
    this.updateKeySet(this.failedImages, key, true);
    this.render();
  }

  private render(): void {
    this.cdr.detectChanges();
  }

  private updateKeySet(
    target: { update(fn: (value: ReadonlySet<string>) => ReadonlySet<string>): void },
    key: string,
    present: boolean,
  ): void {
    target.update((current) => {
      if (current.has(key) === present) return current;
      const next = new Set(current);
      if (present) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  private mediaKey(media: AlbumImage | undefined, index: number): string {
    return `${media?.msgId ?? this.data().msgId}:${media?.src ?? ''}:${index}`;
  }

  readonly isAudioOnly = computed(
    () => this.data().images?.length === 1 && this.data().images?.[0]?.kind === 'audio',
  );

  /** Media meta bar (EVERY media row — single OR album): media counts (images / videos / audios) on
   *  the left + the send time on the right. Replaces the prior single-only size bar and the prior
   *  cell-overlay timestamp (the time now lives here, not on the image). */
  readonly metaBar = computed(() => {
    const imgs = this.data().images ?? [];
    let images = 0, videos = 0, audios = 0;
    for (const m of imgs) {
      if (m.kind === 'image') images++;
      else if (m.kind === 'video') videos++;
      else if (m.kind === 'audio') audios++;
    }
    return { images, videos, audios, time: this.data().time };
  });

  readonly formatDuration = formatDuration;
}
