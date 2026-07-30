import { Injectable, signal } from '@angular/core';
import {
  apiOriginIsEmpty,
  getActiveApiOrigin,
  isTauri,
  tauriInvoke,
} from './runtime';

/** Shape returned by the Rust `init_update_status` command: local + server versions + derived flags. */
export interface ShellUpdateStatus {
  /** The Tauri shell (APK/desktop app) version — CARGO_PKG_VERSION. */
  shellVersion: string;
  /** The backend (server) version this shell is talking to (root package.json, same as /health). The
   *  shell checks compatibility against this (a hard-coded `COMPAT_BACKEND_MAX` upper bound in Cargo). */
  serverVersion: string;
  /** The currently-installed web SPA bundle version (`web/active.json`). Display only — not compared. */
  installedWebVersion: string;
  /** The web SPA version the server's current manifest advertises. Display only — not compared. */
  serverWebVersion: string;
  /** This shell can't run this backend (server version >= the shell's `COMPAT_BACKEND_MAX`). Tauri can't
   *  self-update its binary, so the only remedy is a newer shell → prompt "contact admin". */
  incompatible: boolean;
  /** The server advertises a web bundle whose SHA-256 differs from the installed one → a web update is
   *  available. */
  webUpdateAvailable: boolean;
}

/**
 * Client update probe for the Tauri shell. The shell ships WITHOUT the main web bundled; it is
 * downloaded + sha256-verified at first run (the `init` window). On every later launch the SPA calls
 * `check()` in the background: it asks Rust `init_update_status` for the local + server versions + the
 * derived `incompatible` / `webUpdateAvailable` flags — WITHOUT auto-downloading. The result is exposed
 * as `updateStatus` for Settings→About to render the prompt and trigger a manual, user-initiated download
 * (`downloadUpdate`), and for the app shell to surface a once-per-launch incompatibility dialog.
 *
 * Update detection is hash-based (installed bundle hash vs. the server manifest's sha256), not
 * version-string-based. A shell incompatibility can never be auto-fixed (Tauri can't replace its own
 * binary), so `incompatible` is surfaced as "contact your admin" only. Silent on any failure (offline /
 * server down / manifest missing): `updateStatus` stays as-is and the cached bundle keeps the app usable.
 * No-op outside the Tauri shell (the browser build is served same-origin; updates are the PWA
 * `UpdateService`, a separate flow).
 */
@Injectable({ providedIn: 'root' })
export class ShellUpdateService {
  /** The latest update-status probe, or null before the first probe / outside the Tauri shell. */
  readonly updateStatus = signal<ShellUpdateStatus | null>(null);
  /** Origin used by the latest successful probe (also drives Settings → About's backend label). */
  readonly probedOrigin = signal('');

  /** Background probe (called on launch): fill `updateStatus`, never auto-download. */
  async check(): Promise<void> {
    if (!isTauri() || apiOriginIsEmpty()) return;
    try {
      const origin = await getActiveApiOrigin();
      this.updateStatus.set(
        await tauriInvoke<ShellUpdateStatus>('init_update_status', { origin }),
      );
      this.probedOrigin.set(origin);
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
    const origin = await getActiveApiOrigin();
    await tauriInvoke('init_download_web', { origin });
    // Refresh so About flips from "update available" to "up to date" after the install.
    await this.check();
  }
}
