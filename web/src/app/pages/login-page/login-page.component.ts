import {
  Component,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { LoginComponent } from '../../components/login/login.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { BrandLogoComponent } from '../../components/brand-logo/brand-logo.component';
import {
  IconComponent,
  AppIconType,
} from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { ConfigService } from '../../services/config.service';
import { apiOrigin, apiOriginSecondary, isTauri } from '../../services/runtime';
import { AuthViewportDirective } from '../../directives/auth-viewport.directive';
import { ServerConfigDialogService } from '../../services/server-config-dialog.service';

@Component({
  selector: 'app-login-page',
  imports: [
    LoginComponent,
    AuthBrandComponent,
    AuthToolbarComponent,
    BrandLogoComponent,
    TranslocoPipe,
    MatButtonModule,
    MatProgressSpinnerModule,
    IconComponent,
    AuthViewportDirective,
  ],
  templateUrl: './login-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './login-page.component.scss',
})
export class LoginPageComponent {
  // Exposed for the template so the server banner + "Configure server" entry render only inside the
  // Tauri shell (browser build is same-origin; nothing to report or reconfigure there).
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;
  private readonly config = inject(ConfigService);
  private readonly serverConfigDialog = inject(ServerConfigDialogService);

  // --- Origin banner (shows the configured backend prominently on the login page). https = green globe
  //     (cert was validated at init); http/IP = red (insecure — validation skipped, not guaranteed secure). ---
  private originHost(origin: string | null): string {
    try {
      return origin ? new URL(origin).host : '';
    } catch {
      return origin ?? '';
    }
  }

  private originInsecure(origin: string | null): boolean {
    if (!origin) return true;
    try {
      return new URL(origin).protocol !== 'https:';
    } catch {
      return true;
    }
  }

  /** Every configured endpoint, not only the primary one. In the unreachable pre-login state this lets
   *  the user see which two addresses were attempted before deciding whether to retry or reconfigure. */
  readonly configuredOrigins = computed(() =>
    [
      { origin: apiOrigin(), labelKey: 'settings.serverPrimary' },
      { origin: apiOriginSecondary(), labelKey: 'settings.serverLan' },
    ]
      .filter(
        (entry): entry is { origin: string; labelKey: string } =>
          !!entry.origin,
      )
      .map((entry) => {
        const insecure = this.originInsecure(entry.origin);
        return {
          ...entry,
          host: this.originHost(entry.origin),
          insecure,
          scheme: insecure ? 'HTTP' : 'HTTPS',
          icon: insecure ? AppIconType.REPORT : AppIconType.GLOBE,
        };
      }),
  );

  /** True once `/config` has settled (loaded) WITHOUT a `loginMode` — the backend is unreachable or
   *  returned no config. `ensureLoaded` catches the fetch failure silently (so route guards can await it),
   *  so without this the user sees an empty page with no clue why; this surfaces a visible error + a
   *  reconfigure action. */
  readonly configFailed = computed(
    () => this.config.loaded() && this.config.loginMode() === null,
  );
  readonly connectionCancelled = this.config.cancelled;
  readonly availableMethods = computed(() => this.config.methodsForPlatform());
  readonly ready = computed(
    () =>
      this.config.loaded() &&
      (this.availableMethods().length > 0 || this.configFailed()),
  );

  constructor(private routeService: RouteService) {
    void this.config.ensureLoaded();
  }

  /** Login succeeded. The payload is the session's `mustChangePassword` flag — route to the forced
   *  set-password screen (not home) when the session is still on the admin-generated initial password. */
  onSuccess(mustChangePassword: boolean) {
    this.routeService.redirect(
      mustChangePassword ? RoutePage.AUTH_SET_PASSWORD : RoutePage.HOME,
    );
  }

  /** Edit an existing server configuration without leaving the current auth surface. */
  reopenServerConfig(): void {
    this.serverConfigDialog.open();
  }

  /** Use the guarded configuration route for the failed-connection recovery action. */
  openServerConfigRoute(): void {
    this.routeService.redirect(RoutePage.CONFIG);
  }

  /** Immediately unsubscribe the current public-config request and settle on the stopped state. */
  cancelConnection(): void {
    this.config.cancelLoad();
  }

  /** Re-fetch `/config` (the cached load settled as a failure, or the origin was just reconfigured).
   *  `reload()` clears the cached promise + resets the signals, so `ready()` flips false and the error
   *  card is replaced by the spinner until the new request settles — the user gets immediate feedback that
   *  the retry is in flight. */
  retry(): void {
    void this.config.reload();
  }
}
