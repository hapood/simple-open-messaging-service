import { Component, computed, input, signal, effect, inject, DestroyRef } from '@angular/core';
import { UserAvatarType } from './model'
import { assetUrl } from '../../services/runtime'
import { AvatarRepository } from '../../services/avatar-cache.service'

/**
 * 首字母头像（业界最佳实践配色）。
 *
 * 占位 SVG 已移除——改为取名字首字符居中显示，底色：
 *  · SELF：固定品牌绿（呼应 self 气泡，一眼可辨「自己」）。
 *  · OTHER / GROUP：基于名字哈希的确定性调色板（同一对象颜色稳定、不同对象易区分，
 *    对标 Telegram / Google Messages / Slack）。调色板取 Material 深色阶，与白字对比达 WCAG AA。
 *
 * 方圆角（微信式，rx=20% → 40px 容器下 8px，与聊天内 .msg-avatar 一致）+ SVG viewBox：
 * 字号在 viewBox 内固定、随容器自动缩放（44~56px 列表/抽屉通吃），不依赖父容器尺寸或
 * 裁剪——各调用点零布局改动（nav-drawer/icon-rail 容器须去掉强制圆形的 overflow/border-radius）。
 *
 * Avatar bytes are read ONLY from the DB layer ({@link AvatarRepository} → IndexedDB), keyed by stable
 * identity (`identityId` + `type`), never by URL. On a cache miss the repository fetches + caches; on a
 * hit the bytes come straight from IDB. A local preview (`blob:`/`data:`/absolute `src`) passes through
 * unchanged (new-group / edit-profile in-progress uploads).
 */
const SELF_COLOR = '#25d366';
const PALETTE = [
  '#E53935', '#D81B60', '#8E24AA', '#5E35B1',
  '#3949AB', '#1E88E5', '#039BE5', '#00ACC1',
  '#00897B', '#43A043', '#6D4C41', '#546E7A',
];

@Component({
    selector: 'app-user-avatar',
    imports: [],
    templateUrl: './user-avatar.component.html',
    styleUrl: './user-avatar.component.scss'
})

export class UserAvatarComponent {
  private readonly avatarRepo = inject(AvatarRepository);

  readonly type = input<UserAvatarType>(UserAvatarType.OTHER)
  readonly name = input<string>('')
  /** 真实头像图 URL（可选）。A server path (`/uploads/...`) is read from the DB by {@link identityId};
   *  a local preview (`blob:`/`data:`/absolute) passes through directly. Empty → 首字母 fallback. */
  readonly src = input<string | undefined | null>(undefined)
  /** Stable identity of the user/group this avatar depicts — the IDB cache key (combined with {@link
   *  type}: GROUP → `g<id>`, else `u<id>`). Usually the numeric id; for a group known only by its
   *  `!account` (an invite card) the account string is accepted too. Required for a server-path avatar;
   *  unused for local previews. */
  readonly identityId = input<number | string | undefined | null>(undefined)
  readonly UserAvatarType = UserAvatarType

  /** 图片加载失败（损坏/404）→ 回退首字母。src/identity 变化时重置，以重试新图。 */
  readonly imgFailed = signal(false)

  /** The DB-backed blob URL for a server avatar (empty until resolved, or for local-preview/no-avatar). */
  private readonly objectUrl = signal('')
  /** Tracks the currently-live object URL so it can be revoked on change + destroy (no leak). */
  private currentObjectUrl = ''

  /**
   * The `<img>` src. A local preview (`blob:`/`data:`/absolute — does not start with `/`) passes through
   * `assetUrl` directly; a server avatar uses the DB-resolved object URL; otherwise empty (initial-letter
   * fallback). This is the single chokepoint — every [src] caller routes here.
   */
  readonly imgSrc = computed(() => {
    const s = this.src()
    if (s && !s.startsWith('/')) return assetUrl(s) // local preview pass-through
    return this.objectUrl() // DB blob URL, or '' → initial-letter fallback
  })

  constructor() {
    // Reset the failure flag whenever the avatar source changes (retry the new image).
    effect(() => {
      this.src()
      this.identityId()
      this.imgFailed.set(false)
    })

    // Resolve a server avatar from IDB by identity; mint + revoke object URLs across changes. Reads are
    // async (IDB); a hit paints within a microtask. A stale resolution (identity/src moved on) is dropped.
    effect(() => {
      const identity = this.identityKey()
      const src = this.src()
      // Track refreshes so a refreshed blob (overwritten by ProfileRepository→refresh) re-resolves —
      // signal-driven freshness; the component never compares URLs.
      const tick = identity ? this.avatarRepo.refreshTick(identity) : 0
      if (!identity || !src || !src.startsWith('/')) {
        this.clearObjectUrl()
        return
      }
      void this.avatarRepo.getBlob(identity, src).then((blob) => {
        // Drop if the avatar moved on OR was refreshed since this read started.
        if (this.identityKey() !== identity || this.src() !== src || this.avatarRepo.refreshTick(identity) !== tick) return
        if (blob) this.setObjectUrl(URL.createObjectURL(blob))
        else this.clearObjectUrl()
      })
    })

    inject(DestroyRef).onDestroy(() => this.clearObjectUrl())
  }

  /** The DB cache key derived from {@link type} + {@link identityId} (GROUP → `g<id>`, else `u<id>`). */
  private identityKey = computed(() => {
    const id = this.identityId()
    if (id == null) return undefined
    return this.type() === UserAvatarType.GROUP ? `g${id}` : `u${id}`
  })

  /** 是否渲染真实图片（有有效 src 且未失败）。 */
  readonly showImage = computed(() => !!this.imgSrc() && !this.imgFailed())

  /** 首字符（中文取首字、英文取首字母大写）；空名 fallback '?'。 */
  readonly initial = computed(() => {
    const n = (this.name() ?? '').trim()
    return n.length > 0 ? n.charAt(0).toUpperCase() : '?'
  })

  /** Deterministic 31× name hash (abs) — shared by bg + groupFill so a given name always maps to the
   *  same color(s). Reads the name signal, so callers inside computed() stay reactive. */
  private hashName(): number {
    const n = (this.name() ?? '').trim() || '?'
    let h = 0
    for (let i = 0; i < n.length; i++) h = (Math.imul(h, 31) + n.charCodeAt(i)) | 0
    return Math.abs(h)
  }

  /** Background fill: SELF = brand green; everyone else = a name-hashed palette slot (deterministic,
   *  stable per name). */
  readonly bg = computed(() => {
    if (this.type() === UserAvatarType.SELF) return SELF_COLOR
    return PALETTE[this.hashName() % PALETTE.length]
  })

  /** GROUP fallback mock — a DISTINCT design from the user mock: a 2-tone diagonal gradient (two
   *  name-hashed colors, visually signaling multiple members) + a white "users" glyph (rendered in
   *  the template). The user mock stays a solid bg + single initial, so a group reads as a group at
   *  a glance. Same name → same color pair (deterministic). */
  readonly isGroup = computed(() => this.type() === UserAvatarType.GROUP)
  readonly groupFill = computed(() => {
    const a = this.hashName()
    return {
      id: `grp-${a}`,
      from: PALETTE[a % PALETTE.length],
      to: PALETTE[(a + 5) % PALETTE.length],
    }
  })

  private setObjectUrl(url: string): void {
    if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl)
    this.currentObjectUrl = url
    this.objectUrl.set(url)
  }

  private clearObjectUrl(): void {
    if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl)
    this.currentObjectUrl = ''
    this.objectUrl.set('')
  }
}

export { UserAvatarType } from './model'
