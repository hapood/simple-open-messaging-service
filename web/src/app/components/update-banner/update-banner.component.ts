import { afterRenderEffect, Component, computed, ElementRef, inject, input, OnDestroy, output, viewChild } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { animate, type AnimationPlaybackControls } from 'motion';
import { UpdateService } from '../../services/update.service';
import { LanguageService } from '../../services/language.service';
import { IndicatorSlotService } from '../../services/indicator-slot.service';
import { prefersReducedMotion, springGradient } from '../../lib/motion-utils';

/**
 * "A new version is available" pill, fixed at the top-right corner — the SAME indicator slot the
 * {@link ConnectionBannerComponent} occupies. The two share the `.tonal-chip` M3 shell (tonal-fill
 * gradient + level-1 elevation + pill shape) and the `springGradient` Motion helper; they differ in accent
 * (brand-blue vs the chip's amber/green/red) and content (this one carries Reload + Dismiss actions).
 *
 * Priority: the connection chip is the slot's priority occupant — while it's showing (connecting /
 * reconnecting / recovered), this banner DEFERS via {@link IndicatorSlotService}. When the chip clears, if
 * an update is still pending, this banner surfaces. The two never share the corner.
 *
 * Like the chip, this does NOT push content (the shell reserves no padding for it): a version update is a
 * rare, dismissible, user-elected action, so briefly overlaying the header is preferable to shifting layout.
 *
 * Playground demo: {@link demoAvailable} overrides the live {@link UpdateService} signal so the chatbox
 * playground can preview the banner (the service worker is disabled in dev, so the real service never latches
 * `available` there). Production leaves it unset (`null`), so behavior is identical to the service. In demo
 * mode the Dismiss button emits {@link demoDismiss} instead of mutating the service — the playground owns the
 * preview signal and clears it; Reload stays {@link UpdateService.applyUpdate} (a no-op when the SW is disabled).
 */
@Component({
  selector: 'app-update-banner',
  standalone: true,
  template: `
    @if (bannerVisible()) {
      <div class="banner tonal-chip" #banner role="status" aria-live="polite">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
        <span class="text">{{ bannerText() }}</span>
        <button type="button" class="btn primary" (click)="update.applyUpdate()">{{ reloadText() }}</button>
        <button type="button" class="btn ghost" (click)="dismiss()" [attr.aria-label]="dismissText()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    }
  `,
  styles: [`
    :host {
      position: fixed;
      top: var(--conn-chip-top, 10px); /* the shared indicator slot — same corner as the connection chip */
      right: 12px;
      /* Below the connection chip (52) — the slot service guarantees they never show at once, so this only
         matters during the brief handoff. */
      z-index: 51;
      display: block;
      /* Brand-blue "info" palette (M3): tinted over the themed surface, auto light/dark. inherits:true on
         the @property registrations lets .banner read these without declaring them itself. */
      --c-brand-1: color-mix(in srgb, var(--app-brand) 16%, var(--app-surface));
      --c-brand-2: color-mix(in srgb, var(--app-brand) 30%, var(--app-surface));
      --c-brand:   var(--app-brand);
    }
    .banner {
      box-sizing: border-box;
      height: 36px; /* matches the connection chip's collapsed circle height */
      gap: 8px;
      padding: 0 6px 0 8px;
      max-width: 340px;
      overflow: hidden;
      /* Enter START: a neutral surface fill + brand icon. springGradient morphs --g-from/--g-to to the
         brand palette on mount (the same Motion helper the connection chip uses for its state morph),
         so the pill "fills in" with brand as it pops in. */
      --g-from: var(--app-surface);
      --g-to:   var(--app-surface);
      --ic:     var(--app-brand);
    }
    .ico {
      width: 20px;
      height: 20px;
      flex: 0 0 20px;
    }
    .text {
      white-space: nowrap;
      /* line-height stays an integer-px length per the CSS rule. */
      font-size: 13px;
      font-weight: 500;
      line-height: 20px;
      padding-right: 2px;
    }
    .btn {
      appearance: none;
      border: none;
      border-radius: 9999px;
      height: 26px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 600;
      line-height: 20px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .btn.primary {
      background: var(--app-brand);
      color: #fff;
    }
    .btn.primary:hover { background: var(--app-brand-hover); }
    .btn.ghost {
      background: transparent;
      color: var(--ic);
      width: 26px;
      padding: 0;
    }
    .btn.ghost svg { width: 14px; height: 14px; }
    .btn.ghost:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
  `],
})
export class UpdateBannerComponent implements OnDestroy {
  readonly update = inject(UpdateService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly slot = inject(IndicatorSlotService);
  private readonly reduceMotion = prefersReducedMotion();
  private readonly bannerRef = viewChild<ElementRef<HTMLDivElement>>('banner');

  /** Active Motion controls — stopped before each enter so animations never overlap. */
  private controls: AnimationPlaybackControls[] = [];

  /** The brand palette var-names that springGradient resolves at runtime (theme-aware via :host). */
  private static readonly BRAND = { from: '--c-brand-1', to: '--c-brand-2', ic: '--c-brand' } as const;

  /** Optional playground override: when non-null, the banner reads this instead of the live
   *  {@link UpdateService.available} signal — the chatbox playground's "Update banner" group uses it to
   *  preview the pill (the service worker is disabled in dev, so the real service never latches there).
   *  Production leaves it unset, so behavior is identical to the service. Mirrors the connection chip's
   *  `demoState` override. */
  readonly demoAvailable = input<boolean | null>(null);
  /** Fires when the user clicks Dismiss while {@link demoAvailable} is set — the playground owns the preview
   *  signal and clears it. Production dismiss still goes through {@link UpdateService.dismiss}. */
  readonly demoDismiss = output<void>();

  /** Effective availability: the demo override if set, else the live service signal. The single source read
   *  by {@link bannerVisible} — so a demo toggle drives the full visibility machine. */
  private readonly effAvailable = computed(() => {
    const d = this.demoAvailable();
    return d !== null ? d : this.update.available();
  });

  /** Visible only when an update is effectively available AND the priority occupant (connection chip) isn't
   *  showing — so the two never compete for the corner. When the chip clears, this re-evaluates and the pill
   *  surfaces if an update is still wanted. */
  readonly bannerVisible = computed(() => this.effAvailable() && !this.slot.priorityOccupied());

  // Reading lang() in each computed makes the labels re-translate on language switch under zoneless.
  readonly bannerText = computed(() => { this.language.lang(); return this.transloco.translate('update.banner'); });
  readonly reloadText = computed(() => { this.language.lang(); return this.transloco.translate('update.reload'); });
  readonly dismissText = computed(() => { this.language.lang(); return this.transloco.translate('update.dismiss'); });

  constructor() {
    /* Enter animation, mounted once bannerVisible turns true. Springs the brand gradient in from the
       surface start (the shared springGradient method) and pops the pill in (scale + opacity). The chip
       uses the same gradient spring for its state morph — the one piece of Motion logic both share.
       Reduced motion snaps the gradient + skips the pop. */
    afterRenderEffect(() => {
      if (!this.bannerVisible()) return;
      const el = this.bannerRef()?.nativeElement;
      if (!el) return;
      this.controls.forEach((c) => c.stop());
      this.controls = [];
      if (this.reduceMotion) {
        const cs = getComputedStyle(el);
        const snap = (name: string, to: string): void => el.style.setProperty(name, cs.getPropertyValue(to).trim());
        snap('--g-from', UpdateBannerComponent.BRAND.from);
        snap('--g-to',   UpdateBannerComponent.BRAND.to);
        snap('--ic',     UpdateBannerComponent.BRAND.ic);
        return;
      }
      this.controls.push(springGradient(el, UpdateBannerComponent.BRAND));
      this.controls.push(animate(el, { opacity: [0, 1], scale: [0.85, 1] }, { type: 'spring', stiffness: 200, damping: 22 }));
    });
  }

  /** Dismiss button. In playground demo mode (demoAvailable set) the preview signal is owned by the parent,
   *  so emit {@link demoDismiss} for it to clear; in production, mutate the live service (latched off until
   *  the next VERSION_READY). Reload always routes through the service (a no-op when the SW is disabled). */
  dismiss(): void {
    if (this.demoAvailable() !== null) this.demoDismiss.emit();
    else this.update.dismiss();
  }

  ngOnDestroy(): void {
    this.controls.forEach((c) => c.stop());
  }
}
