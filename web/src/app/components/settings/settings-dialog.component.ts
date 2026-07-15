import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { RouteService } from '../../services/route.service';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import { ThemeService } from '../../services/theme.service';
import { LanguageService } from '../../services/language.service';
import { MediaSizeThresholdService } from '../../services/media-size-threshold.service';
import { BackgroundSyncService } from '../../services/background-sync.service';
import { WebPushService } from '../../services/web-push.service';
import { WebsocketService } from '../../services/websocket.service';
import { buildSettingsCategories, type SettingsCategory, type SettingsCategoryId } from './settings-categories';

/**
 * The DESKTOP/TABLET Settings surface — a wide two-column Material dialog (category list on the left,
 * the selected category's detail on the right), opened via {@link RouteService.openSettingsDialog}.
 *
 * Unlike the mobile {@link SettingsComponent} (drill-in: root → sliding sub-page), this is FLAT: both
 * columns are visible at once and selecting a category just updates a local signal — there is no
 * navigation stack to peel, so back / hardware-back closes the whole dialog in one step. It reuses the
 * exact same category registry ({@link buildSettingsCategories}) and body-only sub-page components as the
 * mobile surface; only the interaction model and the dialog shell differ.
 *
 * The dialog wrapper (RootPopup) is full-screen on tablet and a centered card on desktop; `[appFitDialog]`
 * pins the desktop card's height so the two columns scroll internally instead of stretching the card.
 */
@Component({
  selector: 'app-settings-dialog',
  imports: [TranslocoPipe, IconComponent, NgComponentOutlet, FitDialogDirective],
  template: `
    <div class="settings-dlg" [appFitDialog]="{ minHeight: 480 }">
      <div class="msg-header">
        <span class="spacer"></span>
        <span class="title">{{ 'settings.title' | transloco }}</span>
        <button class="icon-btn" type="button" (click)="goBack()"
          [attr.aria-label]="'common.close' | transloco">
          <app-icon [type]="AppIconType.CLOSE" [style]="{ width: '24px', height: '24px' }"></app-icon>
        </button>
      </div>

      <div class="dlg-body">
        <!-- Left: category list (master) -->
        <nav class="cat-list">
          @for (c of visibleCategories(); track c.id) {
            <button type="button" class="cat-row" [class.selected]="selectedId() === c.id"
              (click)="select(c.id)" [attr.aria-current]="selectedId() === c.id ? 'true' : null">
              <app-icon class="lead" [type]="c.icon" [style]="{ width: '20px', height: '20px' }"></app-icon>
              <span class="cat-title">{{ c.titleKey | transloco }}</span>
            </button>
          }
        </nav>

        <!-- Right: selected category detail (the body-only sub-page renders here) -->
        <div class="cat-detail">
          @if (selectedCategory(); as cat) {
            <ng-container *ngComponentOutlet="cat.component"></ng-container>
          }
        </div>
      </div>
    </div>
  `,
  styleUrl: './settings-dialog.component.scss',
})
export class SettingsDialogComponent {
  readonly AppIconType = AppIconType;

  /** Optional deep-link target: when the dialog is opened via {@link RouteService.openSettings} with a
   *  category (e.g. Edit Profile → Devices), the right-hand pane starts on it instead of the first row. */
  readonly initialCategoryId = input<SettingsCategoryId | null>(null);

  private readonly routeService = inject(RouteService);
  private readonly transloco = inject(TranslocoService);
  private readonly theme = inject(ThemeService);
  private readonly language = inject(LanguageService);
  private readonly mediaSize = inject(MediaSizeThresholdService);
  private readonly bgSync = inject(BackgroundSyncService);
  private readonly webPush = inject(WebPushService);
  private readonly ws = inject(WebsocketService);

  /** The shared category registry (same one the mobile surface uses). */
  readonly categories = buildSettingsCategories({
    theme: this.theme,
    language: this.language,
    mediaSize: this.mediaSize,
    bgSync: this.bgSync,
    webPush: this.webPush,
    ws: this.ws,
    transloco: this.transloco,
  });

  /** Visible categories, in display order. */
  readonly visibleCategories = computed(() =>
    this.categories
      .filter((c) => c.visible())
      .sort((a, b) => a.order - b.order),
  );

  /** The currently-selected category (local state — flat, no nav stack). Seeded from the deep-link input
   *  (when it names a visible category) or the first visible category, via the constructor effect below. */
  readonly selectedId = signal<SettingsCategoryId | null>(null);

  /** The selected category object (for rendering its sub-page), or null. */
  readonly selectedCategory = computed<SettingsCategory | null>(
    () => this.categories.find((c) => c.id === this.selectedId()) ?? null,
  );

  constructor() {
    // Seed the selection once inputs are bound (ngComponentOutlet binds before first CD, so this effect
    // runs after `initialCategoryId` is available). Guarded by the null check so it never overwrites a
    // later user selection — it fires until the first set, then no-ops.
    effect(() => {
      if (this.selectedId() !== null) return;
      const init = this.initialCategoryId();
      const visible = this.visibleCategories();
      const pick = init && visible.some((c) => c.id === init) ? init : (visible[0]?.id ?? null);
      this.selectedId.set(pick);
    });
  }

  select(id: SettingsCategoryId): void {
    this.selectedId.set(id);
  }

  /** Close the dialog. `closeDlg` peels the topmost dialog pane — the same thing hardware-back does via
   *  `nav.back()`. */
  goBack(): void {
    this.routeService.closeDlg();
  }
}
