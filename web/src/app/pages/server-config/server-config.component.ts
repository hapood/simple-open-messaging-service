import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormControl,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { apiOrigin, setApiOrigin } from '../../services/runtime';

/**
 * Bundled-APK backend-URL configuration (Tauri/Android only — the route is `canMatch`-gated on
 * `isTauri()`). A phone running the APK can't reach the `http://localhost:3000` build default, so the
 * user sets the real backend origin here. The value is persisted Rust-side (app-data config file) and
 * re-injected before Angular boots on the next launch; after save we full-load to /auth/login so
 * `apiOrigin` (captured once at module load) and every derived apiPrefix/sseUrl/media URL re-resolve.
 *
 * First-run gating: `guestGuard` redirects here when `isTauri() && apiOriginIsLocalhost()` (no server
 * configured yet). Reachable later from the login page's "Server settings" Material button.
 *
 * Connection probe: a two-stage pre-flight check against the CANDIDATE url (the typed value, not the
 * committed `apiOrigin`) — see {@link testConnection}. Lets the user verify "this URL really is a SOMS
 * backend I can reach" before committing it or typing credentials.
 */
type ProbeStatus = 'idle' | 'testing' | 'ok' | 'warn' | 'notsoms' | 'fail';

/** Validator: must parse as an http(s) URL with a host. */
function urlValidator(control: AbstractControl): ValidationErrors | null {
  const v = (control.value ?? '').trim();
  if (!v) return null; // "required" is flagged by Validators.required; don't double-flag here.
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host ? null : { url: true };
  } catch {
    return { url: true };
  }
}

@Component({
  selector: 'app-server-config',
  imports: [
    ReactiveFormsModule,
    TranslocoPipe,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    AuthBrandComponent,
    AuthToolbarComponent,
    IconComponent,
  ],
  templateUrl: './server-config.component.html',
  styleUrl: './server-config.component.scss',
})
export class ServerConfigComponent {
  private readonly routeService = inject(RouteService);
  private readonly destroyRef = inject(DestroyRef);

  readonly AppIcon = AppIconType;

  /** Pre-filled with the origin Rust injected at boot (persisted value, or the localhost default). */
  readonly urlControl = new FormControl(apiOrigin, {
    nonNullable: true,
    validators: [Validators.required, urlValidator],
  });

  readonly saving = signal(false);
  readonly testing = signal(false);
  /** Outcome of the last connection probe; 'idle' before the first probe. */
  readonly status = signal<ProbeStatus>('idle');
  /** Server version reported by the probe (shown on success). */
  readonly version = signal<string | null>(null);
  /** Save-time failure text (Rust rejected the URL); cleared on the next edit. */
  readonly saveError = signal<string | null>(null);

  constructor() {
    // Editing the URL invalidates any prior probe result + any save error.
    this.urlControl.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.status() !== 'idle') this.status.set('idle');
      if (this.saveError()) this.saveError.set(null);
    });
  }

  /** Whether the status pill should render — every state but 'idle' (testing + all terminal outcomes). */
  readonly showStatus = computed(() => this.status() !== 'idle');

  /** transloco key for the status pill text (reuses 'serverConfig.testing' for the in-flight state). */
  readonly statusKey = computed<string>(() => {
    switch (this.status()) {
      case 'testing':
        return 'serverConfig.testing';
      case 'ok':
        return 'serverConfig.statusOk';
      case 'warn':
        return 'serverConfig.statusWarn';
      case 'notsoms':
        return 'serverConfig.statusNotSoms';
      case 'fail':
        return 'serverConfig.statusFail';
      default:
        return '';
    }
  });

  /** Leading icon for the status pill (CHECK on success, CLOSE on any failure). */
  readonly statusIcon = computed<AppIconType | null>(() => {
    switch (this.status()) {
      case 'ok':
        return AppIconType.CHECK;
      case 'warn':
      case 'notsoms':
      case 'fail':
        return AppIconType.CLOSE;
      default:
        return null;
    }
  });

  /** Candidate origin: trimmed, trailing slash(es) stripped — what we both probe and persist. */
  private normalizedUrl(): string {
    return (this.urlControl.value ?? '').trim().replace(/\/+$/, '');
  }

  /**
   * Two-stage reachability + identity probe against the CANDIDATE url (NOT via HttpClient — that is
   * pinned to the committed apiPrefix and would attach a token). Uses raw fetch against the typed
   * origin so the user can verify a URL BEFORE saving it.
   *
   *  1. Reachability (mode:'no-cors'): CORS-immune — the promise resolves (opaque response) iff some
   *     HTTP server answered. A rejection here = host unreachable / refused / timeout → 'fail'.
   *  2. CORS + SOMS identity (default cors): reads the body. A SOMS backend returns our ApiResult
   *     envelope with code===0 and data.status==='ok' → 'ok' (+ version). A reachable non-SOMS server
   *     returns HTML/other JSON → 'notsoms'. A throw here AFTER stage 1 succeeded = the readable
   *     response is CORS-blocked — usually a reverse proxy in front of the backend (the backend itself
   *     reflects any Origin) → 'warn'.
   */
  async testConnection(): Promise<void> {
    if (this.testing() || this.urlControl.invalid) return;
    this.testing.set(true);
    this.status.set('testing');
    this.version.set(null);
    const base = this.normalizedUrl();
    try {
      const res = await this.fetchWithTimeout(`${base}/api/v1/health`, {}, 6000);
      const data = (await res.json().catch(() => null)) as
        | { code?: unknown; data?: { status?: unknown; version?: unknown } }
        | null;
      if (data && data.code === 0 && data.data && data.data.status === 'ok') {
        this.version.set(typeof data.data.version === 'string' ? data.data.version : null);
        this.status.set('ok');
      } else {
        this.status.set('notsoms');
      }
    } catch {
      // Fetch rejects on network error (unreachable) or CORS block. The backend enables CORS
      // (bootstrap.ts enableCors({origin:true})), so a rejection here is effectively "unreachable".
      // NOTE: a `mode:'no-cors'` pre-flight was removed — in the Android WebView (Chrome 114) a
      // cross-origin no-cors fetch rejects with "Failed to fetch" even when the same URL's normal CORS
      // fetch returns 200, so the pre-flight produced false "cannot connect to server" failures.
      this.status.set('fail');
    } finally {
      this.testing.set(false);
    }
  }

  async save(): Promise<void> {
    if (this.saving() || this.urlControl.invalid) return;
    const value = this.normalizedUrl();
    if (!value) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const normalized = await setApiOrigin(value);
      // Stash the new origin for the boot init script to read on reload (see src-tauri/src/lib.rs).
      // Without this the fixed init script re-injects the stale setup-time origin and the guard bounces
      // back here — the "Save loops back to /config" symptom. localStorage is the webview's concern, so
      // it lives here in JS; Rust owns the file + proxy.
      try { localStorage.setItem('__soms_api_origin__', normalized); } catch { /* private mode */ }
      // Rust persisted + updated the proxy. Full-load to /auth/login (not a bare reload, which would
      // re-render /config — the "Save flashes and stays here" symptom): the init script re-reads the
      // stashed origin so the module-load apiOrigin/apiPrefix/sseUrl re-resolve to the new host, and we
      // land on login (origin is now non-localhost, so guestGuard lets it through). replace — not
      // assign — keeps /config out of the history stack (auth-flow history contract).
      location.replace('/auth/login');
    } catch (e) {
      this.saving.set(false);
      this.saveError.set(e instanceof Error ? e.message : String(e));
    }
  }

  /** Back to login via the canonical nav helper (RouteService.redirect uses replaceUrl, like
   *  login-success and logout — so the login↔config toggle never grows the history stack → no Android
   *  hardware-back trap). The first-run nudge is latched once per boot (ServerConfigGateService), so
   *  this reaches login instead of bouncing back to /config. If the origin is still unconfigured, login
   *  just fails to reach the server — the user returns here via the login page's "Server settings" link. */
  cancel(): void {
    this.routeService.redirect(RoutePage.AUTH_LOGIN);
  }

  /** fetch with a hard timeout via AbortController. Rejects on timeout or network error. */
  private fetchWithTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }
}
