import { Component, computed, input } from '@angular/core';
import type { ChatMsgData } from '../chat-item';

/**
 * 纯文本消息行（WhatsApp 风：头像 + 名字 + 气泡 + 尾尖 + 右下时间戳）。
 *
 * standalone + Emulated 封装。分组（头像/名字/圆角/组间留白）由 isShowHead/isGroupStart
 * input 驱动，渲染时一次成型。共享视觉规则见 _row-base.scss（@use）。
 */
@Component({
  selector: 'app-msg-text-row',
  standalone: true,
  templateUrl: './text-row.component.html',
  styleUrl: './text-row.component.scss',
})
export class TextRowComponent {
  readonly data = input.required<ChatMsgData>();
  /** 组首（显头像 + 他方名字）/ 组内。 */
  readonly isShowHead = input(false);
  /** 换发送者的新组首（组间留白 padding-top）。 */
  readonly isGroupStart = input(false);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);
}
