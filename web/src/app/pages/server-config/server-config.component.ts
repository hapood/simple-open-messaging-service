import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { apiOrigin, setApiOrigin } from '../../services/runtime';

/**
 * Bundled-APK backend-URL configuration (Tauri/Android only — the route is `canMatch`-gated on
 * `isTauri()`). A phone running the APK can't reach the `http://localhost:3000` build default, so the
 * user sets the real backend origin here. The value is persisted Rust-side (app-data config file) and
 * re-injected before Angular boots on the next launch; after save we hard-reload so `apiOrigin`
 * (captured once at module load) and every derived apiPrefix/sseUrl/media URL re-resolve.
 *
 * First-run gating: `guestGuard` redirects here when `isTauri() && apiOriginIsLocalhost()` (no server
 * configured yet). Reachable later from the login page's "Server settings" link to re-point the app.
 */
@Component({
  selector: 'app-server-config',
  templateUrl: './server-config.component.html',
  styleUrl: './server-config.component.scss',
})
export class ServerConfigComponent {
  private readonly router = inject(Router);

  /** Pre-fill with the origin Rust injected at boot (persisted value, or the localhost default). */
  readonly url = signal(apiOrigin);
  readonly saving = signal(false);
  readonly errorMsg = signal<string | null>(null);

  async save(): Promise<void> {
    const value = this.url().trim();
    if (!/^https?:\/\//i.test(value)) {
      this.errorMsg.set('Enter a full URL, e.g. http://192.168.1.10:3000 or https://api.example.com');
      return;
    }
    this.saving.set(true);
    this.errorMsg.set(null);
    try {
      await setApiOrigin(value);
      // Rust persisted + updated the proxy. Reload so module-load constants re-resolve to the new origin.
      location.reload();
    } catch (e) {
      this.saving.set(false);
      this.errorMsg.set(e instanceof Error ? e.message : String(e));
    }
  }

  /** Back to login. If the origin is still the localhost default, guestGuard bounces back here — which
   *  is the correct behavior (you can't log in without a reachable server). */
  cancel(): void {
    this.router.navigate(['/auth/login']);
  }
}
