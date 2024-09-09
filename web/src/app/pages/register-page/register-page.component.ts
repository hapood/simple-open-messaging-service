import { Component, signal } from '@angular/core';
import { RegisterComponent } from '../../components/register/register.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';
@Component({
  selector: 'app-register-page',
  standalone: true,
  imports: [RegisterComponent, IconComponent],
  templateUrl: './register-page.component.html',
  styleUrl: './register-page.component.scss'
})
export class RegisterPageComponent {
  AppIconType = AppIconType
  isShowBackBtn = signal(false)
  constructor(private routeService: RouteService, private authService: AuthService) {
    if (this.routeService.hasPrevRoute()) {
      this.isShowBackBtn.set(true)
    }
  }
  goBack(){
    this.routeService.go(-1)
  }
  onSuccess({ uniqName, password }: { uniqName: string, password: string }) {
    this.authService.login({ uniqName, password, isKeep: true }).subscribe(() => {
      this.routeService.clearHistory();
      this.routeService.redirect(RoutePage.HOME)
    })
  }
}
