import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A single-line user identity heading. Both halves may truncate so a long nickname or federated
 * domain never displaces trailing row metadata such as timestamps and action buttons. */
@Component({
  selector: 'app-user-identity-label',
  template: `
    <span class="identity-name" [title]="name()">{{ name() }}</span>
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
  readonly name = input.required<string>();
  readonly domain = input<string | null | undefined>(undefined);
}
