import { describe, expect, it, vi } from 'vitest';
import { renderGhostState } from './ghost-renderer';

describe('edge status renderers', () => {
  it('ghost reuses its status icon and clears retry interaction on deactivation', () => {
    const el = document.createElement('div');
    const retry = vi.fn();
    renderGhostState(el, 'loading', retry);
    const status = el.querySelector('.cb-load-status');
    expect(status).not.toBeNull();
    renderGhostState(el, 'failed', retry);
    expect(el.querySelector('.cb-load-status')).toBe(status);
    expect(el.querySelectorAll('.cb-load-status')).toHaveLength(1);
    expect(el.getAttribute('role')).toBe('button');
    el.click();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(retry).toHaveBeenCalledTimes(2);
    renderGhostState(el, 'inactive', retry);
    expect(el.classList.contains('cb-ghost')).toBe(false);
    expect(el.classList.contains('cb-edge-failed')).toBe(false);
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
    expect(el.tabIndex).toBe(-1);
    el.click();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(retry).toHaveBeenCalledTimes(2);
  });

});
