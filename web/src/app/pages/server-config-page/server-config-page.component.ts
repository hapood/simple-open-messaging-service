import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  DestroyRef,
  ViewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslocoModule } from '@jsverse/transloco';
import { BrandLogoComponent } from '../../components/brand-logo/brand-logo.component';
import { ConfigService } from '../../services/config.service';
import { PushService, type FirebaseClientConfigPayload } from '../../services/push.service';
import {
  apiOrigin,
  canonicalOrigin,
  listenEvent,
  originIsInsecure,
  setApiOrigin,
  setApiOriginSecondary,
  tauriInvoke,
} from '../../services/runtime';
import { RouteService, RoutePage } from '../../services/route.service';
import { AuthViewportDirective } from '../../directives/auth-viewport.directive';

/** The connect flow phase — surfaced as a progress value + a step label. After compat + cert the installed
 *  web bundle's hash is compared to the server's manifest; if they differ (or none is installed yet) the
 *  bundle is downloaded + swapped as a `download` phase, then the page reloads — the running SPA is the old
 *  build, so only a reload surfaces the freshly-installed one. */
type Phase = 'form' | 'compat' | 'cert' | 'download' | 'done';

/**
 * The in-SPA backend-config page (`/config`) — the single surface for first-run setup AND reconfigure.
 * Replaces the former bundled `shell-config` bootstrap (eliminated along with the `somsapp://` scheme).
 * Reached: first-run (landed here by the `guestGuard` when `apiOriginIsEmpty()`), reconfigure (the login
 * page's "Server settings" entry). On save it runs `init_check_compat` → `init_validate_cert` → a hash
 * check (`init_update_status`); if the server advertises a web bundle whose sha256 differs from the
 * installed one it downloads + swaps it (`init_download_web`) and reloads, otherwise it persists the origin
 * (`setApiOrigin` → Rust config + SomsSecureStore + the live `apiOrigin` signal) and redirects to login.
 * No `handoff_to_spa` / window swap (one window, one origin).
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
    AuthViewportDirective,
  ],
  templateUrl: './server-config-page.component.html',
  styleUrl: './server-config-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerConfigPageComponent {
  private readonly route = inject(RouteService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly config = inject(ConfigService);
  private readonly push = inject(PushService);
  /** The most recent /shell/compat firebaseConfig probed for the origin being connected — applied to native
   *  in finalize() (Android: re-inits FirebaseApp). Stashed so the auto-fill confirm-modal path applies it too. */
  private firebaseConfig: FirebaseClientConfigPayload | null = null;
  /** Saved SPA nav-state `__SOMS_BACK__` to restore when this page is left. */
  private prevBack: typeof window.__SOMS_BACK__ = window.__SOMS_BACK__;
  /** Arming timer for the double-back-to-exit pattern (first-run only); cleared on destroy. */
  private backExitTimer: ReturnType<typeof setTimeout> | null = null;
  @ViewChild('serverInput') private serverInput?: ElementRef<HTMLInputElement>;

  readonly url = new FormControl(canonicalOrigin(apiOrigin()), {
    nonNullable: true,
    // `required` rejects empty; the pattern rejects scheme-less input (e.g. "192.168.1.10:3000") so the
    // user is guided inline instead of sending a bare host to Rust and getting an opaque failure.
    validators: [Validators.required, Validators.pattern(/^https?:\/\//i)],
  });
  /** Pending second-server confirmation. The second endpoint is server-advertised configuration, never a
   *  user-authored field: showing the exact address and asking for consent avoids both jargon and typos. */
  readonly autoFill = signal<{ primary: string; lan: string | null; reachable: string } | null>(null);
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
  readonly titleKey = computed(() =>
    this.isReconfigure() ? 'serverConfig.reconfigureTitle' : 'serverConfig.firstRunTitle',
  );
  readonly introKey = computed(() =>
    this.isReconfigure() ? 'serverConfig.reconfigureHint' : 'serverConfig.firstRunHint',
  );
  readonly actionKey = computed(() =>
    this.isReconfigure() ? 'serverConfig.switchServer' : 'serverConfig.connectContinue',
  );
  readonly errorKey = signal<string | null>(null);
  readonly errorDetail = signal('');

  canSubmit(): boolean {
    return this.url.value.trim().length > 0;
  }
  readonly insecure = computed(() => originIsInsecure(this.origin()));
  /** Byte-progress for the `download` phase, fed by the `web-download-progress` Tauri event. `total` is
   *  null until the first chunk carries a Content-Length (or for a chunked transfer with none) — the bar
   *  goes indeterminate in that window (see {@link progressMode}). */
  private readonly downloadReceived = signal(0);
  private readonly downloadTotal = signal<number | null>(null);
  private readonly progressByPhase: Record<Exclude<Phase, 'download'>, number> = {
    form: 0,
    compat: 40,
    cert: 80,
    done: 100,
  };
  /** Overall connect progress 0–100. During `download` the bundle's byte-progress is mapped onto the
   *  80→100 tail so the bar never moves backward across compat→cert→download→done; an unknown total
   *  (chunked) holds at the cert boundary while {@link progressMode} flips the bar to indeterminate. */
  readonly progress = computed(() => {
    const phase = this.phase();
    if (phase === 'download') {
      const total = this.downloadTotal();
      if (!total || total <= 0) return 80;
      const bytePct = Math.min(100, Math.round((this.downloadReceived() / total) * 100));
      return 80 + Math.round(bytePct * 0.2);
    }
    return this.progressByPhase[phase];
  });
  /** Indeterminate while a download has no Content-Length; determinate otherwise (including every
   *  non-download phase, which uses the discrete {@link progress} values). */
  readonly progressMode = computed<'determinate' | 'indeterminate'>(() => {
    const total = this.downloadTotal();
    return this.phase() === 'download' && (!total || total <= 0) ? 'indeterminate' : 'determinate';
  });
  readonly downloadProgressText = computed(() => {
    if (this.phase() !== 'download') return '';
    const total = this.downloadTotal();
    if (!total) return '';
    const received = Math.min(this.downloadReceived(), total);
    const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round((received / total) * 100)}% · ${mb(received)} / ${mb(total)}`;
  });
  /** transloco key for the current step label (empty when on the form). */
  readonly stepKey = computed(() => {
    switch (this.phase()) {
      case 'compat':
        return 'serverConfig.stepCompat';
      case 'cert':
        return 'serverConfig.stepCert';
      case 'download':
        return 'serverConfig.stepDownload';
      case 'done':
        return 'serverConfig.stepDone';
      default:
        return '';
    }
  });

  constructor() {
    this.url.valueChanges.subscribe((v) => {
      this.origin.set(v);
      this.errorKey.set(null);
      this.errorDetail.set('');
    });
    // Authoritative first-run vs reconfigure detection (drives the back button): is_origin_configured is
    // true iff a backend has been configured (persisted origin != the non-routable placeholder).
    void tauriInvoke<boolean>('is_origin_configured')
      .then((c) => this.isReconfigure.set(c))
      .catch(() => {});
    this.installBackHandler();
    this.registerDownloadProgress();
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
    // A connect flow is in flight OR the modal is up — ignore re-submits (Enter) that would race it.
    if (this.busy() || this.autoFill()) return;
    if (!this.canSubmit()) {
      this.url.markAsTouched();
      queueMicrotask(() => this.serverInput?.nativeElement.focus());
      return;
    }
    const primaryRaw = this.url.value.trim() ? canonicalOrigin(this.url.value) : null;
    if (!primaryRaw || this.url.invalid) {
      this.url.markAsTouched();
      queueMicrotask(() => this.serverInput?.nativeElement.focus());
      return;
    }
    try {
      this.phase.set('compat');
      const probe = await this.probe(primaryRaw);
      if (!probe.ok) {
        this.fail(probe.error);
        return;
      }
      // Stash the probed Firebase client config (same for primary + lan — one backend) so finalize() applies
      // it to native regardless of which path reaches finalize (direct save or the auto-fill confirm modal).
      this.firebaseConfig = probe.firebaseConfig ?? null;
      const primary = probe.primary ? canonicalOrigin(probe.primary) : primaryRaw;
      const second = probe.lan ? canonicalOrigin(probe.lan) : null;
      if (second && second !== primary) {
        this.phase.set('form');
        this.autoFill.set({ primary, lan: second, reachable: primaryRaw });
        return;
      }
      await this.finalize(primary, null, primaryRaw);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Run compat + cert at `origin`. Returns the compat body (primaryOrigin/lanOrigin for auto-fill) on
   *  success, or the captured error on failure (the caller tries the other origin / surfaces it). */
  private async probe(
    origin: string,
  ): Promise<
    | { ok: true; primary?: string | null; lan?: string | null; firebaseConfig?: FirebaseClientConfigPayload | null }
    | { ok: false; error: unknown }
  > {
    try {
      const compat = await tauriInvoke<{
        primaryOrigin?: string | null;
        lanOrigin?: string | null;
        firebaseConfig?: FirebaseClientConfigPayload | null;
      }>('init_check_compat', { origin });
      this.phase.set('cert');
      await tauriInvoke('init_validate_cert', { origin });
      return { ok: true, primary: compat.primaryOrigin, lan: compat.lanOrigin, firebaseConfig: compat.firebaseConfig ?? null };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  /** Persist both origins + run the OTA hash check + reload/redirect. `reachable` is an origin that just
   *  validated (used for the bundle probe — same backend ⇒ same hash regardless of which). */
  private async finalize(primary: string, lan: string | null, reachable: string): Promise<void> {
    try {
      // Compare the installed web bundle's hash to the server's manifest. On a first run there is no
      // installed hash yet, so the fresh bundle is pulled as part of connecting. A failed probe resolves to
      // false → skip + proceed in-page; the launch-time About probe catches it later.
      const status = await tauriInvoke<{ webUpdateAvailable: boolean }>('init_update_status', {
        origin: reachable,
      });
      if (status?.webUpdateAvailable) {
        this.phase.set('download');
        this.downloadReceived.set(0);
        this.downloadTotal.set(null);
        // init_download_web streams + sha256-verifies + extracts + swaps the served assets. setApiOrigin +
        // setApiOriginSecondary sync the live signals + secureStore so the mandatory reload seeds both. The
        // reload is required: the running SPA is the OLD build, so only a reload surfaces the new bundle.
        await tauriInvoke('init_download_web', { origin: reachable });
        await setApiOrigin(primary);
        await setApiOriginSecondary(lan);
        // Apply the server's Firebase client config to native BEFORE the reload. `SomsFcm.setFirebaseConfig`
        // persists + (re)initializes FirebaseApp in the shell, and that state survives the webview reload
        // (boot's PushService.init deliberately does NOT re-apply it; the cold-start `SomsApplication`
        // reader only recovers what was already persisted). This download branch is the FIRST-RUN path, so
        // omitting it leaves native Firebase unconfigured → no FCM token → no push until a later reconfigure.
        // `config.reload()` is intentionally NOT called here: a full reload discards the in-memory cache, so
        // the fresh SPA re-fetches /config on the login page regardless.
        this.push.applyFirebaseConfig(this.firebaseConfig);
        this.phase.set('done');
        // Reload to login, NOT the current /config URL — otherwise the booted SPA matches /config (which has
        // no guard to leave once the origin is configured) and remounts this page, forcing a second click.
        // reloadTo resolves the login path via the Router and `location.replace`s, so there's no stale
        // /config history entry to back into.
        this.route.reloadTo(RoutePage.AUTH_LOGIN);
        return;
      }
      // Up to date (or probe skipped): persist both origins and proceed in-page to login.
      await setApiOrigin(primary);
      await setApiOriginSecondary(lan);
      // The new server may publish a different Firebase project — apply its /shell/compat firebaseConfig to
      // native so the Android shell re-inits FirebaseApp. The backend changed → invalidate the cached /config
      // so login re-fetches loginMode/registrationOpen.
      this.push.applyFirebaseConfig(this.firebaseConfig);
      void this.config.reload();
      this.phase.set('done');
      this.route.redirect(RoutePage.AUTH_LOGIN);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Modal confirm → finalize with the auto-filled pair. */
  async confirmAutoFill(): Promise<void> {
    const af = this.autoFill();
    if (!af) return;
    this.autoFill.set(null);
    await this.finalize(af.primary, af.lan, af.reachable);
  }

  /** Continue with only the primary endpoint when the user declines the advertised second server. */
  async cancelAutoFill(): Promise<void> {
    const af = this.autoFill();
    if (!af) return;
    this.autoFill.set(null);
    await this.finalize(af.primary, null, af.reachable);
  }

  /** Surface a connect/OTA failure as a categorized toast + reset to the form for an edit-and-retry. */
  private fail(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('server-config connect failed', msg);
    this.errorKey.set(this.errorKeyFor(e));
    this.errorDetail.set(msg);
    this.phase.set('form');
    queueMicrotask(() => this.serverInput?.nativeElement.focus());
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
    // Bundle download / integrity / extract failures from `init_download_web` (sha256 mismatch, network
    // read, tar extract). The server WAS reached (compat + cert already passed), so this is distinct from
    // `connectErr`.
    if (
      msg.includes('sha256') ||
      msg.includes('download') ||
      msg.includes('extract') ||
      msg.includes('bundle')
    ) {
      return 'serverConfig.downloadErr';
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

  /** Subscribe once to the Rust `web-download-progress` stream so the `download` phase drives a real
   *  byte-progress bar. The handler ignores events outside the download phase, so a single registration
   *  covers every retry without leaking a listener. */
  private registerDownloadProgress(): void {
    void (async () => {
      const unlisten = await listenEvent<{ received: number; total: number | null }>(
        'web-download-progress',
        (e) => {
          if (this.phase() !== 'download') return;
          this.downloadReceived.set(e.payload.received);
          this.downloadTotal.set(e.payload.total);
        },
      );
      if (unlisten) this.destroyRef.onDestroy(unlisten);
    })();
  }
}
