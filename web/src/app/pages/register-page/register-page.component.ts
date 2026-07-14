import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { RegisterComponent } from '../../components/register/register.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';
import { isTauri } from '../../services/runtime';

@Component({
    selector: 'app-register-page',
    imports: [RegisterComponent, AuthBrandComponent, AuthToolbarComponent, RouterLink, TranslocoPipe, MatButtonModule, IconComponent],
    templateUrl: './register-page.component.html',
    styleUrl: './register-page.component.scss'
})
export class RegisterPageComponent {
  // Exposed for the template so the "Server settings" entry renders only inside the Tauri shell —
  // same gate + link as the login page (an unconfigured user who reaches register needs an escape to
  // /config, since guestGuard no longer hard-redirects after the first-run nudge).
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;

  constructor(private routeService: RouteService, private authService: AuthService) {
  }
  onSuccess({ account, password }: { account: string, password: string }) {
    this.authService.login({ account, password, isKeep: true }).subscribe(() => {
      this.routeService.redirect(RoutePage.HOME)
    })
  }
}
