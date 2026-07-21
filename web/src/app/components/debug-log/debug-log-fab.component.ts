import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DebugToolsService } from '../../services/debug-tools.service';
import { DebugLogOverlayComponent } from './debug-log-overlay.component';

/**
 * The floating trigger for the debug log panel. Rendered only while {@link DebugToolsService.enabled} is
 * true (dev builds, or production after the hidden entry flipped it). Mounts the overlay on demand via
 * `@if`, so the (heavier) overlay + its refresh interval only exist while open.
 *
 * Fixed bottom-right at z-index 1200 — above every production overlay (lightbox 1100) so it stays reachable
 * while debugging a modal/lightbox state. The button is a small fixed element (not a full-screen layer), so
 * it never intercepts content clicks; the overlay (its sibling) is a separate fixed layer that does.
 */
@Component({
  selector: 'app-debug-log-fab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DebugLogOverlayComponent],
  template: `
    @if (debug.enabled()) {
      <button
        type="button"
        class="dbg-fab"
        (click)="toggle()"
        [attr.aria-pressed]="open()"
        aria-label="Debug logs"
        title="Debug logs"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l3 3-3 3M13 15h4" />
        </svg>
      </button>
      <!-- @defer splits DebugLogOverlayComponent into its own lazy chunk (loaded on first open, not in the
           initial production bundle). The inner @if toggles mount/unmount; @defer (when open()) loads the
           chunk once and keeps the wrapper, so open→close→open never re-fetches. -->
      @defer (when open()) {
        @if (open()) {
          <app-debug-log-overlay (close)="open.set(false)" />
        }
      }
    }
  `,
  styles: [
    `
      .dbg-fab {
        position: fixed;
        right: 16px;
        bottom: calc(16px + var(--soms-safe-bottom, 0px));
        z-index: 1200;
        width: 44px;
        height: 44px;
        border: none;
        border-radius: 50%;
        background: #1e1e1e;
        color: #e6e6e6;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        opacity: 0.55;
        transition: opacity 120ms;
      }
      .dbg-fab:hover,
      .dbg-fab:focus-visible {
        opacity: 1;
      }
    `,
  ],
})
export class DebugLogFabComponent {
  readonly debug = inject(DebugToolsService);
  readonly open = signal(false);

  toggle(): void {
    this.open.update((v) => !v);
  }
}
