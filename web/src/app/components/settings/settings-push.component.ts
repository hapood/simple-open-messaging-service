import { Component, computed, inject, signal } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatSlideToggleModule, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import dayjs from 'dayjs';
import { BackgroundSyncService } from '../../services/background-sync.service';
import { LanguageService } from '../../services/language.service';

/**
 * Settings → Push sub-page (Android/Tauri only). The FCM availability readout + "Check now" button, the
 * real-time foreground-service toggle, and the ~6h WorkManager poll toggle with its next scheduled time.
 * Moved verbatim from the old flat Settings page — logic unchanged, only relocated behind the category
 * drill-in. Body-only.
 */
@Component({
  selector: 'app-settings-push',
  imports: [MatListModule, MatSlideToggleModule, MatButtonModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <!-- FCM status (read-only) + manual "check now" -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.fcm' | transloco }}</span>
            <span matListItemLine class="hint">{{ fcmLastCheckLabel() }}</span>
            <span class="status-pill" [class.active]="fcmActive()">{{ fcmStatusLabel() }}</span>
            <button mat-button type="button" class="check-btn" (click)="requestFcmCheck()"
              [disabled]="checking()">
              {{ (checking() ? 'settings.fcmChecking' : 'settings.fcmCheckButton') | transloco }}
            </button>
          </mat-list-item>

          <!-- Foreground service (real-time keep-alive) -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.keepAliveFgs' | transloco }}</span>
            <span matListItemLine class="hint">{{ 'settings.keepAliveFgsDesc' | transloco }}</span>
            @if (fcmActive()) {
              <span matListItemLine class="hint hint-accent">{{ 'settings.fgsHintFcmActive' | transloco }}</span>
            }
            <mat-slide-toggle
              [checked]="bgSync.fgsEnabled()"
              [attr.aria-label]="'settings.keepAliveFgs' | transloco"
              (change)="onFgsChange($event)">
            </mat-slide-toggle>
          </mat-list-item>

          <!-- Periodic poll (~6h) + next scheduled time -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.keepAlivePoll' | transloco }}</span>
            <span matListItemLine class="hint">{{ 'settings.keepAlivePollDesc' | transloco }}</span>
            @if (bgSync.enabled() && nextPullLabel()) {
              <span matListItemLine class="hint">
                {{ 'settings.nextPullLabel' | transloco }}:
                {{ 'settings.nextPullApprox' | transloco: { time: nextPullLabel() } }}
              </span>
            }
            <mat-slide-toggle
              [checked]="bgSync.enabled()"
              [attr.aria-label]="'settings.keepAlivePoll' | transloco"
              (change)="onPollChange($event)">
            </mat-slide-toggle>
          </mat-list-item>
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsPushComponent {
  readonly bgSync = inject(BackgroundSyncService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  /** True while a manual FCM check is in flight (the "Check" button shows a checking state). */
  readonly checking = signal(false);

  /** True when FCM is active on this device — drives the "FGS not needed" hint on the FGS row. */
  readonly fcmActive = computed(() => this.bgSync.fcmStatus().hasToken);
  readonly fcmStatusLabel = computed(() => {
    void this.language.lang(); // re-evaluate on language switch
    return this.transloco.translate(this.fcmActive() ? 'settings.fcmActive' : 'settings.fcmUnavailable');
  });
  readonly fcmLastCheckLabel = computed(() => {
    void this.language.lang();
    const ms = this.bgSync.fcmStatus().lastCheck;
    if (!ms) return this.transloco.translate('settings.fcmNever');
    return this.transloco.translate('settings.fcmLastCheck', { time: dayjs(ms).format('MM-DD HH:mm') });
  });

  /** Next WorkManager pull time, formatted. Empty when not scheduled. */
  readonly nextPullLabel = computed(() => {
    void this.bgSync.enabled(); // re-evaluate when the poll toggle flips
    const t = this.bgSync.nextPullTime();
    return t > 0 ? dayjs(t).format('HH:mm') : '';
  });

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
}
