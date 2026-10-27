import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideTransloco } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { LanguageService } from '../../services/language.service';
import { UpdateService } from '../../services/update.service';
import { ToastContentComponent } from '../toast-content/toast-content.component';
import { UpdateBannerComponent } from './update-banner.component';

describe('UpdateBannerComponent (global Material snackbar)', () => {
  let action$: Subject<void>;
  let dismissed$: Subject<void>;
  const ref = {
    onAction: () => action$.asObservable(),
    afterDismissed: () => dismissed$.asObservable(),
    dismiss: vi.fn().mockName('dismiss'),
  };
  const snackBar = { openFromComponent: vi.fn().mockReturnValue(ref) };
  const available = signal(false);
  const update = {
    available,
    applyUpdate: vi.fn().mockName('applyUpdate').mockResolvedValue(undefined),
    dismiss: vi
      .fn()
      .mockName('dismiss')
      .mockImplementation(() => available.set(false)),
  };

  beforeEach(() => {
    action$ = new Subject<void>();
    dismissed$ = new Subject<void>();
    available.set(false);
    snackBar.openFromComponent.mockClear();
    ref.dismiss.mockClear();
    update.applyUpdate.mockClear();
    update.dismiss.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: [
              { id: 'en', label: 'English' },
              { id: 'zh-CN', label: '简体中文' },
            ],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        LanguageService,
        { provide: UpdateService, useValue: update },
        { provide: MatSnackBar, useValue: snackBar },
      ],
    });
  });

  it('does not open while no update is available', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(snackBar.openFromComponent).not.toHaveBeenCalled();
  });

  it('opens dismissible content with a persistent update action', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();
    available.set(true);
    await fixture.whenStable();
    expect(snackBar.openFromComponent).toHaveBeenCalledWith(
      ToastContentComponent,
      expect.objectContaining({
        data: { message: expect.any(String), action: expect.any(String) },
        duration: 0,
        panelClass: ['soms-snack-bar', 'soms-update-snack-bar'],
      }),
    );
  });

  it('applies the update from the snackbar action', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    available.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    action$.next();
    expect(update.applyUpdate).toHaveBeenCalledTimes(1);
  });

  it('dismisses the pending update without applying it when the snackbar closes', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    available.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    dismissed$.next();
    await fixture.whenStable();
    expect(update.dismiss).toHaveBeenCalledTimes(1);
    expect(update.applyUpdate).not.toHaveBeenCalled();
    expect(snackBar.openFromComponent).toHaveBeenCalledTimes(1);
  });

  it('supports the playground override and emits demoDismiss', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.componentRef.setInput('demoAvailable', true);
    let count = 0;
    fixture.componentInstance.demoDismiss.subscribe(() => count++);
    fixture.detectChanges();
    await fixture.whenStable();
    dismissed$.next();
    expect(count).toBe(1);
    expect(update.applyUpdate).not.toHaveBeenCalled();
    expect(update.dismiss).not.toHaveBeenCalled();
  });
});
