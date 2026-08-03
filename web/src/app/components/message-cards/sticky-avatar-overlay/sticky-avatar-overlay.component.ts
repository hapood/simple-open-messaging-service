import { Component, input } from '@angular/core';
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
    @if (avatar(); as value) {
      <div
        class="sa-avatar sa-avatar--{{ value.side }}"
        [style.top.px]="value.top"
      >
        <app-user-avatar
          [type]="
            value.side === 'self' ? UserAvatarType.SELF : UserAvatarType.OTHER
          "
          [name]="value.name"
          [identityId]="value.identityId"
          [src]="value.src"
        />
      </div>
    }
  `,
  styleUrl: './sticky-avatar-overlay.component.scss',
})
export class StickyAvatarOverlayComponent {
  readonly UserAvatarType = UserAvatarType;
  readonly avatar = input<StickyAvatarView | null>(null);
}
