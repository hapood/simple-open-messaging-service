import { Component, computed, input, signal, effect, inject, DestroyRef } from '@angular/core';
import { UserAvatarType } from './model'
import { assetUrl } from '../../services/runtime'
import { AvatarRepository } from '../../services/avatar-cache.service'
import { UserService } from '../../services/user.service'

/**
 * Initials avatar (industry best-practice palette).
 *
 * The placeholder SVG has been removed — instead up to two characters derived from the name are centered,
 * with a background color:
 *  · SELF: fixed graphite avatar color, recognizable as "you" and independent
 *    from the light/dark interactive brand color.
 *  · OTHER / GROUP: an identity-hashed deterministic palette. The stable key includes the avatar type,
 *    so a user and group with the same numeric id do not share an identity namespace. If an identity is not
 *    available yet, every unresolved identity uses the same empty seed; display names never affect identity color.
 *    The palette uses Material dark shades, reaching WCAG AA contrast against white text.
 *
 * Rounded square (WeChat-style, rx=20% → 8px under a 40px container, matching .msg-avatar in chats) + SVG
 * viewBox: the font size is fixed within the viewBox and scales with the container (44–56px covers both lists
 * and drawers), independent of the parent's size or clipping — zero layout changes at call sites (nav-drawer /
 * icon-rail containers must drop the forced-circular overflow/border-radius).
 *
 * Avatar bytes are read ONLY from the DB layer ({@link AvatarRepository} → IndexedDB), keyed by stable
 * identity (`identityId` + `type`), never by URL. On a cache miss the repository fetches + caches; on a
 * hit the bytes come straight from IDB. A local preview (`blob:`/`data:`/absolute `src`) passes through
 * unchanged (new-group / edit-profile in-progress uploads).
 */
const PALETTE = [
  '#E53935', '#D81B60', '#8E24AA', '#5E35B1',
  '#3949AB', '#1E88E5', '#039BE5', '#00ACC1',
  '#00897B', '#43A043', '#6D4C41', '#546E7A',
];

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function firstGraphemes(value: string, count: number): string {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment)
    .slice(0, count)
    .join('')
}

function firstGrapheme(value: string): string {
  return firstGraphemes(value, 1)
}

@Component({
    selector: 'app-user-avatar',
    imports: [],
    templateUrl: './user-avatar.component.html',
    styleUrl: './user-avatar.component.scss'
})

export class UserAvatarComponent {
  private readonly avatarRepo = inject(AvatarRepository);
  private readonly userService = inject(UserService);

  readonly type = input<UserAvatarType>(UserAvatarType.OTHER)
  readonly name = input<string | undefined | null>('')
  /** Optional real avatar image URL. A server path (`/uploads/...`) is read from the DB by {@link identityId};
   *  a local preview (`blob:`/`data:`/absolute) passes through directly. Empty → initial-letter fallback. */
  readonly src = input<string | undefined | null>(undefined)
  /** Stable identity of the user/group this avatar depicts — the IDB cache key (combined with {@link
   *  type}: GROUP → `g<id>`, else `u<id>`). Usually the numeric id; for a group known only by its
   *  `!account` (an invite card) the account string is accepted too. Required for a server-path avatar;
   *  unused for local previews. */
  readonly identityId = input<number | string | undefined | null>(undefined)
  /** Optional stable seed used only for the generated fallback color. This is separate from `identityId`
   *  because a group avatar is cached under its local numeric id, while its globally stable `!account`
   *  is what lets invite cards and conversation rows choose the same color across servers. */
  readonly colorIdentityId = input<number | string | undefined | null>(undefined)
  /** Unresolved identity → render the glass shimmer placeholder so no avatar content (and no
   *  misleading initial) paints until the backing profile/session is ready. Callers pass
   *  `!sessionProfile()` while the source signal is still loading. */
  readonly loading = input(false)
  readonly UserAvatarType = UserAvatarType

  /** Message cards deliberately carry only render-ready message data, so their SELF avatar call sites do
   *  not repeat the session profile on every row. Resolve omitted SELF inputs from the cached session
   *  profile here; explicit inputs still win for profile editors/previews. This also gives every message
   *  card the same `u<selfId>` IndexedDB lookup while offline. */
  private readonly effectiveIdentityId = computed(() =>
    this.identityId() ?? (this.type() === UserAvatarType.SELF ? this.userService.sessionProfile()?.id : undefined)
  )
  private readonly effectiveSrc = computed(() =>
    this.src() ?? (this.type() === UserAvatarType.SELF ? this.userService.sessionProfile()?.avatar : undefined)
  )
  private readonly effectiveName = computed(() =>
    this.name() || (this.type() === UserAvatarType.SELF ? this.userService.sessionProfile()?.name : undefined)
  )

  /** Image load failure (corrupt/404) → fall back to initials. Reset on src/identity change to retry the new image. */
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
    const s = this.effectiveSrc()
    if (s && !s.startsWith('/')) return assetUrl(s) // local preview pass-through
    return this.objectUrl() // DB blob URL, or '' → initial-letter fallback
  })

  constructor() {
    // Reset the failure flag whenever the avatar source changes (retry the new image).
    effect(() => {
      this.effectiveSrc()
      this.effectiveIdentityId()
      this.imgFailed.set(false)
    })

    // Resolve a server avatar from IDB by identity; mint + revoke object URLs across changes. Reads are
    // async (IDB); a hit paints within a microtask. A stale resolution (identity/src moved on) is dropped.
    effect(() => {
      const identity = this.identityKey()
      const src = this.effectiveSrc()
      // Track refreshes so a refreshed blob (overwritten by ProfileRepository→refresh) re-resolves —
      // signal-driven freshness; the component never compares URLs.
      const tick = identity ? this.avatarRepo.refreshTick(identity) : 0
      if (!identity || !src || !src.startsWith('/')) {
        this.clearObjectUrl()
        return
      }
      void this.avatarRepo.getBlob(identity, src)
        .then((blob) => {
          // Drop if the avatar moved on OR was refreshed since this read started.
          if (this.identityKey() !== identity || this.effectiveSrc() !== src || this.avatarRepo.refreshTick(identity) !== tick) return
          if (blob) this.setObjectUrl(URL.createObjectURL(blob))
          else this.clearObjectUrl()
        })
        // getBlob swallows IDB/fetch errors internally, but guard the chain so a reject — e.g. an
        // in-flight fetch aborted by a webview reload/handoff — never surfaces as an unhandled rejection.
        .catch(() => {})
    })

    inject(DestroyRef).onDestroy(() => this.clearObjectUrl())
  }

  /** The DB cache key derived from {@link type} + {@link identityId} (GROUP → `g<id>`, else `u<id>`). */
  private identityKey = computed(() => {
    const id = this.effectiveIdentityId()
    if (id == null) return undefined
    return this.type() === UserAvatarType.GROUP ? `g${id}` : `u${id}`
  })

  /** Whether to render the real image (valid src present and not failed). */
  readonly showImage = computed(() => !!this.imgSrc() && !this.imgFailed())

  /**
   * Up to two name characters for the fallback avatar. Multi-word names use the first grapheme of the
   * first two words (`Alice Smith` → `AS`); single-word names use their first two graphemes (`Alice` →
   * `AL`, `张小明` → `张小`). Intl.Segmenter keeps composed emoji and combining marks intact.
   */
  readonly initial = computed(() => {
    const n = (this.effectiveName() ?? '').trim()
    if (!n) return '?'

    const words = n.split(/\s+/u)
    const value = words.length > 1
      ? words.slice(0, 2).map((word) => firstGrapheme(word)).join('')
      : firstGraphemes(words[0], 2)
    return value.toLocaleUpperCase()
  })

  /** Deterministic 31× hash for fallback colors. Only a stable, namespaced identity (`u…` / `g…`)
   *  participates; a missing identity hashes as empty so mutable display names cannot change the color. */
  private hashColorKey(): number {
    const id = this.colorIdentityId() ?? this.effectiveIdentityId()
    const n = id == null
      ? ''
      : `${this.type() === UserAvatarType.GROUP ? 'g' : 'u'}${id}`
    let h = 0
    for (let i = 0; i < n.length; i++) h = (Math.imul(h, 31) + n.charCodeAt(i)) | 0
    return h >>> 0
  }

  /** Background fill: SELF = stable graphite; everyone else = an identity-hashed palette slot. */
  readonly bg = computed(() => {
    if (this.type() === UserAvatarType.SELF) return 'var(--app-avatar-self-bg)'
    return PALETTE[this.hashColorKey() % PALETTE.length]
  })

  /** GROUP fallback mock — a DISTINCT design from the user mock: a 2-tone diagonal gradient (two
   *  identity-hashed colors, visually signaling multiple members) + a white "users" glyph (rendered in
   *  the template). The user mock stays a solid bg + single initial, so a group reads as a group at
   *  a glance. The same group identity → the same color pair (deterministic). */
  readonly isGroup = computed(() => this.type() === UserAvatarType.GROUP)
  readonly groupFill = computed(() => {
    const a = this.hashColorKey()
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
