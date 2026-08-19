import {
  Component,
  signal,
  computed,
  effect,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import {
  IconComponent,
  AppIconType,
} from '../../components/icon/icon.component';
import { AuthService } from '../../services/auth.service';
import { RouteService, RoutePage } from '../../services/route.service';
import { translateBizResult } from '../../services/biz-code';
import { AuthViewportDirective } from '../../directives/auth-viewport.directive';

/**
 * Forced set-own-password screen — reached proactively after any login (password / OTP / QR) whose session
 * is still on the admin-generated initial password (`mustChangePassword`). The backend gates every other
 * route until this clears the flag, so this is the single action a locked user can take: set a password of
 * their own choosing (no old password — the caller is already session-authenticated). On success the flag
 * clears, this session is kept (unlike a voluntary change, no sessions are invalidated), and the app
 * unlocks (route to HOME). The password grammar mirrors RegisterDto / SetPasswordDto (6-20 chars of the
 * allowed set), validated client-side for early UX feedback and again server-side.
 */
@Component({
  selector: 'app-set-password-page',
  imports: [
    AuthBrandComponent,
    AuthToolbarComponent,
    IconComponent,
    FormsModule,
    TranslocoPipe,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    AuthViewportDirective,
  ],
  templateUrl: './set-password-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './set-password-page.component.scss',
})
export class SetPasswordPageComponent {
  protected readonly AppIcon = AppIconType;
  private readonly transloco = inject(TranslocoService);
  private readonly auth = inject(AuthService);
  private readonly routeService = inject(RouteService);

  password = signal('');
  password2 = signal('');
  resp = signal('');
  passwordHint = signal('');
  showPassword = signal(false);
  isSubmitting = signal(false);
  isPwdVld = signal(false);
  isDisabled = computed(() => this.isSubmitting() || this.isPwdVld() === false);

  // The same grammar the backend enforces on every password input (RegisterDto / SetPasswordDto /
  // change-password): 6-20 chars of [a-zA-Z0-9.@!#$%^&*()]. One regex, validated here for UX + server-side.
  private readonly _passwordRegex =
    /^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/;

  constructor() {
    // Re-validate the password on every keystroke → drive the submit button + the inline hint. The effect
    // reads only `password` and writes `isPwdVld`/`passwordHint` (never what it reads), so no loop.
    effect(() => {
      const password = this.password();
      if (!this._passwordRegex.test(password)) {
        this.isPwdVld.set(false);
        this.passwordHint.set(this.transloco.translate('auth.passwordHint'));
      } else {
        this.isPwdVld.set(true);
        this.passwordHint.set('');
      }
    });
  }

  togglePassword() {
    this.showPassword.update((v) => !v);
  }

  onPasswordInput(v: string) {
    this.password.set(v);
    this.clearError();
  }

  onPassword2Input(v: string) {
    this.password2.set(v);
    this.clearError();
  }

  private clearError() {
    if (this.resp()) this.resp.set('');
  }

  submit() {
    if (this.isSubmitting()) return;
    // Confirm-match is checked here (not in isDisabled) — matches the register page's pattern: the button
    // is enabled once the password grammar is valid, and a mismatch surfaces as an inline error on submit.
    if (this.password2() !== this.password()) {
      this.resp.set(this.transloco.translate('auth.passwordMismatch'));
      return;
    }
    this.isSubmitting.set(true);
    this.auth.setPassword(this.password()).subscribe({
      next: (res) => {
        if (res.code === 0) {
          // Flag cleared + session kept → the app unlocks. replaceUrl so Back never returns here.
          this.routeService.redirect(RoutePage.HOME);
        } else {
          this.resp.set(translateBizResult(res, this.transloco));
          this.isSubmitting.set(false);
        }
      },
      error: () => {
        this.resp.set(this.transloco.translate('auth.unknownError'));
        this.isSubmitting.set(false);
      },
    });
  }
}
