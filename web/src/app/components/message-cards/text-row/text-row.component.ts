import { Component, computed, input, output } from '@angular/core';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';

/**
 * 纯文本消息行（WhatsApp 风：头像 + 名字 + 气泡 + 尾尖 + 右下时间戳）。
 *
 * standalone + Emulated 封装。分组（头像/名字/圆角/组间留白）由 isShowHead/isGroupStart
 * input 驱动，渲染时一次成型。共享视觉规则见 _row-base.scss（@use）。
 *
 * dateLabel：createItem 工厂按跨日判定传入；非空时模板顶部渲染 date pill（date 已从数据源
 * 移出、改由前端派生，见 date-format.ts）。
 */
@Component({
  selector: 'app-msg-text-row',
  standalone: true,
  imports: [DateRowComponent, UserAvatarComponent],
  templateUrl: './text-row.component.html',
  styleUrl: './text-row.component.scss',
})
export class TextRowComponent {
  readonly UserAvatarType = UserAvatarType
  readonly data = input.required<ChatMsgData>();
  /** 组首（显头像 + 他方名字）/ 组内。 */
  readonly isShowHead = input(false);
  /** 换发送者的新组首（组间留白 padding-top）。 */
  readonly isGroupStart = input(false);
  /** 跨日 date 分隔文案（非空=本条是某天首条、上方显 date pill）；null=不显。 */
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
}
