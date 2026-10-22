import { Component, input, ChangeDetectionStrategy } from '@angular/core';

/**
 * Telegram-style floating sticky-date overlay: the text of the last date-separator row at/above the
 * viewport top, floating over the message list.
 *
 * Shared by the playground and the production message thread (which previously each carried a
 * near-identical `.pg-sticky-date` / `.msg-sticky-date` block). The vertical offset is driven by the
 * `--sd-top` custom property (defaults to 48px — the playground header height); production sets
 * `--sd-top: var(--msg-header-h, 56px)` on `.msg-container`, which inherits down to here. The pill
 * styling (font, color, background, shadow) reuses the global `--im-date-pill-text` / `--im-chat-bg`
 * / `--app-radius-pill` tokens, so theme changes apply uniformly.
 *
 * Rendered only while {@link label} is non-null (the host drives that signal from its scroll handler).
 */
@Component({
  selector: 'app-sticky-date-overlay',
  standalone: true,
  template: `
    @if (label(); as l) {
      <div class="sd-pill" aria-hidden="true">
        <span>{{ l }}</span>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sticky-date-overlay.component.scss',
})
export class StickyDateOverlayComponent {
  /** Date label to show, or null to hide the overlay. */
  readonly label = input<string | null>(null);
}
