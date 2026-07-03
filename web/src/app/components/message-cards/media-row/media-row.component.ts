import { Component, computed, input, output } from '@angular/core';
import type { AlbumImage, ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { layoutAlbum } from './layout';

/**
 * Image album message row.
 *
 * Core: each cell is a div with a fixed px height + background-image (no <img> created); the height is fully
 * determined by layoutAlbum before render, so image load/decode never changes a cell's height and the virtual-scroll
 * anchor stays stable. Cells are positioned absolute using layoutAlbum's {xPct, yPx, wPct, hPx} inline values.
 *
 * dateLabel: passed in by the createItem factory based on the day-change check; when non-null, a date pill is
 * rendered at the top of the template.
 */
@Component({
  selector: 'app-msg-media-row',
  standalone: true,
  imports: [DateRowComponent, UserAvatarComponent],
  templateUrl: './media-row.component.html',
  styleUrl: './media-row.component.scss',
})
export class MediaRowComponent {
  readonly UserAvatarType = UserAvatarType
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  /** Day-change date-separator label (non-null = this row is the first of a given day → show a date pill above it); null = hide. */
  readonly dateLabel = input<string | null>(null);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);
  /** Render a status tick (clock/check/retry) only for self-sent messages that carry a delivery status. */
  readonly statusTick = computed(() => this.data().isSelf && !!this.data().status);
  /** Dim the bubble while a self message is still in flight (status === 'sending'); clears on confirm. */
  readonly isSending = computed(() => this.data().isSelf && this.data().status === 'sending');
  /** Whether this row shows the failed retry affordance (drives the click binding + a11y on the status span). */
  readonly isFailed = computed(() => this.data().isSelf && this.data().status === 'failed');
  /** Emitted (with the msgId) when the user clicks the failed retry glyph; the parent re-sends. */
  readonly retry = output<string>();
  /** Emitted when the user clicks an image cell — opens the gallery viewer at that image. Carries the album's full image
   *  list (current at click time, reflecting any absorb) + the clicked cell's index, so the viewer opens on the exact
   *  image the user clicked and can navigate the whole album. */
  readonly openImage = output<{ images: AlbumImage[]; index: number }>();

  private readonly layout = computed(() => layoutAlbum(this.data().images ?? []));
  readonly totalH = computed(() => this.layout().totalH);
  readonly moreCount = computed(() => this.layout().moreCount);
  /** Per-cell render data: rect (positioning) + src (background image). When there are more than 6 images, the last cell carries the moreCount badge. */
  readonly cells = computed(() => {
    const imgs = this.data().images ?? [];
    const moreIdx = this.layout().moreCount > 0 ? this.layout().rects.length - 1 : -1;
    return this.layout().rects.map((rect, i) => ({
      rect,
      src: imgs[i]?.src ?? '',
      isMore: i === moreIdx,
    }));
  });
}
