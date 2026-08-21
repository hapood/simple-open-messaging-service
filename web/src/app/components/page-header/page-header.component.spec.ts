import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { PageHeaderComponent } from './page-header.component';

describe('PageHeaderComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PageHeaderComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: ['en', 'zh-CN'],
            defaultLang: 'en',
          },
          loader: InlineTranslocoLoader,
        }),
      ],
    });
  });

  it('renders the title and emits back from the standard navigation button', async () => {
    const fixture = TestBed.createComponent(PageHeaderComponent);
    const onBack = vi.fn();
    fixture.componentRef.setInput('title', 'Members');
    fixture.componentInstance.back.subscribe(onBack);
    fixture.detectChanges();
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.page-header__title')?.textContent).toContain(
      'Members',
    );
    const backIcon = element.querySelector<SVGElement>(
      '.page-header__back app-icon svg',
    );
    expect(backIcon?.style.width).toBe('28px');
    expect(backIcon?.style.height).toBe('28px');

    element.querySelector<HTMLButtonElement>('.page-header__back')?.click();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('applies safe-area sizing and disables back navigation when requested', () => {
    const fixture = TestBed.createComponent(PageHeaderComponent);
    fixture.componentRef.setInput('title', 'Profile');
    fixture.componentRef.setInput('safeArea', true);
    fixture.componentRef.setInput('titleAlign', 'start');
    fixture.componentRef.setInput('backDisabled', true);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.page-header--safe-area')).not.toBeNull();
    expect(element.querySelector('.page-header--start')).not.toBeNull();
    expect(
      element.querySelector<HTMLButtonElement>('.page-header__back')?.disabled,
    ).toBe(true);
  });

  it('reserves the leading track when back navigation is hidden', () => {
    const fixture = TestBed.createComponent(PageHeaderComponent);
    fixture.componentRef.setInput('title', 'Requests');
    fixture.componentRef.setInput('showBack', false);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.page-header__back')).toBeNull();
    expect(
      element.querySelector('.page-header__leading-spacer'),
    ).not.toBeNull();
  });
});
