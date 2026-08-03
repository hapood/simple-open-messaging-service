import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';
import { ImageDownloadService } from '../../../services/image-download.service';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';
import { LinkCardService } from '../../../services/link-card.service';
import { PopupType, RouteService } from '../../../services/route.service';
import { openExternalUrl } from '../../../services/runtime';

/**
 * Plain-text message row (WhatsApp style: avatar + name + bubble + tail + bottom-right timestamp).
 *
 * standalone + Emulated encapsulation. Grouping (avatar/name/rounded corners/inter-group spacing) is driven
 * by the isShowHead/isGroupStart inputs and finalized in one pass at render time. Shared visual rules live in
 * _row-base.scss (@use).
 *
 * showDate: the createItem factory passes a per-day show/hide flag (the date label text itself is computed by
 * DateRowComponent from the timestamp + active language); when true, a date pill renders at the top.
 */
@Component({
  selector: 'app-msg-text-row',
  standalone: true,
  imports: [DateRowComponent, UserAvatarComponent, TranslocoPipe],
  templateUrl: './text-row.component.html',
  styleUrl: './text-row.component.scss',
})
export class TextRowComponent {
  private readonly downloads = inject(ImageDownloadService);
  private readonly mediaThreshold = inject(MediaSizeThresholdService);
  private readonly linkCards = inject(LinkCardService);
  private readonly route = inject(RouteService);
  readonly UserAvatarType = UserAvatarType;
  readonly data = input.required<ChatMsgData>();
  /** Group head (shows avatar + other party's name) / mid-group. */
  readonly isShowHead = input(false);
  /** New group head on a sender change (inter-group padding-top). */
  readonly isGroupStart = input(false);
  /** Whether a date-separator pill should render above this row (it is the first message of its day). */
  readonly showDate = input<boolean>(false);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);
  /** Render a status tick (clock/check/retry) only for self-sent messages that carry a delivery status. */
  readonly statusTick = computed(
    () => this.data().isSelf && !!this.data().status,
  );
  /** Dim the bubble while a self message is still in flight (status === 'sending'); clears on confirm. */
  readonly isSending = computed(
    () => this.data().isSelf && this.data().status === 'sending',
  );
  /** Whether this row shows the failed retry affordance (drives the click binding + a11y on the status span). */
  readonly isFailed = computed(
    () => this.data().isSelf && this.data().status === 'failed',
  );
  /** Emitted (with the numeric msgId) when the user clicks the failed retry glyph; the parent re-sends by
   *  clientMessageId (the emitted value is a click signal — createMsgCbElement maps it to item.clientMessageId). */
  readonly retry = output<number>();
  readonly cancel = output<number>();
  readonly quoteJump = output<number>();
  readonly linkCard = computed(() =>
    this.data().contentType === 'PURE_TEXT'
      ? this.linkCards.matchFirst(this.data().text)
      : null,
  );
  readonly faviconUrl = signal<string | null>(null);
  readonly faviconLoading = signal(false);
  readonly linkTextParts = computed(() => {
    const card = this.linkCard();
    const text = this.data().text;
    if (!card) return null;
    return {
      before: text.slice(0, card.start),
      url: text.slice(card.start, card.end),
      after: text.slice(card.end),
    };
  });

  constructor() {
    effect((onCleanup) => {
      const card = this.linkCard();
      this.faviconUrl.set(null);
      this.faviconLoading.set(!!card);
      if (!card) return;
      let current = true;
      void this.linkCards.faviconUrl(card.rule.id).then((url) => {
        if (!current) return;
        this.faviconUrl.set(url);
        this.faviconLoading.set(false);
      });
      onCleanup(() => {
        current = false;
      });
    });
  }

  showOriginal(): void {
    const card = this.linkCard();
    if (card)
      this.route.popupDlg(PopupType.LINK_ORIGINAL, {
        text: this.data().text,
        url: card.url,
      });
  }

  async openLink(): Promise<void> {
    const card = this.linkCard();
    if (card) await openExternalUrl(card.url);
  }

  replyImageSrc(quote: NonNullable<ChatMsgData['quote']>): string {
    return this.downloads.thumbnailUrl({
      msgId: quote.seq,
      src: quote.image ?? '',
    });
  }

  isReplyImageGated(quote: NonNullable<ChatMsgData['quote']>): boolean {
    const threshold = this.mediaThreshold.threshold();
    return (
      quote.contentType === 'IMAGE' &&
      threshold > 0 &&
      (quote.imageSize ?? 0) > threshold
    );
  }

  readonly quotePreview = computed(() => {
    const quote = this.data().quote;
    return {
      author: quote?.author ?? '',
      body: quote?.body ?? '',
    };
  });
}
