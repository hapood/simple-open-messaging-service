import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferenceStorage } from './preference-storage';
import { prepareTheme } from './theme-bootstrap';
import { ThemeService } from './theme.service';

describe('ThemeService startup handoff', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    vi.spyOn(PreferenceStorage.prototype, 'close').mockResolvedValue();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it.each([
    ['dark', false],
    ['light', true],
  ] as const)(
    'starts with stored %s rather than the opposing OS theme',
    async (mode, osDark) => {
      const get = vi
        .spyOn(PreferenceStorage.prototype, 'get')
        .mockResolvedValue(mode);
      vi.spyOn(window, 'matchMedia').mockReturnValue({
        matches: osDark,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as MediaQueryList);
      await prepareTheme();
      const writes = vi.spyOn(document.documentElement, 'setAttribute');
      const service = TestBed.inject(ThemeService);
      TestBed.flushEffects();
      expect(service.mode()).toBe(mode);
      expect(service.effective()).toBe(mode);
      expect(document.documentElement.getAttribute('data-theme')).toBe(mode);
      expect(
        writes.mock.calls
          .filter(([name]) => name === 'data-theme')
          .every(([, value]) => value === mode),
      ).toBe(true);
      expect(get).toHaveBeenCalledExactlyOnceWith('global', 'theme');
    },
  );

  it('follows later OS changes only in system mode without restoring preferences again', async () => {
    const get = vi
      .spyOn(PreferenceStorage.prototype, 'get')
      .mockResolvedValue('system');
    const set = vi
      .spyOn(PreferenceStorage.prototype, 'set')
      .mockResolvedValue();
    let onChange!: (event: MediaQueryListEvent) => void;
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      addEventListener: (_type: string, listener: typeof onChange) => {
        onChange = listener;
      },
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    await prepareTheme();
    const service = TestBed.inject(ThemeService);
    expect(service.effective()).toBe('dark');
    onChange({ matches: false } as MediaQueryListEvent);
    expect(service.effective()).toBe('light');
    service.setMode('light');
    onChange({ matches: true } as MediaQueryListEvent);
    expect(service.effective()).toBe('light');
    expect(set).toHaveBeenCalledExactlyOnceWith('global', 'theme', 'light');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
