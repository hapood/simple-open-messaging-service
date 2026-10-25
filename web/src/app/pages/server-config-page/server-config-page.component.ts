import {
  EMPTY,
  Observable,
  Subject,
  catchError,
  exhaustMap,
  finalize,
  of,
  switchMap,
  take,
  takeUntil,
} from 'rxjs';
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
import {
  PushService,
  type FirebaseClientConfigPayload,
} from '../../services/push.service';
import {
  prepareServerSetup,
  commitServerSetup,
} from '../../services/server-setup';
import {
  apiOrigin,
  canonicalOrigin,
  originIsInsecure,
  tauriInvoke,
} from '../../services/runtime';
import { RouteService, RoutePage } from '../../services/route.service';
import { AuthViewportDirective } from '../../directives/auth-viewport.directive';
import { AppBackDispatcherService } from '../../services/app-back-dispatcher.service';

/** Server setup phases. The frontend always comes from the installed app package. */
type Phase = 'form' | 'compat' | 'done';

/** Alternate endpoints are accepted only from the server's bootstrap configuration. */
export function resolveOriginSelection(
  reachable: string,
  advertisedPrimary?: string | null,
  advertisedLan?: string | null,
): { primary: string; lan: string | null; confirmPair: boolean } {
  const entered = canonicalOrigin(reachable);
  const primary = advertisedPrimary ? canonicalOrigin(advertisedPrimary) : null;
  const lan = advertisedLan ? canonicalOrigin(advertisedLan) : null;
  const selectedPrimary = primary ?? entered;
  const selectedLan = lan && lan !== selectedPrimary ? lan : null;
  return {
    primary: selectedPrimary,
    lan: selectedLan,
    confirmPair: selectedLan !== null,
  };
}

/**
 * Shared backend-config surface. First run is mounted by the guarded `/config` startup state as a required,
 * non-dismissible modal over an empty background; an existing configuration opens the same component in
 * the global auth-flow dialog without changing routes. On save it fetches public client config,
 * validates HTTPS certificates, persists the origin, and redirects to login. The SPA is embedded
 * in the installed app package and never downloaded from the server.
 * No `handoff_to_spa` / window swap (one window, one origin).
 *
 * One serialized RxJS flow per component instance: submit → verify (cancellable) →
 * optional pair confirmation → commit (never cancelled). Rust rejects overlapping
 * login/configuration operations with an error; nothing is queued here.
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
   *  in commit (Android: re-inits FirebaseApp). */
  private firebaseConfig: FirebaseClientConfigPayload | null = null;
  private unregisterBack?: () => void;
  private readonly submits = new Subject<string>();
  /** Ends the cancellable verification part of the active flow (dismissal / back). */
  private readonly dismissVerify = new Subject<void>();
  /** Resolves the advertised-pair confirmation with the user's decision. */
  private readonly pairDecision = new Subject<boolean>();
  private readonly destroyed = new Subject<void>();
  readonly saving = signal(false);
  @ViewChild('serverInput') private serverInput?: ElementRef<HTMLInputElement>;

  readonly url = new FormControl(canonicalOrigin(apiOrigin()), {
    nonNullable: true,
    // `required` rejects empty; the pattern rejects scheme-less input (e.g. "10.0.0.10:3000") so the
    // user is guided inline instead of sending a bare host to Rust and getting an opaque failure.
    validators: [Validators.required, Validators.pattern(/^https?:\/\//i)],
  });
  /** Pending second-server confirmation. The second endpoint is server-advertised configuration, never a
   *  user-authored field: showing the exact address and asking for consent avoids both jargon and typos. */
  readonly autoFill = signal<{
    primary: string;
    lan: string | null;
    reachable: string;
  } | null>(null);
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
  readonly busy = computed(() => this.phase() !== 'form' || this.saving());
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
    done: 100,
  };
  readonly progress = computed(() => this.progressByPhase[this.phase()]);
  readonly progressMode = computed<'determinate'>(() => 'determinate');
  /** transloco key for the current step label (empty when on the form). */
  readonly stepKey = computed(() => {
    switch (this.phase()) {
      case 'compat':
        return 'serverConfig.stepCompat';
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
    // Serialized: a new submit never queues behind an active flow.
    this.submits
      .pipe(
        exhaustMap((origin) =>
          this.flow(origin).pipe(
            catchError((e) => {
              this.fail(e);
              return EMPTY;
            }),
          ),
        ),
        takeUntil(this.destroyed),
      )
      .subscribe();
    this.destroyRef.onDestroy(() => {
      this.destroyed.next();
      this.unregisterBack?.();
      this.cancelPendingVerification();
    });
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
   *  `preventDefault()` stops that so the submit runs; any failure is surfaced as a transient toast and
   *  the form stays mounted for an edit-and-retry (no reflow). */
  save(event?: Event): void {
    event?.preventDefault();
    // A connect flow is in flight OR the modal is up — ignore re-submits (Enter) that would race it.
    if (this.busy() || this.autoFill()) return;
    if (!this.canSubmit()) {
      this.url.markAsTouched();
      queueMicrotask(() => this.serverInput?.nativeElement.focus());
      return;
    }
    const primaryRaw = this.url.value.trim()
      ? canonicalOrigin(this.url.value)
      : null;
    if (!primaryRaw || this.url.invalid) {
      this.url.markAsTouched();
      queueMicrotask(() => this.serverInput?.nativeElement.focus());
      return;
    }
    this.errorKey.set(null);
    this.errorDetail.set('');
    this.submits.next(primaryRaw);
  }

  /** verify → (pair confirmation) → commit. Verification is cancellable; commit is not. */
  private flow(origin: string): Observable<unknown> {
    this.phase.set('compat');
    return prepareServerSetup(origin, (probe) => {
      // The new server may publish a different Firebase project; apply it after commit.
      this.firebaseConfig = probe.firebaseConfig ?? null;
      const selection = resolveOriginSelection(
        origin,
        probe.primaryOrigin,
        probe.lanOrigin,
      );
      if (selection.confirmPair && selection.lan) {
        this.phase.set('form');
        this.autoFill.set({
          primary: selection.primary,
          lan: selection.lan,
          reachable: origin,
        });
        return this.pairDecision.pipe(take(1));
      }
      return of(true);
    }).pipe(
      takeUntil(this.dismissVerify),
      // ── commit point: from here the save runs to completion and cannot be dismissed ──
      switchMap(({ id, useAdvertised }) => {
        this.saving.set(true);
        return commitServerSetup(id, useAdvertised);
      }),
      finalize(() => this.saving.set(false)),
      switchMap((result) => {
        const { primary, secondary: lan } = result.origins;
        if (isDevMode()) {
          console.info('server-config origins selected', {
            primary,
            secondary: lan,
            active: result.active,
          });
        }
        try {
          this.push.applyFirebaseConfig(this.firebaseConfig);
        } catch (e) {
          console.error('server-config firebase apply failed', e);
        }
        void this.config.reload();
        this.phase.set('done');
        if (isDevMode()) {
          console.info('server-config SPA navigation', {
            route: RoutePage.AUTH_LOGIN,
          });
        }
        if (this.dialog()) {
          this.closed.emit();
          return EMPTY;
        }
        this.route.redirect(RoutePage.AUTH_LOGIN);
        return EMPTY;
      }),
    );
  }

  /** Modal confirm → commit the auto-filled pair. */
  confirmAutoFill(): void {
    if (!this.autoFill()) return;
    this.autoFill.set(null);
    this.pairDecision.next(true);
  }

  /** Keep only the endpoint that was just probed when the user declines the advertised pair. */
  declineAutoFill(): void {
    if (!this.autoFill()) return;
    this.autoFill.set(null);
    this.pairDecision.next(false);
  }

  private cancelPendingVerification(): void {
    if (!this.saving()) this.dismissVerify.next();
  }

  /** Match the shared modal dismissal contract on browser/desktop; Android Back is handled through the
   *  lifecycle-scoped AppBackDispatcher registration below. */
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (this.saving() || (!this.autoFill() && !this.dialog())) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.autoFill()) this.declineAutoFill();
    else this.goBack();
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
    if (
      msg.includes('compat') ||
      msg.includes('too old') ||
      msg.includes('not compatible')
    ) {
      return 'serverConfig.compatErr';
    }
    if (
      msg.includes('cert') ||
      msg.includes('self-signed') ||
      msg.includes('expired')
    ) {
      return 'serverConfig.certErr';
    }
    return 'serverConfig.connectErr';
  }

  /** Visible top-left back affordance (reconfigure only — hidden on first run). Same effect as the
   *  hardware-back reconfigure branch: return to login. */
  goBack(): void {
    if (this.saving()) return;
    this.cancelPendingVerification();
    if (this.dialog()) this.closed.emit();
    else this.route.redirect(RoutePage.AUTH_LOGIN);
  }

  /** Confirmation closes first; reconfigure returns to login; the required first-run root exits. */
  private installBackHandler(): void {
    this.unregisterBack = this.appBack.register(() => {
      if (this.saving()) return;
      if (this.autoFill()) {
        this.declineAutoFill();
        return;
      }
      if (this.canGoBack()) {
        this.goBack();
        return;
      }
      this.cancelPendingVerification();
      window.SomsBack?.exit();
    });
  }
}
