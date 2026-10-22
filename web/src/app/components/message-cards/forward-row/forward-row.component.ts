import {
  Component,
  computed,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { AvatarComponent } from '../../user-avatar/avatar.component';
import type { AvatarView } from '../../user-avatar/avatar-view';
import { messageSenderPresentation } from '../message-sender';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { QuoteBlockComponent } from '../quote-block/quote-block.component';
import type { HistoryAnchor } from '../../../services/history-anchor';
import { parseForwardCard } from './forward-card';

@Component({
  selector: 'app-msg-forward-row',
  standalone: true,
  imports: [
    DateRowComponent,
    AvatarComponent,
    TranslocoPipe,
    QuoteBlockComponent,
  ],
  templateUrl: './forward-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './forward-row.component.scss',
})
export class ForwardRowComponent {
  readonly senderView = input<AvatarView>();
  readonly data = input.required<ChatMsgData>();
  readonly quoteJump = output<HistoryAnchor>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input(false);

  readonly sender = messageSenderPresentation(
    this.data,
    this.isShowHead,
    this.senderView,
  );
  readonly side = this.sender.side;
  readonly showAvatar = this.sender.showAvatar;
  readonly showName = this.sender.showName;
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly card = computed(() => parseForwardCard(this.data().text));
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
}
