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
  readonly displayQuote = computed(() => this.quote());
  readonly anchor = computed<HistoryAnchor | undefined>(() => {
    const quote = this.displayQuote();
    if (!quote || quote.kind !== 'jumpable') return undefined;
    return (
      quote.anchor ??
      (quote.seq && quote.seq > 0
        ? { kind: 'local', seq: quote.seq }
        : undefined)
    );
  });
  readonly thumbnail = computed(() => {
    const quote = this.displayQuote();
    if (!quote || quote.kind === 'unavailable') return '';
    return this.downloads.thumbnailUrl({
      src: quote.image ?? '',
    });
  });
  readonly avatarType = computed(() => {
    const quote = this.displayQuote();
    return quote &&
      quote.kind !== 'unavailable' &&
      quote.imageIdentity?.startsWith('!')
      ? UserAvatarType.GROUP
      : UserAvatarType.OTHER;
  });
}
