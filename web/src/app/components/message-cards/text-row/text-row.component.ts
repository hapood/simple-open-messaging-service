import { Component, computed, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';

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

  /** The server keeps quote previews as one compact `author：body` string. Split only the first
   * separator so the author can form a clear visual header without changing the wire format. */
  readonly quotePreview = computed(() => {
    const preview = this.data().quote?.preview?.trim() ?? '';
    const separator = preview.search(/[：:]/);
    if (separator <= 0) return { author: '', body: preview };
    return {
      author: preview.slice(0, separator).trim(),
      body: preview.slice(separator + 1).trim(),
    };
  });
}
