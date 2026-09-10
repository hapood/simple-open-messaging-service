import { describe, expect, it, vi } from 'vitest';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('SessionLifecycleService account epoch', () => {
  it('invalidates captured work before announcing completed cleanup', () => {
    const lifecycle = new SessionLifecycleService();
    const epoch = lifecycle.accountEpoch;
    const ended = vi.fn();
    const invalidated = vi.fn((next: number) => {
      expect(lifecycle.accountEpoch).toBe(next);
      expect(lifecycle.isCurrent(epoch)).toBe(false);
    });
    lifecycle.ended$.subscribe(ended);
    lifecycle.invalidated$.subscribe(invalidated);

    lifecycle.invalidateSession();

    expect(invalidated).toHaveBeenCalledWith(epoch + 1);
    expect(ended).not.toHaveBeenCalled();
    lifecycle.endSession();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(lifecycle.accountEpoch).toBe(epoch + 1);
  });

  it('never makes an old epoch current again across repeated invalidations', () => {
    const lifecycle = new SessionLifecycleService();
    const first = lifecycle.accountEpoch;
    lifecycle.invalidateSession();
    const second = lifecycle.accountEpoch;
    lifecycle.invalidateSession();
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.isCurrent(second)).toBe(false);
    expect(lifecycle.isCurrent(lifecycle.accountEpoch)).toBe(true);
  });
});
