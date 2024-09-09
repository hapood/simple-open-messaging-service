import { Component } from '@angular/core';
import { LoginComponent } from '../../components/login/login.component';
import { RouteService, RoutePage } from '../../services/route.service';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [LoginComponent],
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.scss'
})
export class LoginPageComponent {
  constructor(private routeService: RouteService) { }

  onSuccess() {
    this.routeService.redirect(RoutePage.HOME)
  }
}
