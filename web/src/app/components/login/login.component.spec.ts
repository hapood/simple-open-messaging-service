import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService } from '../../services/route.service';
import { LoginComponent } from './login.component';

describe('LoginComponent cancellation', () => {
  it('allows another attempt when server setup cancels authentication without a response', () => {
    const pending = new Subject<never>();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { login: () => pending } },
        {
          provide: ConfigService,
          useValue: { ensureLoaded: () => Promise.resolve() },
        },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        { provide: RouteService, useValue: {} },
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
    expect(component.resp()).toBe('');
    expect(success).not.toHaveBeenCalled();
  });
});
