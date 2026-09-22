import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { UserService } from '../../services/user.service';
import { RouteService } from '../../services/route.service';
import { RegisterComponent } from './register.component';

describe('RegisterComponent', () => {
  function createComponent() {
    TestBed.configureTestingModule({
      imports: [RegisterComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: { register: vi.fn() } },
        { provide: RouteService, useValue: { jumpTo: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    });
    return TestBed.createComponent(RegisterComponent);
  }

  it('counts and limits display name by Unicode code points', () => {
    const component = createComponent().componentInstance;

    component.onNameInput('😀'.repeat(40));

    expect(component.name()).toBe('😀'.repeat(31));
  });
});
