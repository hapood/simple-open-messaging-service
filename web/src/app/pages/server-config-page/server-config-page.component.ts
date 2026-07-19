import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  DestroyRef,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { BrandLogoComponent } from '../../components/brand-logo/brand-logo.component';
import { ConfigService } from '../../services/config.service';
import { PushService } from '../../services/push.service';
import {
  apiOrigin,
  canonicalOrigin,
  originIsInsecure,
  setApiOrigin,
  tauriInvoke,
} from '../../services/runtime';
import { RouteService, RoutePage } from '../../services/route.service';

/** The connect flow phase — surfaced as a determinate progress value + a step label. No `download`
 *  phase on connect: the SPA is bundled in the APK, so first-run/reconfigure only runs compat + cert +
 *  persist-origin. OTA bundle updates are a separate, post-connect probe (Settings → About). */
type Phase = 'form' | 'compat' | 'cert' | 'done';

/**
 * The in-SPA backend-config page (`/config`) — the single surface for first-run setup AND reconfigure.
 * Replaces the former bundled `shell-config` bootstrap (eliminated along with the `somsapp://` scheme).
 * Reached: first-run (landed here by the `guestGuard` when `apiOriginIsEmpty()`), reconfigure (the login
 * page's "Server settings" entry). On save it runs the 3 Rust steps — `init_check_compat` →
 * `init_validate_cert` → `setApiOrigin` (persists origin to the Rust config + SomsSecureStore + the live
 * `apiOrigin` signal) — then redirects to login. No `handoff_to_spa` / window swap (one window, one origin).
 *
 * Owns the Android hardware-back button while active (overrides the SPA nav-state-machine's handler, which
 * is restored on destroy): reconfigure → return to login; first-run (no origin yet) → double-back-to-exit.
 */
@Component({
  selector: 'app-server-config-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    TranslocoModule,
    BrandLogoComponent,
  ],
  templateUrl: './server-config-page.component.html',
  styleUrl: './server-config-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerConfigPageComponent {
  private readonly route = inject(RouteService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly snackBar = inject(MatSnackBar);
  private readonly transloco = inject(TranslocoService);
  private readonly config = inject(ConfigService);
  private readonly push = inject(PushService);
  /** Saved SPA nav-state `__SOMS_BACK__` to restore when this page is left. */
  private prevBack: typeof window.__SOMS_BACK__ = window.__SOMS_BACK__;
  /** Arming timer for the double-back-to-exit pattern (first-run only); cleared on destroy. */
  private backExitTimer: ReturnType<typeof setTimeout> | null = null;

  readonly url = new FormControl(canonicalOrigin(apiOrigin()), {
    nonNullable: true,
    // `required` rejects empty; the pattern rejects scheme-less input (e.g. "192.168.1.10:3000") so the
    // user is guided inline instead of sending a bare host to Rust and getting an opaque failure.
    validators: [Validators.required, Validators.pattern(/^https?:\/\//i)],
  });
  readonly phase = signal<Phase>('form');
  /** The live origin value the insecure-warning reacts to (separate from the control so the warning can
   *  show before the control is considered touched). */
  readonly origin = signal(canonicalOrigin(apiOrigin()));
  /** "Press back again to exit" hint (first-run only — reconfigure returns to login on a single back). */
  readonly exitHint = signal(false);
  /** Whether the visible top-left back button shows (reconfigure only — a backend is already configured,
   *  so there is a login page to return to). First-run hides it (hardware back does double-back-to-exit).
   *  Authoritative: queries Rust's `is_origin_configured` (the persisted file), NOT the secureStore-seeded
   *  signal — the two can drift on a device that configured via an older build, which would wrongly show
   *  the back button on a true first-run. */
  readonly isReconfigure = signal(false);
  readonly canGoBack = computed(() => this.isReconfigure());
  readonly busy = computed(() => this.phase() !== 'form');
  readonly insecure = computed(() => originIsInsecure(this.origin()));
  private readonly progressByPhase: Record<Phase, number> = {
    form: 0,
    compat: 40,
    cert: 80,
    done: 100,
  };
  readonly progress = computed(() => this.progressByPhase[this.phase()]);
  /** transloco key for the current step label (empty when on the form). */
  readonly stepKey = computed(() => {
    switch (this.phase()) {
      case 'compat':
        return 'serverConfig.stepCompat';
      case 'cert':
        return 'serverConfig.stepCert';
      case 'done':
        return 'serverConfig.stepDone';
      default:
        return '';
    }
  });

  constructor() {
    this.url.valueChanges.subscribe((v) => this.origin.set(v));
    // Authoritative first-run vs reconfigure detection (drives the back button): is_origin_configured is
    // true iff a backend has been configured (persisted origin != the non-routable placeholder).
    void tauriInvoke<boolean>('is_origin_configured')
      .then((c) => this.isReconfigure.set(c))
      .catch(() => {});
    this.installBackHandler();
    this.destroyRef.onDestroy(() => {
      if (this.backExitTimer) clearTimeout(this.backExitTimer);
      window.__SOMS_BACK__ = this.prevBack;
    });
  }

  /** Run the connect steps. Bound to the form's NATIVE `submit` event (this component imports only
   *  ReactiveFormsModule, so no `NgForm` attaches and `(ngSubmit)` would be a dead binding; a
   *  `type="submit"` button would otherwise trigger a native GET reload, swallowing every error).
   *  `preventDefault()` stops that so `save()` runs; any failure is surfaced as a transient toast and
   *  the form stays mounted for an edit-and-retry (no reflow). */
  async save(event?: Event): Promise<void> {
    event?.preventDefault();
    // A connect flow is in flight — ignore re-submits (Enter) that would race it on setApiOrigin + redirect.
    if (this.busy()) return;
    const raw = canonicalOrigin(this.url.value);
    if (!raw) {
      this.url.markAsTouched();
      return;
    }
    try {
      this.phase.set('compat');
      await tauriInvoke('init_check_compat', { origin: raw });
      this.phase.set('cert');
      await tauriInvoke('init_validate_cert', { origin: raw });
      // Persist origin: Rust config file + ProxyState + SomsSecureStore + the live apiOrigin signal (so
      // HttpClient/SSE pick up the new host with no reload). setApiOrigin throws outside Tauri, but this
      // page is only reachable under the Tauri shell (canMatch in the route).
      await setApiOrigin(raw);
      // The new server may publish a different Firebase project (or none) — re-sync the native FCM client
      // config so the Android shell re-binds FirebaseApp before login. Fire-and-forget: best-effort, never
      // blocks the redirect, self-gates to Android. (A reconfigure mints a new token that the existing
      // __SOMS_FCM_TOKEN__ → register() pipe will POST to the new origin, pre-login 401 retried on onLogin.)
      void this.push.refreshFirebaseConfig();
      // The backend changed → invalidate the cached /config so the login page re-fetches loginMode /
      // registrationOpen against the NEW backend. ensureLoaded would otherwise return the stale settled
      // promise for the whole session. Fired before the redirect so the login page's own ensureLoaded()
      // shares this fresh in-flight promise the instant it mounts.
      void this.config.reload();
      this.phase.set('done');
      // replaceUrl keeps auth-flow history flat — first-run has nowhere legitimate to go back to.
      this.route.redirect(RoutePage.AUTH_LOGIN);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('server-config connect failed', msg);
      // Friendly category message as a bottom toast (Material MatSnackBar); the raw detail is logged
      // above for debugging. The form stays on 'form' so the user can edit + retry with no layout swap.
      this.snackBar.open(
        this.transloco.translate(this.errorKeyFor(e)),
        this.transloco.translate('common.ok'),
        { duration: 6000, horizontalPosition: 'center', verticalPosition: 'bottom' },
      );
      this.phase.set('form');
    }
  }

  /** Map the failing step → the matching i18n error key (the step that threw is the current phase). */
  private errorKeyFor(e: unknown): string {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    // Can't reach the server, or the URL isn't a SOMS backend. The Rust compat probe tags these `address:`
    // so a dead port reports "invalid address", NOT a version mismatch.
    if (msg.includes('address:')) return 'serverConfig.addrErr';
    if (msg.includes('compat') || msg.includes('too old') || msg.includes('not compatible')) {
      return 'serverConfig.compatErr';
    }
    if (msg.includes('cert') || msg.includes('self-signed') || msg.includes('expired')) {
      return 'serverConfig.certErr';
    }
    return 'serverConfig.connectErr';
  }

  /** Visible top-left back affordance (reconfigure only — hidden on first run). Same effect as the
   *  hardware-back reconfigure branch: return to login. */
  goBack(): void {
    this.route.redirect(RoutePage.AUTH_LOGIN);
  }

  /** Own `window.__SOMS_BACK__` while active (MainActivity evals it on hardware-back). Two modes:
   *   - Reconfigure (an origin is set): a single back returns to login (replaceUrl keeps history flat).
   *   - First-run (no origin): double-back-to-exit — a first back arms a 2s "press back again to exit"
   *     hint; a second back within it exits the app via window.SomsBack.exit(). */
  private installBackHandler(): void {
    window.__SOMS_BACK__ = () => {
      if (this.canGoBack()) {
        this.route.redirect(RoutePage.AUTH_LOGIN);
        return;
      }
      if (this.exitHint()) {
        this.exitHint.set(false);
        window.SomsBack?.exit();
        return;
      }
      this.exitHint.set(true);
      if (this.backExitTimer) clearTimeout(this.backExitTimer);
      this.backExitTimer = setTimeout(() => this.exitHint.set(false), 2000);
    };
  }
}
