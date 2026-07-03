import { Component, signal, computed, Output, EventEmitter, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { AuthService } from '../../services/auth.service'
import { translateBizResult } from '../../services/biz-code'
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

@Component({
    selector: 'app-login',
    imports: [IconComponent, FormsModule, TranslocoPipe, MatButtonModule, MatCheckboxModule,
        MatFormFieldModule, MatInputModule, MatProgressBarModule],
    templateUrl: './login.component.html',
    styleUrl: './login.component.scss'
})
export class LoginComponent {
  @Output() onSuccess = new EventEmitter<boolean>();

  readonly AppIcon = AppIconType;
  private readonly transloco = inject(TranslocoService);

  uniqName = signal('');
  password = signal('');
  resp = signal('');
  showPassword = signal(false)
  isKeepLogin = signal(true)
  isLoging = signal(false)
  isSuccess = signal(false)
  isLoginBtnDisabled = computed(() => {
    return this.isSuccess() || this.isLoging() || this.uniqName() === '' || this.password() === ''
  })

  constructor(private authService: AuthService, private routeService: RouteService) {

  }

  togglePassword() {
    this.showPassword.update(v => !v)
  }

  onUniqNameInput(v: string) {
    this.uniqName.set(v)
    this.clearError()
  }

  onPasswordInput(v: string) {
    this.password.set(v)
    this.clearError()
  }

  private clearError() {
    if (this.resp()) {
      this.resp.set('')
    }
  }

  login() {
    if (this.isLoging()) {
      return
    }
    this.isLoging.set(true)
    this.authService.login({
      uniqName: this.uniqName(),
      password: this.password(), isKeep: this.isKeepLogin()
    })
      .subscribe({
        next: (res) => {
          if (res.code === 0) {
            this.onSuccess.emit(true)
            this.isSuccess.set(true)
            this.isLoging.set(false)
          } else {
            this.resp.set(translateBizResult(res, this.transloco))
            this.isLoging.set(false)
          }
        },
        error: (err) => {
          console.error(err)
          this.resp.set(this.transloco.translate('auth.unknownError'))
          this.isLoging.set(false)
        }
      })
  }

  jumpToRegister() {
    this.routeService.navigate(RoutePage.AUTH_REGISTER)
  }
}
