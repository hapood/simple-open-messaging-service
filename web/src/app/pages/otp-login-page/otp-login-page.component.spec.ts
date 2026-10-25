import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService } from '../../services/route.service';
import { OtpLoginPageComponent } from './otp-login-page.component';

describe('OtpLoginPageComponent cancellation', () => {
  it('allows another attempt when server setup cancels authentication without a response', () => {
    const pending = new Subject<never>();
    const redirect = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { otpLogin: () => pending } },
        {
          provide: ConfigService,
          useValue: { ensureLoaded: () => Promise.resolve() },
        },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        { provide: RouteService, useValue: { redirect } },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new OtpLoginPageComponent(),
    );
    component.submit();
    expect(component.isSubmitting()).toBe(true);
    pending.complete();
    expect(component.isSubmitting()).toBe(false);
    expect(component.resp()).toBe('');
    expect(redirect).not.toHaveBeenCalled();
  });
});
