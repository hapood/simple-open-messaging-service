import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { IconComponent, AppIconType } from '../icon/icon.component';

/**
 * A small "federated" indicator chip: a globe glyph + the peer's domain (e.g. 🌐 bbb.local). Shown under
 * a federated user's avatar so the cross-server identity is scannable at a glance. Renders nothing when
 * `domain` is empty/null (local users, unknown peers) — so callers can bind it unconditionally and it
 * self-hides. The name itself stays the nickname (see displayUserName) — this chip is the single place
 * the server identity appears, avoiding the redundant `bob@bbb.local` run-in with the name.
 */
@Component({
  selector: 'app-federated-badge',
  imports: [IconComponent],
  template: `
    @if (domain()) {
      <span
        class="fed-badge"
        [class.compact]="compact()"
        [attr.title]="domain()"
      >
        <app-icon
          [type]="AppIconType.GLOBE"
          [style]="{ width: '12px', height: '12px' }"
        ></app-icon>
        @if (!compact()) {
          <span class="fed-domain">{{ domain() }}</span>
        }
      </span>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: inline-flex;
      }
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
      .fed-badge.compact {
        padding: 2px;
        background: transparent;
      }
    `,
  ],
})
export class FederatedBadgeComponent {
  /** The peer's domain. Empty/null → the badge self-hides (local user). */
  readonly domain = input<string | null | undefined>(undefined);
  /** Icon-only treatment for dense surfaces; the full domain remains available as a tooltip. */
  readonly compact = input(false);
  readonly AppIconType = AppIconType;
}
