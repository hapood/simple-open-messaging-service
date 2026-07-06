import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatListModule } from '@angular/material/list';
import { MatSlideToggleModule, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { MatButtonToggleModule, MatButtonToggleChange } from '@angular/material/button-toggle';
import { MatSelectModule, MatSelectChange } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import dayjs from 'dayjs';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { ThemeService, ThemeMode } from '../../services/theme.service';
import { LanguageService, AppLang } from '../../services/language.service';
import { BackgroundSyncService } from '../../services/background-sync.service';
import { isAndroid, isTauri, apiOrigin, apiOriginIsLocalhost } from '../../services/runtime';
import { appVersion } from '../../version';

/**
 * The Settings page — rendered in the `aside` auxiliary outlet, exactly like `profile` / `group-info`.
 * Owns no state of its own: each control binds to the service that owns its preference (Theme /
 * Language / BackgroundSync), so a toggle here and a quick-cycle button elsewhere stay in sync.
 *
 * Sections:
 *  - Appearance: full 3-way theme picker (the only place `system` mode is exposed in the UI).
 *  - Language: dropdown bound to LanguageService (scales as languages are added).
 *  - Push (Android only): FCM status readout + "check now" + the foreground-service toggle + the
 *    6-hour WorkManager poll toggle with its next scheduled time.
 *  - About: app version + configured backend origin (Tauri).
 */
@Component({
  selector: 'app-settings',
  imports: [
    MatListModule,
    MatSlideToggleModule,
    MatButtonToggleModule,
    MatSelectModule,
    MatButtonModule,
    TranslocoPipe,
    IconComponent,
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  readonly AppIconType = AppIconType;
  readonly appVersion = appVersion;

  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  readonly theme = inject(ThemeService);
  readonly language = inject(LanguageService);
  readonly bgSync = inject(BackgroundSyncService);

  /** The Push section (FCM + FGS + poll) exists only in the Tauri Android shell. */
  readonly showPush = isTauri() && isAndroid();
  /** The Backend row is only meaningful under Tauri (where the origin is configurable). */
  readonly showBackend = isTauri();
  /** Human-readable backend origin, or null when still on the localhost default. */
  readonly backendLabel = computed(() => {
    void this.language.lang(); // re-evaluate on language switch (notConnected label)
    return apiOrigin && !apiOriginIsLocalhost() ? apiOrigin : null;
  });

  /** True while a manual FCM check is in flight (the "Check" button shows a checking state). */
  readonly checking = signal(false);

  /** True when FCM is active on this device — drives the "FGS not needed" hint on the FGS row. */
  readonly fcmActive = computed(() => this.bgSync.fcmStatus().hasToken);
  readonly fcmStatusLabel = computed(() => {
    void this.language.lang();
    return this.transloco.translate(this.fcmActive() ? 'settings.fcmActive' : 'settings.fcmUnavailable');
  });
  readonly fcmLastCheckLabel = computed(() => {
    void this.language.lang();
    const ms = this.bgSync.fcmStatus().lastCheck;
    if (!ms) return this.transloco.translate('settings.fcmNever');
    return this.transloco.translate('settings.fcmLastCheck', { time: dayjs(ms).format('MM-DD HH:mm') });
  });

  /** Next WorkManager pull time, formatted (≈ prefix in the template). Empty when not scheduled. */
  readonly nextPullLabel = computed(() => {
    void this.bgSync.enabled(); // re-evaluate when the poll toggle flips
    const t = this.bgSync.nextPullTime();
    return t > 0 ? dayjs(t).format('HH:mm') : '';
  });

  /** Native-script label for a language id (`'English'` / `'简体中文'`) — self-identifies. */
  languageLabel(l: AppLang): string {
    return this.language.langLabelOf(l);
  }

  onThemeChange(e: MatButtonToggleChange): void {
    this.theme.setMode(e.value as ThemeMode);
  }

  onLangChange(e: MatSelectChange): void {
    this.language.setLang(e.value as AppLang);
  }

  onPollChange(e: MatSlideToggleChange): void {
    this.bgSync.setEnabled(e.checked);
  }

  onFgsChange(e: MatSlideToggleChange): void {
    this.bgSync.setFgsEnabled(e.checked);
  }

  /** Manual FCM availability check — force a token fetch + show a checking state until it settles. */
  requestFcmCheck(): void {
    this.checking.set(true);
    this.bgSync.requestFcmCheck();
    // Match BackgroundSyncService's re-read delay; the token fetch + emit lands around then.
    window.setTimeout(() => this.checking.set(false), 2700);
  }

  /** Close the aside panel — mirrors PeerProfileComponent.goBack (clears the auxiliary outlet). */
  goBack(): void {
    void this.router.navigate([{ outlets: { aside: null } }]);
  }
}
