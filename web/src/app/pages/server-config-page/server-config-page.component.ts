import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  input,
  OnInit,
  output,
  signal,
  DestroyRef,
  isDevMode,
  ViewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { A11yModule } from '@angular/cdk/a11y';
import { TranslocoModule } from '@jsverse/transloco';
import { BrandLogoComponent } from '../../components/brand-logo/brand-logo.component';
import { MaterialDialogComponent } from '../../components/material-dialog/material-dialog.component';
import { ConfigService } from '../../services/config.service';
import { PushService, type FirebaseClientConfigPayload } from '../../services/push.service';
import {
  apiOrigin,
  canonicalOrigin,
  originIsInsecure,
  pickLoginOrigin,
  setApiOrigin,
  setApiOriginSecondary,
  tauriInvoke,
} from '../../services/runtime';
import { RouteService, RoutePage } from '../../services/route.service';
import { AuthViewportDirective } from '../../directives/auth-viewport.directive';
import { AppBackDispatcherService } from '../../services/app-back-dispatcher.service';

/** Server setup phases. The frontend always comes from the installed app package. */
type Phase = 'form' | 'compat' | 'cert' | 'done';

/**
 * Decide whether the server-advertised origins describe the address the user actually entered.
 *
 * `/client/compat` advertises the deployment's canonical public origin. A user may reach the same server
 * through an unadvertised LAN IP (for example while SOMS_LAN_DOMAIN is unset). In that case the advertised
 * public origin and the just-probed address form the two endpoints: the existing login-time health race
 * can then select whichever one is reachable.
 *
 * When the server already advertises a complete pair, use it if the entered address is one of the pair.
 * Otherwise retain the known-reachable entered address as the fallback instead of discarding it.
 */
export function singleOriginAfterDecliningPair(reachable: string): string {
  return canonicalOrigin(reachable);
}

export function resolveOriginSelection(
  reachable: string,
  advertisedPrimary?: string | null,
  advertisedLan?: string | null,
): { primary: string; lan: string | null; confirmPair: boolean } {
  const entered = canonicalOrigin(reachable);
  const primary = advertisedPrimary ? canonicalOrigin(advertisedPrimary) : null;
  const lan = advertisedLan ? canonicalOrigin(advertisedLan) : null;
  const enteredIsAdvertised = entered === primary || entered === lan;

  if (enteredIsAdvertised && primary && lan && primary !== lan) {
    return { primary, lan, confirmPair: true };
  }
  if (primary && primary !== entered) {
    return { primary, lan: entered, confirmPair: true };
  }
  return { primary: entered, lan: null, confirmPair: false };
}

/**
 * Shared backend-config surface. First run is mounted by the guarded `/config` startup state as a required,
 * non-dismissible modal over an empty background; an existing configuration opens the same component in
 * the global auth-flow dialog without changing routes. On save it fetches public client config,
 * validates HTTPS certificates, persists the origin, and redirects to login. The SPA is embedded
 * in the installed app package and never downloaded from the server.
 * No `handoff_to_spa` / window swap (one window, one origin).
 *
 * Owns Android Back while active: reconfigure closes the surface; required first-run setup exits the
 * Activity at its root instead of exposing an unusable background.
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
    A11yModule,
    TranslocoModule,
    BrandLogoComponent,
    MaterialDialogComponent,
    AuthViewportDirective,
  ],
  templateUrl: './server-config-page.component.html',
  styleUrl: './server-config-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerConfigPageComponent implements OnInit {
  /** Dialog mode is used when editing an existing configuration from an auth page. */
  readonly dialog = input(false);
  /** Dialog-only dismissal event. First-run route mode never emits it. */
  readonly closed = output<void>();
  private readonly route = inject(RouteService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly config = inject(ConfigService);
  private readonly push = inject(PushService);
  private readonly appBack = inject(AppBackDispatcherService);
  /** The most recent /client/compat firebaseConfig probed for the origin being connected — applied to native
   *  in finalize() (Android: re-inits FirebaseApp). Stashed so the auto-fill confirm-modal path applies it too. */
  private firebaseConfig: FirebaseClientConfigPayload | null = null;
  private unregisterBack?: () => void;
  @ViewChild('serverInput') private serverInput?: ElementRef<HTMLInputElement>;

  readonly url = new FormControl(canonicalOrigin(apiOrigin()), {
    nonNullable: true,
    // `required` rejects empty; the pattern rejects scheme-less input (e.g. "10.0.0.10:3000") so the
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
  /** Whether the visible top-left back button shows (reconfigure only — a backend is already configured,
   *  so there is a login page to return to). First-run hides it (system Back exits the Activity).
   *  Authoritative: queries Rust's `is_origin_configured` (the persisted file), NOT the secureStore-seeded
   *  signal — the two can drift on a device that configured via an older build, which would wrongly show
   *  the back button on a true first-run. */
  readonly isReconfigure = signal(false);
  readonly canGoBack = computed(() => this.dialog() || this.isReconfigure());
  readonly busy = computed(() => this.phase() !== 'form');
  readonly titleKey = computed(() =>
    this.dialog() || this.isReconfigure()
      ? 'serverConfig.reconfigureTitle'
      : 'serverConfig.firstRunTitle',
  );
  readonly introKey = computed(() =>
    this.dialog() || this.isReconfigure()
      ? 'serverConfig.reconfigureHint'
      : 'serverConfig.firstRunHint',
  );
  readonly actionKey = computed(() =>
    this.dialog() || this.isReconfigure()
      ? 'serverConfig.switchServer'
      : 'serverConfig.connectContinue',
  );
  readonly errorKey = signal<string | null>(null);
  readonly errorDetail = signal('');

  canSubmit(): boolean {
    return this.url.value.trim().length > 0;
  }
  readonly insecure = computed(() => originIsInsecure(this.origin()));
  private readonly progressByPhase: Record<Phase, number> = {
    form: 0,
    compat: 40,
    cert: 80,
    done: 100,
  };
  readonly progress = computed(() => this.progressByPhase[this.phase()]);
  readonly progressMode = computed<'determinate'>(() => 'determinate');
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
    this.url.valueChanges.subscribe((v) => {
      this.origin.set(v);
      this.errorKey.set(null);
      this.errorDetail.set('');
    });
    this.destroyRef.onDestroy(() => this.unregisterBack?.());
  }

  ngOnInit(): void {
    // Inputs are available here. Dialog mode is always a reconfiguration flow; route mode asks native
    // storage so the same component can distinguish first run from a legacy direct /config visit.
    if (this.dialog()) {
      this.isReconfigure.set(true);
    } else {
      void tauriInvoke<boolean>('is_origin_configured')
        .then((configured) => this.isReconfigure.set(configured))
        .catch(() => {});
    }
    this.installBackHandler();
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
      const selection = resolveOriginSelection(primaryRaw, probe.primary, probe.lan);
      if (selection.confirmPair && selection.lan) {
        this.phase.set('form');
        this.autoFill.set({
          primary: selection.primary,
          lan: selection.lan,
          reachable: primaryRaw,
        });
        return;
      }
      await this.finalize(selection.primary, null);
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

  /** Persist the configured pair and race every address before entering login. */
  private async finalize(primary: string, lan: string | null): Promise<void> {
    try {
      await setApiOrigin(primary);
      await setApiOriginSecondary(lan);
      const active = await pickLoginOrigin(true);
      if (isDevMode()) {
        console.info('server-config origins selected', {
          primary,
          secondary: lan,
          active,
        });
      }
      // The new server may publish a different Firebase project — apply its /client/compat firebaseConfig to
      // native so the Android shell re-inits FirebaseApp. The backend changed → invalidate the cached /config
      // so login re-fetches loginMode/registrationOpen.
      try {
        this.push.applyFirebaseConfig(this.firebaseConfig);
      } catch (e) {
        console.error('server-config firebase apply failed', e);
      }
      void this.config.reload();
      this.phase.set('done');
      if (isDevMode()) {
        console.info('server-config SPA navigation', { route: RoutePage.AUTH_LOGIN });
      }
      if (this.dialog()) {
        this.closed.emit();
        return;
      }
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
    await this.finalize(af.primary, af.lan);
  }

  /** Keep only the endpoint that was just probed when the user declines the advertised pair. */
  async cancelAutoFill(): Promise<void> {
    const af = this.autoFill();
    if (!af) return;
    this.autoFill.set(null);
    await this.finalize(singleOriginAfterDecliningPair(af.reachable), null);
  }

  /** Match the shared modal dismissal contract on browser/desktop; Android Back is handled through the
   * lifecycle-scoped AppBackDispatcher registration below. */
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (!this.autoFill() && !this.dialog()) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.autoFill()) void this.cancelAutoFill();
    else this.closed.emit();
  }

  /** Surface a connection failure as a categorized toast and reset to the form. */
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
    return 'serverConfig.connectErr';
  }

  /** Visible top-left back affordance (reconfigure only — hidden on first run). Same effect as the
   *  hardware-back reconfigure branch: return to login. */
  goBack(): void {
    if (this.dialog()) {
      this.closed.emit();
      return;
    }
    this.route.redirect(RoutePage.AUTH_LOGIN);
  }

  /** Confirmation closes first; reconfigure returns to login; the required first-run root exits. */
  private installBackHandler(): void {
    this.unregisterBack = this.appBack.register(() => {
      if (this.autoFill()) {
        void this.cancelAutoFill();
        return;
      }
      if (this.canGoBack()) {
        this.goBack();
        return;
      }
      window.SomsBack?.exit();
    });
  }

}
