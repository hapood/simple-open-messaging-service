import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService } from '../../services/route.service';
import { ToastService } from '../../services/toast.service';
import { LoginComponent } from './login.component';

describe('LoginComponent cancellation', () => {
  it('allows another attempt when server setup cancels authentication without a response', () => {
    const pending = new Subject<never>();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { login: () => pending } },
        {
          provide: ConfigService,
          useValue: {
            ensureLoaded: () => Promise.resolve(),
            methodsForPlatform: signal(['password']),
          },
        },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        { provide: RouteService, useValue: {} },
        { provide: ToastService, useValue: { warn: vi.fn(), info: vi.fn() } },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () =>
        new LoginComponent(
          TestBed.inject(AuthService),
          TestBed.inject(RouteService),
        ),
    );
    const success = vi.fn();
    component.onSuccess.subscribe(success);
    component.login();
    expect(component.isLoging()).toBe(true);
    pending.complete();
    expect(component.isLoging()).toBe(false);
    expect(success).not.toHaveBeenCalled();
  });

  it('allows another attempt when server setup cancels OTP login without a response', () => {
    const pending = new Subject<never>();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { otpLogin: () => pending } },
        {
          provide: ConfigService,
          useValue: {
            ensureLoaded: () => Promise.resolve(),
            methodsForPlatform: signal(['otp']),
          },
        },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        { provide: RouteService, useValue: {} },
        { provide: ToastService, useValue: { warn: vi.fn(), info: vi.fn() } },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () =>
        new LoginComponent(
          TestBed.inject(AuthService),
          TestBed.inject(RouteService),
        ),
    );
    component.setMethod('otp');
    component.account.set('alice');
    component.code.set('123456');
    component.login();
    expect(component.isLoging()).toBe(true);
    pending.complete();
    expect(component.isLoging()).toBe(false);
  });
});
