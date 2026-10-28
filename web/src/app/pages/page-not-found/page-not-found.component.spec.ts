import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Location } from '@angular/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PageNotFoundComponent } from './page-not-found.component';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';

describe('PageNotFoundComponent', () => {
  let router: { navigate: ReturnType<typeof vi.fn>; url: string };
  let location: { back: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    router = {
      navigate: vi.fn(),
      url: '/test-missing-route',
    };
    location = {
      back: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [PageNotFoundComponent],
      providers: [
        { provide: Router, useValue: router },
        { provide: Location, useValue: location },
        provideTransloco({
          config: { availableLangs: ['en', 'zh-CN'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
      ],
    });
  });

  it('renders and initializes with current route path', () => {
    const fixture = TestBed.createComponent(PageNotFoundComponent);
    const component = fixture.componentInstance;
    expect(component).toBeTruthy();
    expect(component.currentPath()).toBe('/test-missing-route');
  });

  it('navigates home when goHome is called', () => {
    const fixture = TestBed.createComponent(PageNotFoundComponent);
    const component = fixture.componentInstance;
    component.goHome();
    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });

  it('calls location.back when goBack is called', () => {
    const fixture = TestBed.createComponent(PageNotFoundComponent);
    const component = fixture.componentInstance;
    component.goBack();
    expect(location.back).toHaveBeenCalled();
  });
});
