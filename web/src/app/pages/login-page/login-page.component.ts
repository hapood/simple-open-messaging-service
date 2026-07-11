import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { LoginComponent } from '../../components/login/login.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { isTauri } from '../../services/runtime';

@Component({
    selector: 'app-login-page',
    imports: [LoginComponent, AuthBrandComponent, AuthToolbarComponent, RouterLink, TranslocoPipe, MatButtonModule, IconComponent],
    templateUrl: './login-page.component.html',
    styleUrl: './login-page.component.scss'
})
export class LoginPageComponent {
  // Exposed for the template so the "Server settings" entry renders only inside the Tauri shell
  // (browser build is same-origin; the config page is canMatch-gated to isTauri anyway).
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;

  constructor(private routeService: RouteService) { }

  onSuccess() {
    this.routeService.redirect(RoutePage.HOME)
  }
}
