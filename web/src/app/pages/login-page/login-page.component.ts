import { Component } from '@angular/core';
import { LoginComponent } from '../../components/login/login.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { RouteService, RoutePage } from '../../services/route.service';

@Component({
    selector: 'app-login-page',
    imports: [LoginComponent, AuthBrandComponent, AuthToolbarComponent],
    templateUrl: './login-page.component.html',
    styleUrl: './login-page.component.scss'
})
export class LoginPageComponent {
  constructor(private routeService: RouteService) { }

  onSuccess() {
    this.routeService.redirect(RoutePage.HOME)
  }
}
