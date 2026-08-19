import { Component, ChangeDetectionStrategy } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { RegisterComponent } from '../../components/register/register.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import {
  IconComponent,
  AppIconType,
} from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';
import { isTauri } from '../../services/runtime';
import { BrandLogoComponent } from '../../components/brand-logo/brand-logo.component';
import { ServerConfigDialogService } from '../../services/server-config-dialog.service';

@Component({
  selector: 'app-register-page',
  imports: [
    RegisterComponent,
    AuthBrandComponent,
    AuthToolbarComponent,
    TranslocoPipe,
    MatButtonModule,
    IconComponent,
    BrandLogoComponent,
  ],
  templateUrl: './register-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './register-page.component.scss',
})
export class RegisterPageComponent {
  // Exposed for the template so the "Server settings" entry renders only inside the Tauri shell —
  // same gate + link as the login page (an unconfigured user who reaches register needs an escape to
  // /config, since guestGuard no longer hard-redirects after the first-run nudge).
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;

  constructor(
    private routeService: RouteService,
    private authService: AuthService,
    private serverConfigDialog: ServerConfigDialogService,
  ) {}

  openServerConfig(): void {
    this.serverConfigDialog.open();
  }
  onSuccess({ account, password }: { account: string; password: string }) {
    this.authService.login({ account, password }).subscribe(() => {
      this.routeService.redirect(RoutePage.HOME);
    });
  }
}
