import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormControl,
  FormGroup,
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
 * `isTauri()`). The user sets the real backend origin here; it is persisted into the platform store
 * (Android EncryptedSharedPreferences via `window.SomsSecureStore`, localStorage on desktop) AND the
 * Rust app-data config file (which feeds the media proxy's Arc). On save, `setApiOrigin` updates the
 * `apiOrigin` signal in place, so every derived apiPrefix/sseUrl/media URL (and the SSE worker's
 * reconnect) picks up the new host with NO reload — we then navigate in-SPA to /auth/login.
 *
 * First-run gating: `guestGuard` redirects here when `isTauri() && apiOriginIsEmpty()` (no server
 * configured yet). Reachable later from the login page's "Server settings" Material button.
 *
 * Connection probe: a single native-fetch reachability + identity check against the CANDIDATE url
 * (the typed value, not the committed `apiOrigin`) — see {@link testConnection}. Under the Tauri
 * shell the probe rides `installNativeFetch()`'s reqwest client, so it reaches the backend with no
 * webview CORS gate. Lets the user verify "this URL really is a SOMS backend I can reach" before
 * committing it or typing credentials.
 */
type ProbeStatus = 'idle' | 'testing' | 'ok' | 'notsoms' | 'fail';

/** The placeholder backend origin pre-filled into the form when none is configured yet — the canonical
 *  SOMS server URL shape (https + the federation port 7667). A UI hint only; it never seeds the
 *  apiOrigin signal (empty = unconfigured), so `apiOriginIsEmpty()` stays true until the user Saves. */
const DEFAULT_FORM_ORIGIN = 'https://soms.example.com:7667';

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

  /** Pre-filled with the live origin, or — when no origin is configured yet — the placeholder
   *  `https://soms.example.com:7667` for the user to edit. The placeholder is a FORM default only; it
   *  never enters the apiOrigin signal (which stays empty until Save persists a real origin). */
  readonly urlControl = new FormControl(apiOrigin() || DEFAULT_FORM_ORIGIN, {
    nonNullable: true,
    validators: [Validators.required, urlValidator],
  });
  /** FormGroup wrapper. `FormGroupDirective` (activated by `[formGroup]` on the `<form>`) is what
   *  intercepts the native `submit` — it preventDefaults AND emits `ngSubmit`. Without it a bare
   *  `[formControl]` provides NO submit interception, so the Save button's `type="submit"` fired a native
   *  GET that reloaded the page (and `save()` never ran). This mirrors the `FormsModule`+`NgForm` pattern
   *  every other form in the app uses; here the reactive validator makes a FormGroup the right fit. */
  readonly form = new FormGroup({ url: this.urlControl });

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
   * Reachability + identity probe against the CANDIDATE url (NOT via HttpClient — that is pinned to
   * the committed apiPrefix and would attach a token). Uses raw `fetch` against the typed origin so
   * the user can verify a URL BEFORE saving it. Under the Tauri shell `globalThis.fetch` is the
   * reqwest-backed native client (see installNativeFetch), so the probe reaches the backend with no
   * webview CORS gate: a SOMS backend returns our ApiResult envelope with code===0 and
   * data.status==='ok' → 'ok' (+ version); a reachable non-SOMS server returns HTML/other JSON →
   * 'notsoms'; a network error (host unreachable / refused / timeout) rejects → 'fail'. The 6 s
   * AbortController bounds a hung host; under Tauri the plugin honors the signal, but the timeout is
   * belt-and-braces regardless of transport.
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
      // Reaches here only on a genuine network failure: host unreachable / connection refused /
      // timeout (the 6 s AbortController) / TLS error. Under the Tauri shell there is no CORS path —
      // the native client never crosses the webview origin — so this is never a CORS block.
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
      // setApiOrigin persists the origin into the platform store (Android EncryptedSharedPreferences /
      // desktop localStorage — the same store the native SSE reads) AND the Rust app-data file (media
      // proxy Arc), and updates the apiOrigin signal in place, so every HttpClient call, the SSE
      // worker's reconnect, and the media proxy already resolve to the new host with NO reload. The
      // origin is now non-empty, so guestGuard lets /auth/login through. Navigate in-SPA
      // (RouteService.redirect is replaceUrl) per the auth-flow history contract — /config never enters
      // the back stack.
      await setApiOrigin(value);
      this.routeService.redirect(RoutePage.AUTH_LOGIN);
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
