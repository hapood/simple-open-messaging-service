import { describe, expect, it, vi } from 'vitest';
import { MeasuredRegionView } from './measured-region-view';

describe('MeasuredRegionView', () => {
  it('owns observation and ignores queued resize callbacks after destruction', () => {
    let notify!: ResizeObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    try {
      const changed = vi.fn();
      const view = new MeasuredRegionView('cb-bottom-reserve', changed);
      Object.defineProperty(view.el, 'offsetHeight', { get: () => 64 });
      const parent = document.createElement('div');
      expect(view.mount(parent)).toBe(64);
      expect(observe).toHaveBeenCalledWith(view.el);
      notify([], {} as ResizeObserver);
      expect(changed).toHaveBeenCalledExactlyOnceWith(64);
      view.destroy();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(parent.children).toHaveLength(0);
      notify([], {} as ResizeObserver);
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
