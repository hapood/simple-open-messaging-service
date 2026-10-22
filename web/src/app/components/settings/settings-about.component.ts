import {
  afterNextRender,
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { isTauri } from '../../services/runtime';
import { ClientCompatService } from '../../services/client-compat.service';
import { DebugToolsService } from '../../services/debug-tools.service';
import { appVersion } from '../../version';
import { UserService } from '../../services/user.service';
import type {
  PersonalQuotaCategory,
  PersonalQuotaState,
} from '../../services/model';
import { personalQuotaStatus } from '../profile-editor/personal-quota-status';

/** Settings → About. App and server versions plus a future installation-package update affordance.
 * The progress bar is reserved for package downloads; the button is disabled until supported. */
@Component({
  selector: 'app-settings-about',
  imports: [MatButtonModule, TranslocoPipe],
  template: `
    <section class="about-page">
      <header class="product-hero">
        <img class="product-mark" src="logo.svg" alt="" />
        <div>
          <h2>SOMS</h2>
          <p>{{ 'settings.aboutTagline' | transloco }}</p>
        </div>
        <span class="version-chip" (click)="debug.bumpGesture()"
          >v{{ appVersion }}</span
        >
      </header>

      @if (showBackend) {
        <section class="update-card" aria-live="polite">
          <div class="update-heading">
            <div class="update-copy">
              <h3>{{ 'settings.appUpdateTitle' | transloco }}</h3>
              <p>{{ 'settings.appUpdateManual' | transloco }}</p>
            </div>
          </div>
          <!-- TODO: Connect package-download byte progress when an app release endpoint exists. -->
          @if (downloading()) {
            <div
              class="progress-track"
              role="progressbar"
              [attr.aria-label]="'settings.updateDownloading' | transloco"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuenow]="downloadPercent()"
            >
              <span [style.width.%]="downloadPercent()"></span>
            </div>
          }
          <button mat-flat-button color="primary" type="button" disabled>
            {{ 'settings.updateBtn' | transloco }}
          </button>
        </section>
      }

      <section class="details-card">
        <h3>{{ 'settings.versionDetails' | transloco }}</h3>
        <dl>
          @if (showBackend) {
            <div>
              <dt>{{ 'settings.appVersion' | transloco }}</dt>
              <dd>{{ appVersion }}</dd>
            </div>
          }
          @if (showBackend) {
            <div>
              <dt>{{ 'settings.serverVersion' | transloco }}</dt>
              <dd>{{ serverVersion() || '—' }}</dd>
            </div>
            <div>
              <dt>{{ 'settings.backend' | transloco }}</dt>
              <dd class="backend-value">
                {{ backendLabel() || ('settings.notConnected' | transloco) }}
              </dd>
            </div>
          }
        </dl>
      </section>

      @if (debug.enabled()) {
        <button
          class="disable-debug"
          mat-stroked-button
          type="button"
          (click)="debug.disable()"
        >
          {{ 'settings.disableDebugLogs' | transloco }}
        </button>
      }

      <section
        class="quota-card"
        [class.quota-warning]="quotaStatus() === 'warning'"
        [class.quota-exhausted]="quotaStatus() === 'exhausted'"
      >
        <div class="quota-heading">
          <h3>{{ 'profile.quota.title' | transloco }}</h3>
          @if (quotaLoading()) {
            <span>{{ 'profile.quota.loading' | transloco }}</span>
          } @else if (quota()) {
            <span>{{
              'profile.quota.status.' + quotaStatus() | transloco
            }}</span>
          }
        </div>
        @if (quota(); as state) {
          <div class="quota-details">
            @for (category of quotaCategories; track category) {
              <div class="quota-row">
                <div class="quota-row-label">
                  <span>{{
                    'profile.quota.category.' + category | transloco
                  }}</span>
                  @if (state.usage[category].limit === 0) {
                    <span>{{ 'profile.quota.disabled' | transloco }}</span>
                  } @else {
                    <span
                      >{{ state.usage[category].count }} /
                      {{ state.usage[category].limit }}</span
                    >
                  }
                </div>
                <div class="quota-track">
                  <span [style.width.%]="quotaPercent(category)"></span>
                </div>
              </div>
            }
            @if (state.breaker.tripped) {
              <p class="quota-paused">
                {{ 'profile.quota.paused' | transloco }}
              </p>
            }
            <p>
              {{
                'profile.quota.reset'
                  | transloco: { time: formatResetAt(state.resetAt) }
              }}
            </p>
          </div>
        }
      </section>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './settings-about.component.scss',
})
export class SettingsAboutComponent {
  private readonly clientCompat = inject(ClientCompatService);
  private readonly transloco = inject(TranslocoService);
  private readonly userService = inject(UserService);
  /** Hidden debug-tools gesture target (10-tap toggle of the log panel gate). Public for the template. */
  readonly debug = inject(DebugToolsService);

  readonly appVersion = appVersion;
  /** The version + update rows are only meaningful under Tauri (where the origin/server is configured). */
  readonly showBackend = isTauri();
  private readonly status = this.clientCompat.status;
  // TODO: Drive these from the future native package download, not a web bundle.
  readonly downloading = signal(false);
  readonly downloadPercent = signal(0);
  readonly quota = signal<PersonalQuotaState | null>(null);
  readonly quotaLoading = signal(true);
  readonly quotaCategories: PersonalQuotaCategory[] = [
    'messages',
    'files',
    'requests',
  ];
  readonly quotaStatus = computed(() => {
    const state = this.quota();
    return state ? personalQuotaStatus(state) : 'healthy';
  });

  readonly serverVersion = computed(() => this.status()?.serverVersion ?? '');
  readonly incompatible = computed(() => this.status()?.incompatible ?? false);
  readonly backendLabel = computed(
    () => this.clientCompat.probedOrigin() || null,
  );

  constructor() {
    // Re-probe when the page opens so the version state is fresh (not just the launch-time snapshot).
    afterNextRender(() => void this.clientCompat.check());
    this.userService.getMyQuota().subscribe({
      next: (res) => {
        this.quota.set(res.data ?? null);
        this.quotaLoading.set(false);
      },
      error: () => this.quotaLoading.set(false),
    });
  }

  quotaPercent(category: PersonalQuotaCategory): number {
    const item = this.quota()?.usage[category];
    if (!item || item.limit === 0) return 0;
    return Math.min(100, Math.round((item.count / item.limit) * 100));
  }

  formatResetAt(value: number): string {
    return new Intl.DateTimeFormat(this.transloco.getActiveLang(), {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }
}
