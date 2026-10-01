import {
  Component,
  computed,
  input,
  signal,
  effect,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { UserAvatarType } from './model';
import { assetUrl } from '../../services/runtime';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../../services/profile-store.service';
import type { ProfileDemand } from '../../../../../shared/profile-demand';

/**
 * Initials avatar (industry best-practice palette).
 *
 * The placeholder SVG has been removed — instead up to two characters derived from the name are centered,
 * with a background color:
 *  · SELF: the theme's action blue, recognizable as "you" and responsive to
 *    the light/dark palette.
 *  · OTHER / identified GROUP: an account+domain-hashed deterministic palette. The stable key includes the
 *    avatar type, so a user and group with the same address do not share an identity namespace. Local identities
 *    use `local` as their domain. If an account is not available yet, a draft group uses the theme's action blue;
 *    display names and database ids never affect identity color.
 *    The palette uses Material dark shades, reaching WCAG AA contrast against white text.
 *
 * Rounded square (WeChat-style, rx=20% → 8px under a 40px container, matching .msg-avatar in chats) + SVG
 * viewBox: the font size is fixed within the viewBox and scales with the container (44–56px covers both lists
 * and drawers), independent of the parent's size or clipping — zero layout changes at call sites (nav-drawer /
 * icon-rail containers must drop the forced-circular overflow/border-radius).
 *
 * Resolved profiles provide a binary avatar through the profile repository. The component
 * owns the short-lived object URL. Local previews without profile evidence pass through.
 */
const PALETTE = [
  '#E53935',
  '#D81B60',
  '#8E24AA',
  '#5E35B1',
  '#3949AB',
  '#1E88E5',
  '#039BE5',
  '#00ACC1',
  '#00897B',
  '#43A043',
  '#6D4C41',
  '#546E7A',
];

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

function firstGraphemes(value: string, count: number): string {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment)
    .slice(0, count)
    .join('');
}

function firstGrapheme(value: string): string {
  return firstGraphemes(value, 1);
}

@Component({
  selector: 'app-user-avatar',
  imports: [],
  templateUrl: './user-avatar.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './user-avatar.component.scss',
})
export class UserAvatarComponent {
  private readonly userService = inject(UserService);
  private readonly profiles = inject(ProfileRepository);
  private readonly conversations = inject(ConversationListService, {
    optional: true,
  });

  readonly type = input<UserAvatarType>(UserAvatarType.OTHER);
  readonly name = input<string | undefined | null>('');
  /** Only P2P message avatars receive this thread context; aliases never override group members. */
  readonly p2pThreadId = input<number | undefined>(undefined);
  private readonly p2pAlias = computed(() => {
    if (this.type() !== UserAvatarType.OTHER) return '';
    const threadId = this.p2pThreadId();
    if (threadId === undefined) return '';
    const conversation = this.conversations
      ?.items()
      .find((item) => item.threadId === threadId && item.type === 'P2P');
    return conversation?.type === 'P2P' &&
      conversation.peerUser.account === this.account() &&
      conversation.peerUser.domain === this.federatedDomain()
      ? (conversation.alias?.trim() ?? '')
      : '';
  });
  /** Stable account identifier used with the home domain for the generated fallback color. Display
   * names and database ids are deliberately excluded because both can change across time/localization. */
  readonly account = input<string | undefined | null>(undefined);
  /** Optional unresolved image URL or local preview. Empty selects the generated fallback. */
  readonly src = input<string | undefined | null>(undefined);
  /** Identity home domain. `local` means local; a foreign domain renders the shared top-right globe marker. */
  readonly federatedDomain = input<string | undefined | null>(undefined);
  /** Unresolved identity → render the glass shimmer placeholder so no avatar content (and no
   *  misleading initial) paints until the backing profile/session is ready. Callers pass
   *  `!sessionProfile()` while the source signal is still loading. */
  readonly loading = input(false);
  readonly profileEvidence = input<ProfileDemand | undefined>(undefined);
  private readonly effectiveProfileEvidence = computed(() => {
    const explicit = this.profileEvidence();
    if (explicit) return explicit;
    const preview = this.src();
    if (
      this.type() !== UserAvatarType.SELF ||
      (preview && !preview.startsWith('/'))
    )
      return undefined;
    const self = this.userService.sessionProfile();
    return self && (self.profileRev ?? 0) > 0
      ? {
          publisherNamespaceId: self.namespaceId ?? 0,
          lookup: 'ACCOUNT_PROFILE' as const,
          target: {
            profileNamespaceId: self.namespaceId ?? 0,
            account: self.account,
            rev: self.profileRev,
          },
        }
      : undefined;
  });
  readonly UserAvatarType = UserAvatarType;
  private readonly resolvedProfile = signal<ResolvedProfile | null>(null);

  /** Normalized foreign domain used by the marker. */
  readonly federatedMarkerDomain = computed(() => {
    const domain = this.federatedDomain()?.trim();
    return domain && domain.toLowerCase() !== 'local' ? domain : null;
  });

  private readonly effectiveSrc = computed(() => {
    const profile = this.resolvedProfile();
    if (profile) return '';
    return this.src();
  });
  readonly effectiveName = computed(
    () =>
      this.p2pAlias() ||
      this.resolvedProfile()?.name ||
      this.name() ||
      (this.type() === UserAvatarType.SELF
        ? this.userService.sessionProfile()?.name
        : undefined),
  );

  /** Image load failure (corrupt/404) → fall back to initials. Reset on src/identity change to retry the new image. */
  readonly imgFailed = signal(false);

  private readonly profileObjectUrl = signal('');

  /**
   * The `<img>` src. Profile evidence selects only committed bytes; previews without
   * profile evidence use their supplied source.
   */
  readonly imgSrc = computed(() => {
    if (this.effectiveProfileEvidence())
      return this.resolvedProfile()?.avatarBlob ? this.profileObjectUrl() : '';
    const s = this.effectiveSrc();
    return s ? assetUrl(s) : '';
  });

  constructor() {
    effect((onCleanup) => {
      const blob = this.resolvedProfile()?.avatarBlob;
      if (!blob) {
        this.profileObjectUrl.set('');
        return;
      }
      const url = URL.createObjectURL(blob);
      this.profileObjectUrl.set(url);
      onCleanup(() => URL.revokeObjectURL(url));
    });
    effect((onCleanup) => {
      const evidence = this.effectiveProfileEvidence();
      this.resolvedProfile.set(null);
      if (!evidence) return;
      const subscription = this.profiles.resolve(evidence).subscribe({
        next: (profile) => this.resolvedProfile.set(profile),
        error: () => this.resolvedProfile.set(null),
      });
      onCleanup(() => subscription.unsubscribe());
    });
    // A failed image must be retried when its source or selected identity changes.
    effect(() => {
      this.imgSrc();
      this.account();
      this.federatedDomain();
      this.effectiveProfileEvidence();
      this.imgFailed.set(false);
    });
  }

  /** Whether to render the real image (valid src present and not failed). */
  readonly showImage = computed(() => !!this.imgSrc() && !this.imgFailed());

  /**
   * Up to two name characters for the fallback avatar. Multi-word names use the first grapheme of the
   * first two words (`Alice Smith` → `AS`); single-word names use their first two graphemes (`Alice` →
   * `AL`, `张小明` → `张小`). Intl.Segmenter keeps composed emoji and combining marks intact.
   */
  readonly initial = computed(() => {
    const n = (this.effectiveName() ?? '').trim();
    if (!n) return '?';

    const words = n.split(/\s+/u);
    const value =
      words.length > 1
        ? words
            .slice(0, 2)
            .map((word) => firstGrapheme(word))
            .join('')
        : firstGraphemes(words[0], 2);
    return value.toLocaleUpperCase();
  });

  /** Deterministic 31× hash for fallback colors. Every non-SELF identity is keyed exclusively by its
   * namespaced account + home domain. Local identities use the explicit `local` domain. */
  private hashColorKey(): number {
    const account = this.account() ?? '';
    const domain = this.federatedMarkerDomain()?.toLowerCase() || 'local';
    const namespace = this.type() === UserAvatarType.GROUP ? 'g' : 'u';
    const n = account ? JSON.stringify([namespace, domain, account]) : '';
    let h = 0;
    for (let i = 0; i < n.length; i++)
      h = (Math.imul(h, 31) + n.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  /** Background fill: SELF = themed action blue; everyone else = an identity-hashed palette slot. */
  readonly bg = computed(() => {
    if (this.type() === UserAvatarType.SELF) return 'var(--app-avatar-self-bg)';
    return PALETTE[this.hashColorKey() % PALETTE.length];
  });

  /** GROUP fallback mock — a DISTINCT design from the user mock: a 2-tone diagonal gradient (two
   *  identity-hashed colors, visually signaling multiple members) + a white "users" glyph (rendered in
   *  the template). The user mock stays a solid bg + single initial, so a group reads as a group at
   *  a glance. The same group identity → the same color pair (deterministic). */
  readonly isGroup = computed(() => this.type() === UserAvatarType.GROUP);
  readonly groupFill = computed(() => {
    if (!this.account()) {
      return {
        id: 'grp-draft',
        from: 'var(--app-action-primary)',
        to: 'var(--app-action-primary)',
      };
    }
    const a = this.hashColorKey();
    return {
      id: `grp-${a}`,
      from: PALETTE[a % PALETTE.length],
      to: PALETTE[(a + 5) % PALETTE.length],
    };
  });
}

export { UserAvatarType } from './model';
