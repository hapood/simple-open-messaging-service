import { afterNextRender, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { apiOrigin, apiOriginIsEmpty, isTauri, listenEvent } from '../../services/runtime';
import { ShellUpdateService } from '../../services/shell-update.service';
import { appVersion } from '../../version';

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
  imports: [MatButtonModule, MatListModule, MatProgressBarModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.appVersion' | transloco }}</span>
            <span class="meta">{{ shellVersion() || '—' }}</span>
          </mat-list-item>
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.version' | transloco }}</span>
            <span class="meta">{{ appVersion }}</span>
          </mat-list-item>
          @if (showBackend) {
            <mat-list-item>
              <span matListItemTitle>{{ 'settings.serverVersion' | transloco }}</span>
              <span class="meta">{{ serverVersion() || '—' }}</span>
            </mat-list-item>
            <mat-list-item>
              <span matListItemTitle>{{ 'settings.backend' | transloco }}</span>
              <span class="meta">{{ backendLabel() || ('settings.notConnected' | transloco) }}</span>
            </mat-list-item>
          }
        </mat-list>
      </div>

      @if (showBackend) {
        <div class="settings-card update-card">
          @if (downloading()) {
            <mat-progress-bar class="update-bar" mode="determinate" [value]="downloadPercent()" />
            <p class="update-readout">{{ downloadReadout() }}</p>
          } @else if (updateError()) {
            <p class="update-error" role="alert">
              {{ 'settings.updateFailed' | transloco: { error: updateError() } }}
            </p>
            <button mat-stroked-button type="button" (click)="update()">
              {{ 'settings.retry' | transloco }}
            </button>
          } @else if (incompatible()) {
            <p class="update-warn">
              {{ 'settings.appIncompatible' | transloco: { version: serverVersion() } }}
            </p>
          } @else if (webUpdateAvailable()) {
            <p class="update-warn">
              {{ 'settings.updateAvailable' | transloco: { version: serverWebVersion() } }}
            </p>
            <button mat-flat-button color="primary" type="button" (click)="update()">
              {{ 'settings.updateBtn' | transloco }}
            </button>
          } @else if (probed()) {
            <p class="update-ok">{{ 'settings.upToDate' | transloco }}</p>
          }
        </div>
      }
    </section>
  `,
  styleUrl: './sub-page.scss',
  styles: [
    `.update-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}
.update-bar {
  margin-top: 4px;
}
.update-readout {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--app-text-secondary);
}
.update-warn,
.update-ok,
.update-error {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
}
.update-warn {
  color: var(--app-warning, #ed6c02);
}
.update-ok {
  color: var(--app-success, #2e7d32);
}
.update-error {
  color: var(--app-danger, #e53935);
}`,
  ],
})
export class SettingsAboutComponent {
  private readonly shellUpdate = inject(ShellUpdateService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly transloco = inject(TranslocoService);
  private readonly destroyRef = inject(DestroyRef);

  readonly appVersion = appVersion;
  /** The version + update rows are only meaningful under Tauri (where the origin/server is configured). */
  readonly showBackend = isTauri();
  /** The live update-status probe (local + server versions + derived flags), or null before first probe. */
  private readonly status = this.shellUpdate.updateStatus;
  /** Byte-progress state for the inline download bar, fed by the `web-download-progress` Tauri event. */
  private readonly downloadReceived = signal(0);
  private readonly downloadTotal = signal<number | null>(null);
  readonly downloading = signal(false);
  readonly updateError = signal('');

  readonly shellVersion = computed(() => this.status()?.shellVersion ?? '');
  readonly serverVersion = computed(() => this.status()?.serverVersion ?? '');
  readonly serverWebVersion = computed(() => this.status()?.serverWebVersion ?? '');
  /** True once at least one probe has completed (so "up to date" only shows after we actually checked). */
  readonly probed = computed(() => this.status() !== null);
  readonly incompatible = computed(() => this.status()?.incompatible ?? false);
  readonly webUpdateAvailable = computed(() => this.status()?.webUpdateAvailable ?? false);
  readonly backendLabel = computed(() => {
    const o = apiOrigin();
    return o && !apiOriginIsEmpty() ? o : null;
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
  }

  /** Subscribe to `web-download-progress` once; the handler ignores events outside a download. */
  private registerProgressListener(): void {
    void (async () => {
      const unlisten = await listenEvent<DownloadProgress>('web-download-progress', (e) => {
        if (!this.downloading()) return;
        this.downloadReceived.set(e.payload.received);
        this.downloadTotal.set(e.payload.total);
      });
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
