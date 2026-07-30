import { Component, computed, inject, signal } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { LanguageService } from '../../services/language.service';
import { DiagnosticsReportService } from '../../services/diagnostics-report.service';

type ReportState = 'idle' | 'confirming' | 'sending' | 'done' | 'failed';

/**
 * Settings → Diagnostics sub-page. A single "Report" action builds a diagnostic bundle (Rust logs + the
 * webview console capture + a version/platform manifest) via the Rust `report_diagnostics` command and
 * uploads it to the backend, where the admin console lists/downloads it for field support.
 *
 * Two-step (begin → confirm → send) so the PII notice (the bundle may contain URLs + account ids) is
 * shown before anything leaves the device. On failure the Rust side KEEPS the bundle under
 * app_cache_dir and retries on the next launch — so the "failed" state reads "saved locally, will retry".
 *
 * Body-only (the host provides the panel shell). Tauri-only — the category is hidden on the browser
 * build (browser users have devtools). All vertical metrics integer px (project rule).
 */
@Component({
  selector: 'app-settings-diagnostics',
  imports: [MatListModule, MatButtonModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.diagnostics' | transloco
            }}</span>
            <span matListItemLine class="hint">{{ lineHint() }}</span>
            <div matListItemMeta class="row-actions">
              @switch (state()) {
                @case ('idle') {
                  <button
                    mat-button
                    type="button"
                    class="check-btn"
                    (click)="begin()"
                  >
                    {{ 'settings.diagnosticsReport' | transloco }}
                  </button>
                }
                @case ('confirming') {
                  <button mat-button type="button" (click)="cancel()">
                    {{ 'settings.diagnosticsCancel' | transloco }}
                  </button>
                  <button
                    mat-button
                    type="button"
                    class="check-btn"
                    (click)="send()"
                  >
                    {{ 'settings.diagnosticsSend' | transloco }}
                  </button>
                }
                @case ('sending') {
                  <button mat-button type="button" disabled>
                    {{ 'settings.diagnosticsSending' | transloco }}
                  </button>
                }
                @case ('done') {
                  <span class="status-pill active">{{
                    'settings.diagnosticsDone' | transloco
                  }}</span>
                }
                @case ('failed') {
                  <button
                    mat-button
                    type="button"
                    class="check-btn"
                    (click)="begin()"
                  >
                    {{ 'settings.diagnosticsRetry' | transloco }}
                  </button>
                }
              }
            </div>
          </mat-list-item>
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsDiagnosticsComponent {
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly reports = inject(DiagnosticsReportService);

  readonly state = signal<ReportState>('idle');
  /** The backend report id once a report has been delivered (shown in the "done" hint). */
  readonly reportId = signal<number | null>(null);

  /** The description line under the title — the PII consent text while confirming, the outcome after. */
  readonly lineHint = computed(() => {
    void this.language.lang();
    switch (this.state()) {
      case 'confirming':
        return this.transloco.translate('settings.diagnosticsConsent');
      case 'sending':
        return this.transloco.translate('settings.diagnosticsSending');
      case 'done':
        return this.transloco.translate('settings.diagnosticsDoneHint', {
          id: this.reportId() ?? '?',
        });
      case 'failed':
        return this.transloco.translate('settings.diagnosticsFailedHint');
      default:
        return this.transloco.translate('settings.diagnosticsDesc');
    }
  });

  begin(): void {
    this.state.set('confirming');
  }

  cancel(): void {
    this.state.set('idle');
  }

  /** Gather the manifest + console capture, then invoke Rust to build + upload the bundle. */
  async send(): Promise<void> {
    if (this.state() === 'sending') return;
    this.state.set('sending');
    try {
      const id = await this.reports.upload();
      this.reportId.set(id);
      this.state.set('done');
    } catch {
      // Rust kept the bundle under app_cache_dir; the next launch's retry re-POSTs it.
      this.state.set('failed');
    }
  }
}
