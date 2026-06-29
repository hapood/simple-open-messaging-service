import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

export type EmptyStateTone = 'default' | 'error';

/**
 * 通用空 / 加载 / 错误占位：图标（content projection）+ 标题 + 副标题 + 可选 CTA。
 * 样式提取自 friend-requests 的 .state-hint。图标槽不投影时自动隐藏（:empty）。
 * 投影进来的 SVG 带消费者自身的 encapsulation，尺寸由消费者在模板里自带。
 */
@Component({
  selector: 'app-empty-state',
  imports: [MatButtonModule],
  templateUrl: './empty-state.component.html',
  styleUrl: './empty-state.component.scss',
})
export class EmptyStateComponent {
  readonly title = input.required<string>()
  readonly subtitle = input('')
  /** error 变体：标题染 --app-danger */
  readonly tone = input<EmptyStateTone>('default')
  /** CTA 文案，非空才渲染按钮 */
  readonly ctaLabel = input('')
  readonly ctaClick = output<void>()
}
