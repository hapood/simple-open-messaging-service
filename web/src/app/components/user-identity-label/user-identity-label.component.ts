import type { RequestSnapshot } from '../../../../../shared/request-snapshot';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../../services/profile-store.service';
import {
  avatarProfileDemand,
  type AvatarProfileRef,
} from '../../services/avatar-profile-ref';

/** A single-line user identity heading. Both halves may truncate so a long nickname or federated
 * domain never displaces trailing row metadata such as timestamps and action buttons. When profile
 * evidence is present, the immutable profile revision owns the displayed name. Search results may
 * supply an already-resolved profile; otherwise the account is the loading and error fallback. */
@Component({
  selector: 'app-user-identity-label',
  template: `
    <span class="identity-name" [title]="effectiveName()">{{
      effectiveName()
    }}</span>
    @if (domain()) {
      <span class="identity-domain" [title]="domain()!">{{ domain() }}</span>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'user-identity-label' },
  styles: [
    `
      :host {
        display: flex;
        flex: 1 1 auto;
        align-items: center;
        gap: 4px;
        min-width: 0;
        overflow: hidden;
      }
      .identity-name,
      .identity-domain {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .identity-name {
        /* Keep the domain immediately after the name while allowing both to truncate around metadata. */
        flex: 0 1 auto;
        min-width: 32px;
        color: var(--app-text);
        font-size: var(--identity-name-size, 15px);
        line-height: 20px;
        font-weight: var(--identity-name-weight, 650);
      }
      .identity-domain {
        flex: 0 1 auto;
        min-width: 40px;
        max-width: min(45%, 160px);
        height: 18px;
        padding: 0 6px;
        border-radius: var(--app-radius-pill);
        background: var(--app-surface-elevated);
        color: var(--app-text-faint);
        font-size: 11px;
        line-height: 18px;
        box-sizing: border-box;
      }
    `,
  ],
})
export class UserIdentityLabelComponent {
  private readonly profiles = inject(ProfileRepository);
  readonly account = input<string | undefined>(undefined);
  readonly profile = input<{ name: string } | undefined>(undefined);
  readonly domain = input<string | null | undefined>(undefined);
  /** Pinned profile subject; the label owns the demand form and resolution. */
  readonly profileRef = input<AvatarProfileRef | undefined>(undefined);
  /** Sent presentation suppresses live profile resolution, including on mode changes. */
  readonly snapshot = input<RequestSnapshot | null>(null);
  private readonly profileDemand = computed(() => {
    if (this.snapshot() !== null) return null;
    return avatarProfileDemand(this.profileRef());
  });
  private readonly resolvedProfile = signal<ResolvedProfile | null>(null);
  readonly effectiveName = computed(() => {
    const snapshot = this.snapshot();
    if (snapshot !== null) return snapshot.displayName;

    return (
      this.resolvedProfile()?.name ||
      this.profile()?.name ||
      this.account() ||
      ''
    );
  });

  constructor() {
    effect((onCleanup) => {
      const demand = this.profileDemand();
      this.resolvedProfile.set(null);
      if (!demand) return;
      const subscription = this.profiles.resolve(demand).subscribe({
        next: (profile) => this.resolvedProfile.set(profile),
        error: () => this.resolvedProfile.set(null),
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
