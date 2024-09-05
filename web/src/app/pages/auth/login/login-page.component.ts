import { Component, signal } from '@angular/core';
import { AuthService } from '../../../services/auth.service'
import { LoginComponent } from '../../../components/login/login.component';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [LoginComponent],
  providers: [AuthService],
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.scss'
})
export class LoginPageComponent {
  onSuccess() {

  }
}
