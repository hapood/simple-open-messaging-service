import { Component, computed, inject } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { trigger, transition, style, animate } from '@angular/animations';
import { MatListModule } from '@angular/material/list';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { NavStateMachineService } from '../../services/nav-state.service';
import { ThemeService } from '../../services/theme.service';
import { LanguageService } from '../../services/language.service';
import { MediaSizeThresholdService } from '../../services/media-size-threshold.service';
import { BackgroundSyncService } from '../../services/background-sync.service';
import { WebPushService } from '../../services/web-push.service';
import { WebsocketService } from '../../services/websocket.service';
import { buildSettingsCategories, type SettingsCategory, type SettingsCategoryId } from './settings-categories';

/** Drill-in slide for the sub-page, matching `overlaySlide`'s motion language in HomeShell (the same
 *  enter/leave curves) so the Settings sub-page glides consistently with the rest of the app's overlays.
 *  Fires on the sub-page view's enter (`@if`) and leave. */
const pageSlide = trigger('pageSlide', [
  transition(':enter', [
    style({ transform: 'translate3d(100%, 0, 0)' }),
    animate('300ms cubic-bezier(0.32, 0.72, 0, 1)', style({ transform: 'translate3d(0, 0, 0)' })),
  ]),
  transition(':leave', [
    animate('200ms cubic-bezier(0.4, 0, 1, 1)', style({ transform: 'translate3d(100%, 0, 0)' })),
  ]),
]);

/**
 * The MOBILE Settings surface — a two-tier Material settings UI rendered in the `aside` slot (category
 * list → drill into a category sub-page that slides over the root).
 *
 * The ROOT view is a category list (leading icon + title + current-value summary + chevron). Tapping a
 * category calls {@link NavStateMachineService.pushAside} with `{ category }`, stacking a new aside entry;
 * the SUB-PAGE view then slides over the root (`[@pageSlide]`) and renders the category's body-only
 * component via `*ngComponentOutlet`. The single back button → `nav.back()` pops the sub-page, or — at
 * root depth — closes the aside. Hardware-back follows the same path (it also calls `back()`).
 *
 * Desktop/tablet do NOT use this component — there settings opens as a wide two-column DIALOG instead
 * (see {@link SettingsDialogComponent}); the two share the category registry ({@link buildSettingsCategories})
 * and the body-only sub-page components, differing only in interaction (drill-in vs flat) and shell.
 */
@Component({
  selector: 'app-settings',
  imports: [MatListModule, TranslocoPipe, IconComponent, NgComponentOutlet],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
  animations: [pageSlide],
})
export class SettingsComponent {
  readonly AppIconType = AppIconType;

  private readonly nav = inject(NavStateMachineService);
  private readonly transloco = inject(TranslocoService);
  private readonly theme = inject(ThemeService);
  private readonly language = inject(LanguageService);
  private readonly mediaSize = inject(MediaSizeThresholdService);
  private readonly bgSync = inject(BackgroundSyncService);
  private readonly webPush = inject(WebPushService);
  private readonly ws = inject(WebsocketService);

  /** The shared category registry (built once; the same array drives the desktop/tablet dialog too). */
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

  /** The active category, derived from the topmost aside entry's `params.category` (null at root). */
  readonly activeCategory = computed<SettingsCategory | null>(() => {
    const id = this.nav.asideTop()?.params?.['category'] as SettingsCategoryId | undefined;
    return id ? (this.categories.find((c) => c.id === id) ?? null) : null;
  });

  /** Drill into a category: push a new aside entry (the sub-page slides over the root). */
  openCategory(c: SettingsCategory): void {
    this.nav.pushAside('settings', { category: c.id });
  }

  /** Back: pops the sub-page (→ root list) or, at root depth, closes the aside. Same path hardware-back
   *  takes. */
  goBack(): void {
    this.nav.back();
  }
}
