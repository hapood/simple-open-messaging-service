import {
  Component,
  effect,
  input,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import type { StickyAvatarView } from '../../../lib/sticky-avatar';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';

/** Shared viewport-level avatar paint layer; positioning/group selection stays in the shared sticky-avatar helper. */
@Component({
  selector: 'app-sticky-avatar-overlay',
  standalone: true,
  imports: [UserAvatarComponent],
  template: `
    <div
      class="sa-avatar sa-avatar--other"
      [class.sa-avatar--visible]="avatar()?.side === 'other'"
      [style.top.px]="other().top"
    >
      <app-user-avatar
        [type]="UserAvatarType.OTHER"
        [name]="other().name"
        [account]="other().account"
        [federatedDomain]="other().domain"
        [profileEvidence]="other().profileEvidence"
        [src]="other().snapshotAvatarUrl"
      />
    </div>
    <div
      class="sa-avatar sa-avatar--self"
      [class.sa-avatar--visible]="avatar()?.side === 'self'"
      [style.top.px]="self().top"
    >
      <app-user-avatar
        [type]="UserAvatarType.SELF"
        [name]="self().name"
        [federatedDomain]="self().domain"
        [profileEvidence]="self().profileEvidence"
        [src]="self().snapshotAvatarUrl"
      />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sticky-avatar-overlay.component.scss',
})
export class StickyAvatarOverlayComponent {
  readonly UserAvatarType = UserAvatarType;
  readonly avatar = input<StickyAvatarView | null>(null);
  readonly other = signal<StickyAvatarView>({
    name: '',
    side: 'other',
    top: 0,
  });
  readonly self = signal<StickyAvatarView>({
    name: '',
    side: 'self',
    top: 0,
  });

  constructor() {
    effect(() => {
      const value = this.avatar();
      if (!value) return;
      (value.side === 'self' ? this.self : this.other).set(value);
    });
  }
}
