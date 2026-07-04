import { Component, computed, inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { UpdateService } from '../../services/update.service';
import { LanguageService } from '../../services/language.service';

/**
 * Non-intrusive "new version available" strip, fixed at the top of the viewport. Mirrors
 * {@link ConnectionBannerComponent}'s enter animation and `prefers-reduced-motion` guard, with a
 * brand-blue accent (`--app-brand`) instead of the connection chip's amber (`--app-warning`), so the
 * two states never read as the same thing.
 *
 * Stacking: the connection indicator is now a small corner chip (top-right, z-index 52), not a
 * full-width strip — so this banner no longer self-offsets to clear it. When the two coincide (a
 * reconnect during a pending update) the chip simply floats above this strip's top-right corner; the
 * strip's centered text/buttons stay clear of that corner.
 *
 * Like the connection chip, this banner does NOT push content (the shell reserves no padding for it):
 * a version update is a rare, dismissible, user-elected action, so briefly overlaying the header is
 * preferable to shifting the whole layout every time a deploy ships.
 */
@Component({
  selector: 'app-update-banner',
  standalone: true,
  template: `
    @if (update.bannerVisible()) {
      <div class="banner" role="status" aria-live="polite">
        <span class="dot" aria-hidden="true"></span>
        <span class="text">{{ bannerText() }}</span>
        <button type="button" class="btn primary" (click)="update.applyUpdate()">
          {{ reloadText() }}
        </button>
        <button type="button" class="btn ghost" (click)="update.dismiss()">
          {{ dismissText() }}
        </button>
      </div>
    }
  `,
  styles: [`
    :host {
      position: fixed;
      left: 0;
      right: 0;
      top: 0;
      z-index: 51; /* below the connection chip (52) so the chip stays visible; above the shell's slot layers so Reload is reachable */
      display: block;
    }
    .banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 7px 12px;
      min-height: 36px;
      font-size: 13px;
      font-weight: 500;
      line-height: 1;
      /* Brand-blue "info" treatment, tinted over the themed surface (auto light/dark). */
      color: var(--app-brand);
      background: color-mix(in srgb, var(--app-brand) 14%, var(--app-surface));
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.10);
      animation: update-enter 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .text { white-space: nowrap; }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--app-brand);
      flex: 0 0 auto;
    }
    .btn {
      appearance: none;
      border: none;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.4;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn.primary {
      background: var(--app-brand);
      color: #fff;
    }
    .btn.primary:hover { background: var(--app-brand-hover); }
    .btn.ghost {
      background: transparent;
      color: var(--app-brand);
    }
    .btn.ghost:hover { background: color-mix(in srgb, var(--app-brand) 10%, transparent); }
    @keyframes update-enter {
      from { transform: translateY(-100%); opacity: 0; }
      to   { transform: translateY(0);     opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .banner { animation: none; }
    }
  `],
})
export class UpdateBannerComponent {
  readonly update = inject(UpdateService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  // Reading lang() in each computed makes the labels re-translate on language switch under zoneless.
  readonly bannerText = computed(() => { this.language.lang(); return this.transloco.translate('update.banner'); });
  readonly reloadText = computed(() => { this.language.lang(); return this.transloco.translate('update.reload'); });
  readonly dismissText = computed(() => { this.language.lang(); return this.transloco.translate('update.dismiss'); });
}
