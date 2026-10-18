import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import type { HistoryAnchor } from '../../../services/history-anchor';
import { ImageDownloadService } from '../../../services/image-download.service';
import { MediaSizeThresholdService } from '../../../services/media-size-threshold.service';
import { SnapshotAvatarComponent } from '../../user-avatar/snapshot-avatar.component';
import { UserAvatarType } from '../../user-avatar/model';

/** Presentation-only reply context shared by text and attachment cards. */
@Component({
  selector: 'app-msg-quote-block',
  standalone: true,
  imports: [NgTemplateOutlet, TranslocoPipe, SnapshotAvatarComponent],
  templateUrl: './quote-block.component.html',
  styleUrl: './quote-block.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.quote-self]': 'isSelf()' },
})
export class QuoteBlockComponent {
  readonly quote = input<ChatMsgData['quote']>();
  readonly isSelf = input(false);
  readonly quoteJump = output<HistoryAnchor>();
  private readonly downloads = inject(ImageDownloadService);
  private readonly threshold = inject(MediaSizeThresholdService);
  readonly displayQuote = computed(() => {
    const quote = this.quote();
    return quote?.status ? { seq: quote.seq, status: quote.status } : quote;
  });
  readonly anchor = computed<HistoryAnchor | undefined>(() => {
    const quote = this.displayQuote();
    if (!quote || quote.status) return undefined;
    return (
      quote.anchor ??
      (quote.seq && quote.seq > 0
        ? { kind: 'local', seq: quote.seq }
        : undefined)
    );
  });
  readonly thumbnail = computed(() =>
    this.downloads.thumbnailUrl({
      msgId: this.displayQuote()?.seq,
      src: this.displayQuote()?.image ?? '',
    }),
  );
  readonly gated = computed(
    () =>
      this.displayQuote()?.contentType === 'IMAGE' &&
      this.threshold.shouldDefer(this.displayQuote()?.imageSize ?? 0),
  );
  readonly avatarType = computed(() =>
    this.displayQuote()?.imageIdentity?.startsWith('!')
      ? UserAvatarType.GROUP
      : UserAvatarType.OTHER,
  );
}
