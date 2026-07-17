import { Injectable, signal } from '@angular/core';
import { apiOrigin, apiOriginIsEmpty, isTauri, tauriInvoke } from './runtime';

/** Shape returned by the Rust `init_update_status` command: local + server versions + derived flags. */
export interface ShellUpdateStatus {
  /** The Tauri shell (APK/desktop app) version — CARGO_PKG_VERSION. */
  shellVersion: string;
  /** The currently-installed web SPA bundle version (the `web/active` dir on disk). */
  installedWebVersion: string;
  /** The web SPA version the server's current manifest advertises. */
  serverWebVersion: string;
  /** The minimum shell version this server's web bundle requires. */
  minShellVersion: string;
  /** The local shell is older than the server's floor → it cannot run this web bundle; the user must
   *  get a newer shell (Tauri can't self-update its binary) → prompt "contact admin". */
  shellUpdateRequired: boolean;
  /** The server advertises a newer web bundle than the installed one → a web update is available. */
  webUpdateAvailable: boolean;
}

/**
 * Client update probe for the Tauri shell. The shell ships WITHOUT the main web bundled; it is
 * downloaded + sha256-verified at first run (the `init` window). On every later launch the SPA calls
 * `check()` in the background: it asks Rust `init_update_status` for the local + server versions and
 * derives whether a web-bundle update is available — WITHOUT auto-downloading. The result is exposed as
 * `updateStatus` for Settings→About to render the prompt and trigger a manual, user-initiated download
 * (`downloadUpdate`). Non-forcing: the user decides whether to update.
 *
 * A shell update can never be auto-installed (Tauri can't replace its own binary), so a
 * `shellUpdateRequired` status is surfaced as "contact your admin" only. Silent on any failure (offline /
 * server down / manifest missing): `updateStatus` stays as-is and the cached bundle keeps the app usable.
 * No-op outside the Tauri shell (the browser build is served same-origin; updates are the PWA
 * `UpdateService`, a separate flow).
 */
@Injectable({ providedIn: 'root' })
export class ShellUpdateService {
  /** The latest update-status probe, or null before the first probe / outside the Tauri shell. */
  readonly updateStatus = signal<ShellUpdateStatus | null>(null);

  /** Background probe (called on launch): fill `updateStatus`, never auto-download. */
  async check(): Promise<void> {
    if (!isTauri() || apiOriginIsEmpty()) return;
    try {
      this.updateStatus.set(
        await tauriInvoke<ShellUpdateStatus>('init_update_status', { origin: apiOrigin() }),
      );
    } catch (e) {
      // Offline / server down — leave updateStatus as-is; the cached bundle keeps the app usable.
      console.warn('shell update status probe failed', e);
    }
  }

  /**
   * Download + install the latest web bundle (user-initiated from Settings→About). Streams the download;
   * Rust emits `web-download-progress` (the About page subscribes for its progress bar). Resolves on
   * success — the caller then prompts a reload (the RUNNING SPA is still the old build until reload).
   * Rejects with the Rust error on failure.
   */
  async downloadUpdate(): Promise<void> {
    if (!isTauri() || apiOriginIsEmpty()) return;
    await tauriInvoke('init_download_web', { origin: apiOrigin() });
    // Refresh so About flips from "update available" to "up to date" after the install.
    await this.check();
  }
}
