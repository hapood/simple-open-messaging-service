import { Component, input } from '@angular/core';
import { IconComponent, AppIconType } from '../icon/icon.component';

/**
 * A small "federated" indicator chip: a globe glyph + the peer's domain (e.g. 🌐 bbb.local). Shown next
 * to a federated user's name/avatar so the cross-server identity is scannable at a glance. Renders
 * nothing when `domain` is empty/null (local users, unknown peers) — so callers can bind it
 * unconditionally and it self-hides. The name itself stays the bare localpart (see displayUserName) —
 * this chip is the single place the server identity appears, avoiding the redundant `bob@bbb.local`
 * run-in with the name.
 */
@Component({
  selector: 'app-federated-badge',
  imports: [IconComponent],
  template: `
    @if (domain()) {
      <span class="fed-badge" [attr.title]="'federated: ' + domain()">
        <app-icon [type]="AppIconType.GLOBE" [style]="{ width: '12px', height: '12px' }"></app-icon>
        <span class="fed-domain">{{ domain() }}</span>
      </span>
    }
  `,
  styles: [
    `
      :host { display: inline-flex; }
      .fed-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 12px;
        line-height: 16px;
        color: var(--app-text-faint);
        background: var(--app-surface-elevated);
        padding: 0 6px;
        border-radius: var(--app-radius-pill);
        white-space: nowrap;
      }
    `,
  ],
})
export class FederatedBadgeComponent {
  /** The peer's domain. Empty/null → the badge self-hides (local user). */
  readonly domain = input<string | null | undefined>(undefined);
  readonly AppIconType = AppIconType;
}
