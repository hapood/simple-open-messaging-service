import {
  Component,
  computed,
  inject,
  input,
  output,
  ChangeDetectionStrategy,
  effect,
  signal,
  Injector,
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
import { openExternalUrl } from '../../../services/runtime';
import { QuoteResolutionService } from '../../../services/quote-resolution.service';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './text-row.component.scss',
})
export class TextRowComponent {
  private readonly injector = inject(Injector);
  private readonly resolvedQuote = signal<{
    key: string;
    quote: NonNullable<ChatMsgData['quote']>;
  } | null>(null);

  constructor() {
    effect((onCleanup) => {
      const data = this.data();
      if (
        !data.threadId ||
        data.quote?.status !== 'PENDING' ||
        data.quote.unavailable
      )
        return;
      const key = `${data.threadId}:${data.msgId}`;
      const sub = this.injector
        .get(QuoteResolutionService)
        .resolve({ threadId: data.threadId, messageSeq: data.msgId })
        .subscribe({
          next: (quote) =>
            this.resolvedQuote.set({
              key,
              quote: {
                ...quote,
                contentType: quote.contentType as ChatMsgData['contentType'],
              },
            }),
          error: () => {}, // Keep pending state; another mount or reconnect may retry.
        });
      onCleanup(() => sub.unsubscribe());
    });
  }
  private readonly downloads = inject(ImageDownloadService);
  private readonly mediaThreshold = inject(MediaSizeThresholdService);
  private readonly linkCards = inject(LinkCardService);
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
  readonly showName = computed(
    () =>
      this.isShowHead() &&
      this.data().isGroupConversation === true &&
      !this.data().isSelf,
  );

  quoteAvatarType(identity: string | undefined): UserAvatarType {
    return identity?.startsWith('!')
      ? UserAvatarType.GROUP
      : UserAvatarType.OTHER;
  }
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

  /** Keep the URL as a real anchor for accessibility/copying, but route activation through the
   * shared runtime helper so Tauri opens the system browser and web opens a noopener tab. */
  async openLink(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
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
    return (
      quote.contentType === 'IMAGE' &&
      this.mediaThreshold.shouldDefer(quote.imageSize ?? 0)
    );
  }

  readonly displayQuote = computed(() => {
    const data = this.data();
    const resolved = this.resolvedQuote();
    const quote = data.quote?.unavailable
      ? data.quote
      : resolved?.key === `${data.threadId}:${data.msgId}`
        ? resolved.quote
        : data.quote;
    return quote?.unavailable
      ? { seq: quote.seq, unavailable: true }
      : quote?.status
        ? { seq: quote.seq, status: quote.status }
        : quote;
  });

  readonly quotePreview = computed(() => {
    const quote = this.displayQuote();
    return {
      author: quote?.author ?? '',
      body: quote?.body ?? '',
      isFileSet: quote?.contentType === 'GALLERY',
    };
  });
}
