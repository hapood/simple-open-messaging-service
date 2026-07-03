import { Component, computed, inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { WebsocketService } from '../../services/websocket.service';
import { LanguageService } from '../../services/language.service';

/**
 * Slim full-width connection-status strip, fixed at the top of the viewport (Telegram/WhatsApp style).
 * Shown only while the SSE stream is not yet up (`connecting`) or is reconnecting after a drop
 * (`reconnecting`) — so a silent disconnect never reads as "messages just stopped arriving" (the exact
 * failure mode this exists for). Auto-hides the moment the stream reports `open`.
 *
 * Visual: a warm amber bar with a small spinner ring that slides down + fades in on appear. Both the
 * initial connect and a reconnect share the same amber treatment — reconnect is a routine, recoverable
 * state, not an alarm, so it no longer uses the danger-red accent (the text carries the distinction).
 * The tint is `color-mix` of `--app-warning` over the themed `--app-surface`, so it auto-themes; the
 * `--app-warning` token has a `[data-theme=dark]` override, keeping the bar theme-safe.
 *
 * Layout: `position: fixed` at the top edge so it stays visible even over the mobile full-screen chat
 * overlay (z-index 50, audited against the shell's slot layers). To avoid COVERING content, the shell
 * reserves a matching `--conn-banner-h` top padding while a banner is showing (driven by HomeShell's
 * `conn-banner` class) — so desktop/tablet content is PUSHED down, not hidden under the bar. The two
 * heights share the `--conn-banner-h` token so they can't drift apart.
 */
@Component({
  selector: 'app-connection-banner',
  standalone: true,
  template: `
    @if (label(); as l) {
      <div class="banner" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <span class="text">{{ l }}</span>
      </div>
    }
  `,
  styles: [`
    :host {
      position: fixed;
      inset: 0 0 auto 0; /* top edge, full width; height = banner content */
      /* Audited: above the shell's slot layers (mobile aside-slot 40 / chat-slot 30 / tablet aside-slot 20)
         so the bar stays visible over the mobile full-screen chat overlay, but below modal/popover stacks.
         NOT a blind 9999. */
      z-index: 50;
      display: block;
    }
    .banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      padding: 7px 12px;
      min-height: var(--conn-banner-h, 30px);
      font-size: 13px;
      font-weight: 500;
      line-height: 1;
      /* Amber "in progress" treatment: warning hue tinted over the themed surface (auto light/dark). */
      color: var(--app-warning);
      background: color-mix(in srgb, var(--app-warning) 14%, var(--app-surface));
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.10);
      animation: conn-enter 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .text { white-space: nowrap; }
    .spinner {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid color-mix(in srgb, var(--app-warning) 26%, transparent);
      border-top-color: var(--app-warning);
      animation: conn-spin 0.7s linear infinite;
    }
    @keyframes conn-spin { to { transform: rotate(360deg); } }
    @keyframes conn-enter {
      from { transform: translateY(-100%); opacity: 0; }
      to   { transform: translateY(0);     opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .banner  { animation: none; }
      .spinner { animation: none; opacity: 0.9; }
    }
  `],
})
export class ConnectionBannerComponent {
  private readonly ws = inject(WebsocketService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  /** The label to show, or undefined when connected/closed (banner hidden). Reads the language signal so
   *  the label re-evaluates if the user switches languages while a banner is showing. */
  readonly label = computed<string | undefined>(() => {
    this.language.lang();
    switch (this.ws.state()) {
      case 'connecting': return this.transloco.translate('connection.connecting');
      case 'reconnecting': return this.transloco.translate('connection.reconnecting');
      default: return undefined; // 'open' | 'closed'
    }
  });
}
