import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ForegroundPresentation } from './foreground-presentation.service';

describe('ForegroundPresentation', () => {
  it('requires both document visibility and focus and removes listeners on destruction', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    try {
      const foreground = TestBed.inject(ForegroundPresentation);
      expect(foreground.focused()).toBe(true);
      window.dispatchEvent(new Event('blur'));
      expect(foreground.focused()).toBe(false);
      window.dispatchEvent(new Event('focus'));
      expect(foreground.focused()).toBe(true);
      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(foreground.focused()).toBe(false);
      window.dispatchEvent(new Event('focus'));
      expect(foreground.focused()).toBe(false);
      visibility.mockReturnValue('visible');
      focus.mockReturnValue(false);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(foreground.focused()).toBe(false);
      TestBed.resetTestingModule();
      expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function));
      expect(removeWindow).toHaveBeenCalledWith('blur', expect.any(Function));
      expect(removeDocument).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
