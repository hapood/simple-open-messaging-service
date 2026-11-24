import {
  Component,
  computed,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { AlbumMedia, MediaMessageItem } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { QuoteBlockComponent } from '../quote-block/quote-block.component';
import type { HistoryAnchor } from '../../../services/history-anchor';
import { AvatarComponent } from '../../user-avatar/avatar.component';
import type { AvatarView } from '../../user-avatar/avatar-view';
import { messageSenderPresentation } from '../message-sender';
import { layoutAlbum } from './layout';
import { formatBytes } from '../file-meta.util';
import { AlbumMediaCellComponent } from './album-media-cell.component';

const GALLERY_CARD_W = 280;

/**
 * Unified media message row (IMAGE / VIDEO / AUDIO).
 *
 * Nested cells own image/video thumbnail presentation. The row owns album membership,
 * fixed geometry, message metadata and navigation; file groups use compact slots.
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
    AlbumMediaCellComponent,
  ],
  templateUrl: './media-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './media-row.component.scss',
})
export class MediaRowComponent {
  readonly senderView = input<AvatarView>();
  readonly data = input.required<MediaMessageItem>();
  readonly quoteJump = output<HistoryAnchor>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input<boolean>(false);

  readonly sender = messageSenderPresentation(
    this.data,
    this.isShowHead,
    this.senderView,
  );
  readonly side = this.sender.side;
  readonly showAvatar = this.sender.showAvatar;
  readonly showName = this.sender.showName;
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly openImage = output<{ images: AlbumMedia[]; index: number }>();

  private readonly displayedImages = computed(() => this.data().images);
  readonly galleryIcons = computed(() => {
    const items = this.data().images;
    const visible = items.length > 6 ? items.slice(0, 5) : items.slice(0, 6);
    const icons: Array<
      | { kind: AlbumMedia['kind']; media: AlbumMedia }
      | { kind: 'more'; label: string }
    > = visible.map((media) => ({ kind: media.kind, media }));
    if (items.length > 6) {
      const remaining = items.length - visible.length;
      icons.push({
        kind: 'more',
        label: remaining > 99 ? '…' : `+${remaining}`,
      });
    }
    return icons;
  });
  readonly galleryOpenIndex = computed(() => {
    const images = this.data().images;
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
    return this.layout().rects.map((rect, i) => {
      const m = imgs[i];
      const kind = m.kind;
      return {
        media: m,
        rect,
        kind,
        name: m.name,
        sizeText: formatBytes(m.size),
      };
    });
  });

  /** Detail navigation is independent of server readiness and thumbnail loading.
   * Playback controls consume their own events inside the audio surface. */
  onCellClick(index: number): void {
    this.openImage.emit({ images: this.displayedImages(), index });
  }

  onGalleryClick(): void {
    this.openImage.emit({
      images: this.data().images,
      index: this.galleryOpenIndex(),
    });
  }

  readonly isAudioOnly = computed(
    () =>
      this.data().images.length === 1 && this.data().images[0].kind === 'audio',
  );

  /** Media meta bar (EVERY media row — single OR album): media counts (images / videos / audios) on
   *  the left + the send time on the right. Replaces the prior single-only size bar and the prior
   *  cell-overlay timestamp (the time now lives here, not on the image). */
  readonly metaBar = computed(() => {
    const imgs = this.data().images;
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
}
