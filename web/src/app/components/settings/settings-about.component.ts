import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { isTauri, listenEvent } from '../../services/runtime';
import { ShellUpdateService } from '../../services/shell-update.service';
import { DebugToolsService } from '../../services/debug-tools.service';
import { appVersion } from '../../version';
import { UserService } from '../../services/user.service';
import type {
  PersonalQuotaCategory,
  PersonalQuotaState,
} from '../../services/model';
import { personalQuotaStatus } from '../profile-editor/personal-quota-status';

/** Byte-progress payload Rust emits as `web-download-progress` while streaming the web bundle. */
interface DownloadProgress {
  received: number;
  total: number | null;
}

/**
 * Settings → About sub-page. App (shell) + web + server versions, plus the client-update prompt:
 *  - the shell is too old for the server → "contact your administrator" (Tauri can't self-update its
 *    binary, and a newer bundle that needs the newer shell is not downloaded);
 *  - a newer web bundle is available AND the shell is OK → an "Update" button that streams the download
 *    with an inline progress bar, then prompts a reload (the running SPA is still the old build);
 *  - otherwise → "up to date".
 * The version + update rows are Tauri-only (the browser build is served same-origin; PWA updates are a
 * separate flow). Body-only.
 */
@Component({
  selector: 'app-settings-about',
  imports: [MatButtonModule, TranslocoPipe],
  template: `
    <section class="about-page">
      <header class="product-hero">
        <img class="product-mark" src="/logo.svg" alt="" />
        <div>
          <h2>SOMS</h2>
          <p>{{ 'settings.aboutTagline' | transloco }}</p>
        </div>
        <span class="version-chip" (click)="debug.bumpGesture()"
          >v{{ appVersion }}</span
        >
      </header>

      @if (showBackend) {
        <section
          class="update-card"
          aria-live="polite"
          [class.is-downloading]="downloading()"
          [class.is-error]="!!updateError()"
          [class.is-current]="
            probed() &&
            !webUpdateAvailable() &&
            !incompatible() &&
            !updateError()
          "
        >
          <div class="update-heading">
            <div class="status-orb" aria-hidden="true">
              @if (downloading()) {
                <span class="download-arrow">↓</span>
              } @else if (updateError() || incompatible()) {
                <span>!</span>
              } @else if (webUpdateAvailable()) {
                <span class="download-arrow">↓</span>
              } @else if (probed()) {
                <span>✓</span>
              } @else {
                <span class="probe-dot"></span>
              }
            </div>
            <div class="update-copy">
              <h3>
                @if (downloading()) {
                  {{ 'settings.updateDownloading' | transloco }}
                } @else if (updateError()) {
                  {{ 'settings.updateFailedTitle' | transloco }}
                } @else if (incompatible()) {
                  {{ 'settings.updateRequired' | transloco }}
                } @else if (webUpdateAvailable()) {
                  {{ 'settings.updateReady' | transloco }}
                } @else if (probed()) {
                  {{ 'settings.upToDate' | transloco }}
                } @else {
                  {{ 'settings.updateChecking' | transloco }}
                }
              </h3>
              <p>
                @if (downloading()) {
                  {{ 'settings.updateDownloadingHint' | transloco }}
                } @else if (updateError()) {
                  {{ updateError() }}
                } @else if (incompatible()) {
                  {{
                    'settings.appIncompatible'
                      | transloco: { version: serverVersion() }
                  }}
                } @else if (webUpdateAvailable()) {
                  {{
                    'settings.updateAvailable'
                      | transloco: { version: serverWebVersion() }
                  }}
                } @else if (probed()) {
                  {{ 'settings.upToDateHint' | transloco }}
                } @else {
                  {{ 'settings.updateCheckingHint' | transloco }}
                }
              </p>
            </div>
            @if (downloading()) {
              <strong class="percent">{{ downloadReadout() }}</strong>
            }
          </div>

          @if (downloading()) {
            <div
              class="progress-track"
              role="progressbar"
              [attr.aria-label]="'settings.updateDownloading' | transloco"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuenow]="downloadTotal() ? downloadPercent() : null"
              [class.indeterminate]="!downloadTotal()"
            >
              <span
                [style.width.%]="downloadTotal() ? downloadPercent() : 34"
              ></span>
            </div>
          } @else if (updateError()) {
            <button
              mat-flat-button
              color="primary"
              type="button"
              (click)="update()"
            >
              {{ 'settings.retry' | transloco }}
            </button>
          } @else if (webUpdateAvailable()) {
            <button
              mat-flat-button
              color="primary"
              type="button"
              (click)="update()"
            >
              {{ 'settings.updateBtn' | transloco }}
            </button>
          }
        </section>
      }

      <section class="details-card">
        <h3>{{ 'settings.versionDetails' | transloco }}</h3>
        <dl>
          @if (showBackend) {
            <div>
              <dt>{{ 'settings.appVersion' | transloco }}</dt>
              <dd>{{ shellVersion() || '—' }}</dd>
            </div>
          }
          <div>
            <dt>{{ 'settings.webVersion' | transloco }}</dt>
            <dd>{{ appVersion }}</dd>
          </div>
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
  private readonly shellUpdate = inject(ShellUpdateService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly transloco = inject(TranslocoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly userService = inject(UserService);
  /** Hidden debug-tools gesture target (10-tap toggle of the log panel gate). Public for the template. */
  readonly debug = inject(DebugToolsService);

  readonly appVersion = appVersion;
  /** The version + update rows are only meaningful under Tauri (where the origin/server is configured). */
  readonly showBackend = isTauri();
  /** The live update-status probe (local + server versions + derived flags), or null before first probe. */
  private readonly status = this.shellUpdate.updateStatus;
  /** Byte-progress state for the inline download bar, fed by the `web-download-progress` Tauri event. */
  private readonly downloadReceived = signal(0);
  readonly downloadTotal = signal<number | null>(null);
  readonly downloading = signal(false);
  readonly updateError = signal('');
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

  readonly shellVersion = computed(() => this.status()?.shellVersion ?? '');
  readonly serverVersion = computed(() => this.status()?.serverVersion ?? '');
  readonly serverWebVersion = computed(
    () => this.status()?.serverWebVersion ?? '',
  );
  /** True once at least one probe has completed (so "up to date" only shows after we actually checked). */
  readonly probed = computed(() => this.status() !== null);
  readonly incompatible = computed(() => this.status()?.incompatible ?? false);
  readonly webUpdateAvailable = computed(
    () => this.status()?.webUpdateAvailable ?? false,
  );
  readonly backendLabel = computed(() => {
    return this.shellUpdate.probedOrigin() || null;
  });
  readonly downloadPercent = computed(() => {
    const total = this.downloadTotal();
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.round((this.downloadReceived() / total) * 100));
  });
  readonly downloadReadout = computed(() => {
    const total = this.downloadTotal();
    if (total && total > 0) return `${this.downloadPercent()}%`;
    return formatBytes(this.downloadReceived());
  });

  constructor() {
    // Re-probe when the page opens so the version state is fresh (not just the launch-time snapshot).
    afterNextRender(() => void this.shellUpdate.check());
    // Subscribe ONCE to the Rust stream-download byte-progress event (cleaned up on destroy). The
    // handler early-returns outside a download, so registering once — not per update() — never leaks
    // a listener across retries.
    this.registerProgressListener();
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

  /** Subscribe to `web-download-progress` once; the handler ignores events outside a download. */
  private registerProgressListener(): void {
    void (async () => {
      const unlisten = await listenEvent<DownloadProgress>(
        'web-download-progress',
        (e) => {
          if (!this.downloading()) return;
          this.downloadReceived.set(e.payload.received);
          this.downloadTotal.set(e.payload.total);
        },
      );
      if (unlisten) this.destroyRef.onDestroy(unlisten);
    })();
  }

  /** User-initiated web-bundle update: stream-download (the inline bar is driven by the constructor
   *  listener), then prompt reload. */
  async update(): Promise<void> {
    if (this.downloading()) return;
    this.updateError.set('');
    this.downloadReceived.set(0);
    this.downloadTotal.set(null);
    this.downloading.set(true);
    try {
      await this.shellUpdate.downloadUpdate();
      this.downloading.set(false);
      this.promptReload();
    } catch (e) {
      this.downloading.set(false);
      this.updateError.set(e instanceof Error ? e.message : String(e));
    }
  }

  /** The newly-installed bundle only takes effect after a reload (the running SPA is still the old one). */
  private promptReload(): void {
    const ref = this.snackBar.open(
      this.transloco.translate('settings.downloaded'),
      this.transloco.translate('settings.reloadNow'),
      { duration: 60000 },
    );
    ref.onAction().subscribe(() => location.reload());
  }
}

/** Format a byte count as a short human string (e.g. `1.2 MB`). Used by the download readout's
 *  indeterminate fallback (chunked transfer, no Content-Length). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
