import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageService } from './language.service';
import { PreferenceStore } from './preference-store.service';

describe('LanguageService native notification language', () => {
  let get: ReturnType<typeof vi.fn>;
  let set: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    get = vi.fn().mockResolvedValue(undefined);
    set = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: PreferenceStore, useValue: { get, set } },
        {
          provide: TranslocoService,
          useValue: { setTranslation: vi.fn(), setActiveLang: vi.fn() },
        },
      ],
    });
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('restores the same global language read by Rust without rewriting it', async () => {
    get.mockResolvedValue('zh-CN');
    const service = TestBed.inject(LanguageService);
    await Promise.resolve();
    expect(service.lang()).toBe('zh-CN');
    expect(get).toHaveBeenCalledWith('global', 'language');
    expect(set).not.toHaveBeenCalled();
  });

  it.each([['en-US', 'en'], ['fr-FR', 'en']])(
    'persists the resolved initial %s language as %s for headless Rust',
    async (browser, resolved) => {
      vi.spyOn(navigator, 'language', 'get').mockReturnValue(browser);
      const service = TestBed.inject(LanguageService);
      await Promise.resolve();
      expect(service.lang()).toBe(resolved);
      expect(set).toHaveBeenCalledExactlyOnceWith('global', 'language', resolved);
    },
  );

  it('does not let delayed restoration overwrite an explicit choice', async () => {
    let resolve!: (value: string | undefined) => void;
    get.mockReturnValue(new Promise<string | undefined>((done) => { resolve = done; }));
    const service = TestBed.inject(LanguageService);
    service.setLang('en');
    resolve('zh-CN');
    await Promise.resolve();
    expect(service.lang()).toBe('en');
    expect(set).toHaveBeenCalledExactlyOnceWith('global', 'language', 'en');
  });
});
