import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { UserService } from '../../services/user.service';
import { RouteService } from '../../services/route.service';
import { RegisterComponent } from './register.component';
import { of } from 'rxjs';

describe('RegisterComponent', () => {
  const register = vi.fn(() => of({ code: 0 }));

  function createComponent() {
    TestBed.configureTestingModule({
      imports: [RegisterComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: { register } },
        { provide: RouteService, useValue: { jumpTo: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    });
    return TestBed.createComponent(RegisterComponent);
  }

  it('registers with account and password only — no display name', () => {
    const component = createComponent().componentInstance;

    component.onAccountInput('alice');
    component.onPasswordInput('secret123');
    component.onPassword2Input('secret123');
    component.register();

    expect(register).toHaveBeenCalledWith({
      account: 'alice',
      password: 'secret123',
    });
  });
});
