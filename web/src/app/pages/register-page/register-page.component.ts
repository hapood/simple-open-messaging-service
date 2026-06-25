import { Component } from '@angular/core';
import { RegisterComponent } from '../../components/register/register.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';

@Component({
    selector: 'app-register-page',
    imports: [RegisterComponent, AuthBrandComponent],
    templateUrl: './register-page.component.html',
    styleUrl: './register-page.component.scss'
})
export class RegisterPageComponent {
  constructor(private routeService: RouteService, private authService: AuthService) {
  }
  onSuccess({ uniqName, password }: { uniqName: string, password: string }) {
    this.authService.login({ uniqName, password, isKeep: true }).subscribe(() => {
      this.routeService.redirect(RoutePage.HOME)
    })
  }
}
