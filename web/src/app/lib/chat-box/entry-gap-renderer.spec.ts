import { describe, expect, it, vi } from 'vitest';
import { createEntryGapRenderer } from './entry-gap-renderer';

describe('entry gap renderer', () => {
  it('renders localized states and gates mouse and keyboard activation while loading', () => {
    const activate = vi.fn();
    const view = createEntryGapRenderer(
      activate,
      (state) => `localized:${state}`,
    );
    expect(view.el.getAttribute('aria-label')).toBe('localized:idle');
    view.el.click();
    view.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(activate).toHaveBeenCalledTimes(2);
    view.update('loading');
    expect(view.el.getAttribute('aria-label')).toBe('localized:loading');
    expect(view.el.getAttribute('aria-busy')).toBe('true');
    view.el.click();
    view.el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(activate).toHaveBeenCalledTimes(2);
    view.update('failed');
    expect(view.el.getAttribute('aria-label')).toBe('localized:failed');
    expect(view.el.hasAttribute('aria-busy')).toBe(false);
    view.el.click();
    expect(activate).toHaveBeenCalledTimes(3);
    view.destroy();
    view.el.click();
    view.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(activate).toHaveBeenCalledTimes(3);
  });
});
