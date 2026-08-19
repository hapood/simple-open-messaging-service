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
        [identityId]="other().identityId"
        [src]="other().src"
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
        [identityId]="self().identityId"
        [src]="self().src"
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
    src: '',
    side: 'other',
    top: 0,
  });
  readonly self = signal<StickyAvatarView>({
    name: '',
    src: '',
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
