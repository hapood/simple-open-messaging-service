import { Component, computed, input, signal, effect } from '@angular/core';
import { UserAvatarType } from './model'

/**
 * 首字母头像（业界最佳实践配色）。
 *
 * 占位 SVG 已移除——改为取名字首字符居中显示，底色：
 *  · SELF：固定品牌绿（呼应 self 气泡，一眼可辨「自己」）。
 *  · OTHER / GROUP：基于名字哈希的确定性调色板（同一对象颜色稳定、不同对象易区分，
 *    对标 Telegram / Google Messages / Slack）。调色板取 Material 深色阶，与白字对比达 WCAG AA。
 *
 * 方圆角（微信式，rx=20% → 40px 容器下 8px，与聊天内 .pg-avatar 一致）+ SVG viewBox：
 * 字号在 viewBox 内固定、随容器自动缩放（44~56px 列表/抽屉通吃），不依赖父容器尺寸或
 * 裁剪——各调用点零布局改动（nav-drawer/icon-rail 容器须去掉强制圆形的 overflow/border-radius）。
 */
const SELF_COLOR = '#25d366';
const PALETTE = [
  '#E53935', '#D81B60', '#8E24AA', '#5E35B1',
  '#3949AB', '#1E88E5', '#039BE5', '#00ACC1',
  '#00897B', '#43A047', '#6D4C41', '#546E7A',
];

@Component({
    selector: 'app-user-avatar',
    imports: [],
    templateUrl: './user-avatar.component.html',
    styleUrl: './user-avatar.component.scss'
})

export class UserAvatarComponent {
  readonly type = input<UserAvatarType>(UserAvatarType.OTHER)
  readonly name = input<string>('')
  /** 真实头像图 URL（可选）。有值且加载成功 → 显示图片；否则回退首字母。 */
  readonly src = input<string | undefined | null>(undefined)
  readonly UserAvatarType = UserAvatarType

  /** 图片加载失败（损坏/404）→ 回退首字母。src 变化时重置，以重试新图。 */
  readonly imgFailed = signal(false)

  constructor() {
    effect(() => {
      this.src()
      this.imgFailed.set(false)
    }, { allowSignalWrites: true })
  }

  /** 是否渲染真实图片（有 src 且未失败）。 */
  readonly showImage = computed(() => !!this.src() && !this.imgFailed())

  /** 首字符（中文取首字、英文取首字母大写）；空名 fallback '?'。 */
  readonly initial = computed(() => {
    const n = (this.name() ?? '').trim()
    return n.length > 0 ? n.charAt(0).toUpperCase() : '?'
  })

  /** 底色：SELF 品牌绿；其余按名字哈希落到调色板（确定性，同名同色）。 */
  readonly bg = computed(() => {
    if (this.type() === UserAvatarType.SELF) return SELF_COLOR
    const n = (this.name() ?? '').trim() || '?'
    let h = 0
    for (let i = 0; i < n.length; i++) h = (Math.imul(h, 31) + n.charCodeAt(i)) | 0
    return PALETTE[Math.abs(h) % PALETTE.length]
  })
}

export { UserAvatarType } from './model'
