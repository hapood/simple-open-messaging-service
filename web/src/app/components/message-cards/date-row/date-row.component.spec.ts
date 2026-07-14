import { createComponent, EnvironmentInjector, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco, provideTranslocoTranspiler } from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import { LanguageService } from '../../../services/language.service';
import { DateRowComponent } from './date-row.component';

/**
 * Verifies the architecturally risky piece of the i18n port: the chatbox kernel mounts message rows
 * imperatively via createComponent + detectChanges (NOT attached to the ApplicationRef change-detection
 * tree), so signal reactivity is not guaranteed there. DateRowComponent self-refreshes on a language
 * change via an internal effect (markForCheck + detectChanges) to make the date pill reactive regardless
 * of view-attach status. This spec reproduces the kernel's mounting and asserts the label actually flips.
 */
describe('DateRowComponent — kernel-style detached mount', () => {
  let language: LanguageService;

  beforeEach(() => {
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
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
      ],
    });
    language = TestBed.inject(LanguageService);
    // Karma's localStorage persists across runs/tests; reset to a known state so resolveInitial() is
    // deterministic (a prior test's setLang('zh-CN') would otherwise leak in). Flush so the service's
    // apply() effect (which calls setActiveLang + dayjs.locale) runs before the assertions.
    localStorage.removeItem('soms.lang');
    language.setLang('en');
    TestBed.flushEffects();
  });

  /** Drive the zoneless reactive scheduler so the row's self-refresh effect runs after a signal write. */
  const flush = () => {
    TestBed.flushEffects();
    return Promise.resolve();
  };

  it('relabels from English to Chinese on a language switch (detached view still refreshes)', async () => {
    const envInjector = TestBed.inject(EnvironmentInjector);
    const ref = createComponent(DateRowComponent, { environmentInjector: envInjector });
    try {
      ref.setInput('ms', Date.now());
      ref.changeDetectorRef.detectChanges();

      expect(ref.instance.label()).toBe('Today');
      expect((ref.location.nativeElement as HTMLElement).textContent).toContain('Today');

      language.setLang('zh-CN');
      TestBed.flushEffects();
      ref.changeDetectorRef.detectChanges();

      expect(ref.instance.label()).toBe('今天');
      expect((ref.location.nativeElement as HTMLElement).textContent).toContain('今天');
    } finally {
      ref.destroy();
    }
  });

  it('relabels back to English on a subsequent switch', async () => {
    const envInjector = TestBed.inject(EnvironmentInjector);
    const ref = createComponent(DateRowComponent, { environmentInjector: envInjector });
    try {
      ref.setInput('ms', Date.now());
      ref.changeDetectorRef.detectChanges();
      language.setLang('zh-CN');
      TestBed.flushEffects();
      ref.changeDetectorRef.detectChanges();
      language.setLang('en');
      TestBed.flushEffects();
      ref.changeDetectorRef.detectChanges();
      expect((ref.location.nativeElement as HTMLElement).textContent).toContain('Today');
    } finally {
      ref.destroy();
    }
  });
});
