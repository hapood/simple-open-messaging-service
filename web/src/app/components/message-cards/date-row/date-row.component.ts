import { Component, input } from '@angular/core';
import type { ChatDateData } from '../chat-item';

/**
 * 日期分隔行（居中 pill）。
 *
 * 纵向留白走 padding 不走 margin（offsetHeight 测高不含 margin → 下方气泡会叠上来，
 * 见 vs-element-border-box 记忆）。
 */
@Component({
  selector: 'app-msg-date-row',
  standalone: true,
  template: `
    <div class="pg-date"><span>{{ data().label }}</span></div>
  `,
  styleUrl: './date-row.component.scss',
})
export class DateRowComponent {
  readonly data = input.required<ChatDateData>();
}
