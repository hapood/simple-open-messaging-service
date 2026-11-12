import { ApplicationRef, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import {
  ToastContentComponent,
  ToastContentData,
} from './toast-content.component';

describe('ToastContentComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MatSnackBarModule],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: ['en', 'zh-CN'],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
      ],
    });
  });

  async function open(data: ToastContentData) {
    const ref = TestBed.inject(MatSnackBar).openFromComponent(
      ToastContentComponent,
      {
        data,
        duration: 0,
      },
    );
    await TestBed.inject(ApplicationRef).whenStable();
    const element = document.querySelector<HTMLElement>('app-toast-content')!;
    return { ref, element };
  }

  it('renders plain text and a localized close button without stealing focus', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    try {
      const { element } = await open({ message: '<b>Saved</b>' });
      expect(element.querySelector('[matSnackBarLabel]')?.textContent).toBe(
        '<b>Saved</b>',
      );
      expect(element.querySelector('b')).toBeNull();
      expect(element.querySelectorAll('button')).toHaveLength(1);
      const close = element.querySelector<HTMLButtonElement>('.toast-close')!;
      expect(close.getAttribute('aria-label')).toBe('Close');
      expect(close.type).toBe('button');
      expect(close.tabIndex).toBe(0);
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
    }
  });

  it('closes without emitting the business action', async () => {
    const { ref, element } = await open({
      message: 'Update ready',
      action: 'Reload',
    });
    const action = vi.fn();
    ref.onAction().subscribe(action);
    const dismiss = vi.spyOn(ref, 'dismiss');
    element.querySelector<HTMLButtonElement>('.toast-close')!.click();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });

  it('emits the business action only from its own button', async () => {
    const { ref, element } = await open({
      message: 'Update ready',
      action: 'Reload',
    });
    const action = vi.fn();
    ref.onAction().subscribe(action);
    const button = element.querySelector<HTMLButtonElement>(
      '[matSnackBarAction]',
    )!;
    expect(button.textContent?.trim()).toBe('Reload');
    button.click();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('localizes the close label in Chinese', async () => {
    TestBed.inject(TranslocoService).setActiveLang('zh-CN');
    const { element } = await open({ message: 'Saved' });
    expect(
      element.querySelector('.toast-close')?.getAttribute('aria-label'),
    ).toBe('关闭');
  });
});
