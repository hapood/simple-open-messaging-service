import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import { AUTOMATION_TESTING } from '../../common/automation-testing';
import { AppIconType, IconComponent } from '../icon/icon.component';

/** One stable secondary entry for alternate authentication methods, avoiding a row of competing links. */
@Component({
  selector: 'app-auth-method-menu',
  standalone: true,
  imports: [MatButtonModule, MatMenuModule, TranslocoPipe, IconComponent],
  templateUrl: './auth-method-menu.component.html',
  styleUrl: './auth-method-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthMethodMenuComponent {
  protected readonly AppIcon = AppIconType;
  protected readonly methodMenuTestId = AUTOMATION_TESTING
    ? 'auth-method-menu'
    : null;
  protected readonly otpMethodTestId = AUTOMATION_TESTING
    ? 'auth-method-otp'
    : null;

  readonly password = input(false);
  readonly otp = input(false);
  readonly qr = input(false);

  readonly passwordSelected = output<void>();
  readonly otpSelected = output<void>();
  readonly qrSelected = output<void>();
}
