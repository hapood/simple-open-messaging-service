import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideTransloco } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { LanguageService } from '../../services/language.service';
import { UpdateService } from '../../services/update.service';
import { UpdateBannerComponent } from './update-banner.component';

describe('UpdateBannerComponent (global Material snackbar)', () => {
  const action$ = new Subject<void>();
  const dismissed$ = new Subject<void>();
  const ref = {
    onAction: () => action$.asObservable(),
    afterDismissed: () => dismissed$.asObservable(),
    dismiss: jasmine.createSpy('dismiss'),
  };
  const snackBar = { open: jasmine.createSpy('open').and.returnValue(ref) };
  const available = signal(false);
  const update = {
    available,
    applyUpdate: jasmine.createSpy('applyUpdate').and.resolveTo(),
    dismiss: jasmine.createSpy('dismiss').and.callFake(() => available.set(false)),
  };

  beforeEach(() => {
    available.set(false);
    snackBar.open.calls.reset();
    ref.dismiss.calls.reset();
    update.applyUpdate.calls.reset();
    update.dismiss.calls.reset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: [{ id: 'en', label: 'English' }, { id: 'zh-CN', label: '简体中文' }],
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
    expect(snackBar.open).not.toHaveBeenCalled();
  });

  it('opens a standard bottom notification when an update becomes available', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();
    available.set(true);
    await fixture.whenStable();
    expect(snackBar.open).toHaveBeenCalledWith(
      jasmine.any(String),
      jasmine.any(String),
      jasmine.objectContaining({
        duration: 0,
        panelClass: jasmine.arrayContaining(['soms-snack-bar--interactive']),
      }),
    );
  });

  it('applies the update from the snackbar action', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    available.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    action$.next();
    expect(update.applyUpdate).toHaveBeenCalled();
  });

  it('dismisses the pending update when the snackbar closes', async () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    available.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    dismissed$.next();
    expect(update.dismiss).toHaveBeenCalled();
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
  });
});
