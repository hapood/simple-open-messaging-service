import { Component, input } from '@angular/core';

/**
 * 品牌 logo 单一事实源：mark（蓝底白气泡 SVG）+ wordmark「SOMS」+ 可选 tagline。
 * 从 auth-brand 提取，供 auth 页品牌面板与 chat-pane 空态共用，避免两处 SVG 副本漂移。
 *
 * mark 底色硬编码 #2196f3（与 favicon 一致，是有意为之的品牌固定色，非主题变量）；
 * 文字色/字号通过 CSS 变量暴露（--bl-word / --bl-tag / --bl-*-color），落在品牌渐变面板
 * （auth-brand 白字）上的覆盖只需在宿主设这几个变量，无需 ::ng-deep。
 */
@Component({
  selector: 'app-brand-logo',
  imports: [],
  templateUrl: './brand-logo.component.html',
  styleUrl: './brand-logo.component.scss',
})
export class BrandLogoComponent {
  /** logo mark 的 px 尺寸 */
  readonly size = input(64)
  /** 是否显示「SOMS」文字 */
  readonly wordmark = input(true)
  /** wordmark 下方的副标题（纯文本） */
  readonly tagline = input('')
}
