import {
  Component,
  effect,
  input,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import type { StickyAvatarView } from '../../../lib/sticky-avatar';
import { AvatarComponent } from '../../user-avatar/avatar.component';

/** Positioning belongs to the geometry helper; this layer paints the row's live presentation. */
@Component({
  selector: 'app-sticky-avatar-overlay',
  imports: [AvatarComponent],
  template: `
    <div
      class="sa-avatar sa-avatar--other"
      [class.sa-avatar--visible]="avatar()?.side === 'other'"
      [style.top.px]="other()?.top ?? 0"
    >
      @if (other(); as current) {
        <app-avatar [view]="current.presentation()" />
      }
    </div>
    <div
      class="sa-avatar sa-avatar--self"
      [class.sa-avatar--visible]="avatar()?.side === 'self'"
      [style.top.px]="self()?.top ?? 0"
    >
      @if (self(); as current) {
        <app-avatar [view]="current.presentation()" />
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sticky-avatar-overlay.component.scss',
})
export class StickyAvatarOverlayComponent {
  readonly avatar = input<StickyAvatarView | null>(null);
  readonly other = signal<StickyAvatarView | null>(null);
  readonly self = signal<StickyAvatarView | null>(null);

  constructor() {
    effect(() => {
      const value = this.avatar();
      // Do not retain a destroyed row's signal or a released image URL while hidden.
      this.other.set(value?.side === 'other' ? value : null);
      this.self.set(value?.side === 'self' ? value : null);
    });
  }
}
