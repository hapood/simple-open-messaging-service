import { Component } from '@angular/core';
import { RegisterComponent } from '../../components/register/register.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';

@Component({
    selector: 'app-register-page',
    imports: [RegisterComponent, AuthBrandComponent, AuthToolbarComponent],
    templateUrl: './register-page.component.html',
    styleUrl: './register-page.component.scss'
})
export class RegisterPageComponent {
  constructor(private routeService: RouteService, private authService: AuthService) {
  }
  onSuccess({ account, password }: { account: string, password: string }) {
    this.authService.login({ account, password, isKeep: true }).subscribe(() => {
      this.routeService.redirect(RoutePage.HOME)
    })
  }
}
