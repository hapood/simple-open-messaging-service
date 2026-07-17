import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { apiOrigin, apiOriginIsEmpty, isTauri, tauriInvoke } from './runtime';

/**
 * Dynamic web-update probe for the Tauri shell. The shell ships WITHOUT the main web bundled; it is
 * downloaded + Ed25519-verified at first run (the `init` window). On every later launch the SPA (the
 * `main` window) calls this in the background: if the server's current manifest advertises a newer
 * bundle than the locally-installed one, it downloads + installs it (Rust `init_download_web`, atomic
 * swap of `web/active`) and prompts the user to reload — the running SPA still executes the OLD version
 * until the reload re-resolves `somsapp://localhost/index.html` to the new active bundle's index.html.
 *
 * Silent on any failure (offline / server down / manifest missing): a cached bundle keeps the app fully
 * usable. No-op outside the Tauri shell (the browser build is served same-origin; updates are the PWA
 * `UpdateService`, a separate flow).
 */
@Injectable({ providedIn: 'root' })
export class ShellUpdateService {
  private readonly snackBar = inject(MatSnackBar);

  async check(): Promise<void> {
    if (!isTauri() || apiOriginIsEmpty()) return;
    const origin = apiOrigin();
    try {
      const probe = await tauriInvoke<{ updateAvailable: boolean; newVersion?: string }>(
        'init_check_update',
        { origin },
      );
      if (!probe.updateAvailable) return;
      await tauriInvoke('init_download_web', { origin });
      this.promptReload();
    } catch (e) {
      // Offline / server down / manifest missing — the locally-cached bundle keeps the app usable.
      console.warn('shell web update check failed', e);
    }
  }

  private promptReload(): void {
    const ref = this.snackBar.open('A new version was downloaded.', 'Reload', { duration: 10000 });
    ref.onAction().subscribe(() => location.reload());
  }
}
