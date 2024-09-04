import { Component, signal } from '@angular/core';
import { UserLoginService } from '../../../services/user-login.service'
import { LoginComponent } from '../../../components/login/login.component';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [LoginComponent],
  providers: [UserLoginService],
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.scss'
})
export class LoginPageComponent {
  onSuccess() {

  }
}
