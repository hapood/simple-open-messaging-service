import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';
import { AuthBrandComponent } from './auth-brand.component';

describe('AuthBrandComponent', () => {
  let fixture: ComponentFixture<AuthBrandComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        AuthBrandComponent,
        TranslocoTestingModule.forRoot({
          langs: { en: { auth: { brandTagline: 'Open messaging, simply.' } } },
          translocoConfig: { availableLangs: ['en'], defaultLang: 'en' },
        }),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AuthBrandComponent);
    fixture.detectChanges();
  });

  it('uses tonal rather than elevated-white surfaces for the light panel', () => {
    const host = fixture.nativeElement as HTMLElement;
    host.setAttribute('data-theme', 'light');
    host.style.setProperty('--app-active', 'rgb(223, 225, 226)');
    host.style.setProperty('--app-bg-muted', 'rgb(236, 236, 234)');
    host.style.setProperty('--app-border', 'rgb(222, 223, 223)');
    host.style.setProperty('--app-surface-elevated', 'rgb(255, 255, 255)');
    const background = getComputedStyle(host).backgroundImage;
    expect(background).toContain('rgb(223, 225, 226) 0%');
    expect(background).toContain('rgb(236, 236, 234) 48%');
    expect(background).toContain('rgb(222, 223, 223) 100%');
    expect(background).not.toContain('rgb(255, 255, 255)');
    expect(getComputedStyle(host, '::before').borderTopColor).toContain('0.18');
    expect(getComputedStyle(host, '::after').backgroundColor).toContain('0.06');
  });

  it('preserves the dark panel and its decorative circle treatment', () => {
    const host = fixture.nativeElement as HTMLElement;
    host.setAttribute('data-theme', 'dark');
    expect(getComputedStyle(host).backgroundImage).toContain(
      'rgb(21, 23, 25) 50%',
    );
    expect(getComputedStyle(host, '::before').borderTopColor).toBe(
      'rgba(255, 255, 255, 0.12)',
    );
    expect(getComputedStyle(host, '::after').backgroundColor).toBe(
      'rgba(255, 255, 255, 0.05)',
    );
  });
});
