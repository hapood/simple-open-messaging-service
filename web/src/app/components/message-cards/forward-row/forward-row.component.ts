import { Component, computed, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { parseForwardCard } from './forward-card';

@Component({
  selector: 'app-msg-forward-row',
  standalone: true,
  imports: [DateRowComponent, UserAvatarComponent, TranslocoPipe],
  templateUrl: './forward-row.component.html',
  styleUrl: './forward-row.component.scss',
})
export class ForwardRowComponent {
  readonly UserAvatarType = UserAvatarType;
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input(false);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(
    () =>
      this.isShowHead() &&
      this.data().isGroupConversation === true &&
      !this.data().isSelf,
  );
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
