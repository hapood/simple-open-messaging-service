import { Component, input } from '@angular/core';

/**
 * 日期分隔行（居中 pill）。
 *
 * 纯展示组件：接收已算好的 label 文案（date 不再是数据源的 CbItem，而是 createItem 工厂
 * 按跨日判定算出 label、由 msg 行模板条件渲染本组件）。纵向留白走 padding 不走 margin
 *（offsetHeight 测高不含 margin → 下方气泡会叠上来，见 cb-element-border-box 记忆）。
 */
@Component({
  selector: 'app-msg-date-row',
  standalone: true,
  template: `
    <div class="pg-date"><span>{{ label() }}</span></div>
  `,
  styleUrl: './date-row.component.scss',
})
export class DateRowComponent {
  readonly label = input.required<string>();
}
