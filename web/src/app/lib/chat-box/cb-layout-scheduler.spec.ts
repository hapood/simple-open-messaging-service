import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CbLayoutScheduler,
  type CbLayoutAnimation,
} from './cb-layout-scheduler';
import { SmoothScrollAnimator } from './smooth-scroll-animator';

function animation(durationMs = 100) {
  return { durationMs, render: vi.fn(), finish: vi.fn(), cancel: vi.fn() };
}

describe('CbLayoutScheduler', () => {
  let now: number;
  let nextId: number;
  let frames: Map<number, FrameRequestCallback>;
  let schedulers: CbLayoutScheduler[];

  beforeEach(() => {
    now = 0;
    nextId = 0;
    frames = new Map();
    schedulers = [];
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function scheduler(balance: () => CbLayoutAnimation | void = vi.fn()) {
    const result = new CbLayoutScheduler(balance);
    schedulers.push(result);
    return result;
  }

  function frame(at = now + 16) {
    now = at;
    const pending = [...frames.entries()];
    for (const [id, callback] of pending) {
      if (!frames.delete(id)) continue;
      callback(now);
    }
  }

  it('coalesces synchronous parameterless requests into a later pass', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.requestBalance();
    owner.requestBalance();
    expect(balance).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    frame();
    expect(balance).toHaveBeenCalledOnce();
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not recursively drain immediately ready work', () => {
    let depth = 0;
    let passes = 0;
    const owner = scheduler(() => {
      expect(++depth).toBe(1);
      expect(owner.phase).toBe('balancing');
      if (++passes < 3) owner.requestBalance();
      depth--;
    });
    owner.requestBalance();
    frame();
    expect(passes).toBe(1);
    frame();
    expect(passes).toBe(2);
    frame();
    expect(passes).toBe(3);
    expect(frames.size).toBe(0);
  });

  it('retains dirty through an animation returned by a balance commit', () => {
    const batch = animation();
    const balance = vi.fn(() => {
      if (balance.mock.calls.length === 1) {
        owner.requestBalance();
        return batch;
      }
      return undefined;
    });
    const owner = scheduler(balance);
    owner.requestBalance();
    frame(16);
    expect(owner.phase).toBe('animating');
    owner.requestBalance();
    frame(66);
    expect(batch.render).toHaveBeenLastCalledWith(0.5);
    expect(balance).toHaveBeenCalledOnce();
    frame(116);
    expect(batch.finish).toHaveBeenCalledOnce();
    expect(balance).toHaveBeenCalledOnce();
    frame();
    expect(balance).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });

  it('isolated appearance does not request balance by itself', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    const batch = animation();
    expect(owner.startAnimation(batch)).toBe(true);
    expect(owner.phase).toBe('animating');
    expect(batch.render).toHaveBeenCalledWith(0);
    frame(100);
    expect(batch.finish).toHaveBeenCalledOnce();
    expect(owner.phase).toBe('idle');
    expect(balance).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('revokes a pending balance frame before the first appearance frame', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.requestBalance();
    const stale = [...frames.values()][0];
    owner.startAnimation(animation());
    stale(16);
    expect(balance).not.toHaveBeenCalled();
    frame(100);
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('does not interrupt or take ownership of a rejected second batch', () => {
    const owner = scheduler();
    const first = animation();
    const second = animation();
    owner.startAnimation(first);
    expect(owner.startAnimation(second)).toBe(false);
    expect(second.render).not.toHaveBeenCalled();
    expect(second.cancel).not.toHaveBeenCalled();
    frame(100);
    expect(first.finish).toHaveBeenCalledOnce();
    expect(owner.startAnimation(second)).toBe(true);
  });

  it('does not admit isolated animation in a reentrant balance callback', () => {
    const batch = animation();
    const owner = scheduler(() => {
      expect(owner.startAnimation(batch)).toBe(false);
    });
    owner.requestBalance();
    frame();
    expect(batch.render).not.toHaveBeenCalled();
  });

  it('fallback completes even if the first rAF is suspended', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    const batch = animation();
    owner.startAnimation(batch);
    const stale = [...frames.values()][0];
    owner.requestBalance();
    vi.advanceTimersByTime(100);
    expect(batch.finish).toHaveBeenCalledOnce();
    expect(owner.phase).toBe('idle');
    stale(100);
    expect(batch.render).toHaveBeenCalledTimes(1);
    expect(batch.finish).toHaveBeenCalledTimes(1);
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('normal frame completion and the fallback finalize only once', () => {
    const owner = scheduler();
    const batch = animation();
    owner.startAnimation(batch);
    frame(100);
    vi.advanceTimersByTime(100);
    owner.dispose();
    expect(batch.finish).toHaveBeenCalledOnce();
    expect(batch.cancel).not.toHaveBeenCalled();
  });

  it('holds the gate through all final presentation cleanup', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    const batch = animation();
    batch.finish.mockImplementation(() => {
      expect(owner.phase).toBe('animating');
      owner.requestBalance();
      expect(balance).not.toHaveBeenCalled();
      expect(owner.startAnimation(animation())).toBe(false);
    });
    owner.startAnimation(batch);
    frame(100);
    expect(owner.phase).toBe('idle');
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('zero-duration/reduced-motion batches finish without a timer or frame', () => {
    const owner = scheduler();
    const batch = animation(0);
    owner.startAnimation(batch);
    expect(batch.finish).toHaveBeenCalledOnce();
    expect(batch.render).not.toHaveBeenCalled();
    expect(owner.phase).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
  });

  it('zero-duration batches still preserve a dirty wake', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.requestBalance();
    owner.startAnimation(animation(0));
    expect(balance).not.toHaveBeenCalled();
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('resizing state cancels active animations, blocks balance, and flushes dirty on leave', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    const batch = animation(200);
    expect(owner.startAnimation(batch)).toBe(true);
    expect(owner.phase).toBe('animating');

    owner.enterResizing();
    expect(owner.phase).toBe('resizing');
    expect(batch.cancel).toHaveBeenCalledOnce();
    expect(owner.startAnimation(animation(100))).toBe(false);

    owner.requestBalance();
    expect(frames.size).toBe(0);
    expect(balance).not.toHaveBeenCalled();

    owner.leaveResizing();
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(1);
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('disposes pending work immediately and rejects stale window callbacks', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    const batch = animation();
    owner.startAnimation(batch);
    const stale = [...frames.values()][0];
    owner.requestBalance();
    batch.cancel.mockImplementation(() => {
      expect(owner.phase).toBe('destroyed');
      owner.requestBalance();
    });
    owner.dispose();
    owner.dispose();
    expect(batch.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const successor = scheduler();
    successor.startAnimation(animation(200));
    stale(100);
    expect(successor.phase).toBe('animating');
    expect(batch.finish).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
    expect(owner.startAnimation(animation())).toBe(false);
  });

  it('cancels a returned animation when its commit revoked the window', () => {
    const batch = animation();
    const owner = scheduler(() => {
      owner.dispose();
      return batch;
    });
    owner.requestBalance();
    frame();
    expect(batch.cancel).toHaveBeenCalledOnce();
    expect(batch.render).not.toHaveBeenCalled();
    expect(owner.phase).toBe('destroyed');
    expect(frames.size).toBe(0);
  });

  it('allows synchronous revocation during first paint', () => {
    const owner = scheduler();
    const batch = animation();
    batch.render.mockImplementation(() => owner.dispose());
    owner.startAnimation(batch);
    expect(batch.cancel).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not double-finalize when finish synchronously disposes the window', () => {
    const owner = scheduler();
    const batch = animation();
    batch.finish.mockImplementation(() => owner.dispose());
    owner.startAnimation(batch);
    owner.requestBalance();
    frame(100);
    expect(owner.phase).toBe('destroyed');
    expect(batch.cancel).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it('releases a failed paint and preserves a previously requested balance', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    const batch = animation();
    const failure = new Error('paint');
    batch.render.mockImplementation(() => {
      throw failure;
    });
    owner.requestBalance();
    expect(() => owner.startAnimation(batch)).toThrow(failure);
    expect(batch.cancel).toHaveBeenCalledOnce();
    expect(owner.phase).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('reports paint and cleanup errors together without stranding the gate', () => {
    const owner = scheduler();
    const batch = animation();
    const paint = new Error('paint');
    const cleanup = new Error('cleanup');
    batch.render.mockImplementation(() => {
      throw paint;
    });
    batch.cancel.mockImplementation(() => {
      throw cleanup;
    });
    try {
      owner.startAnimation(batch);
      expect.fail('expected aggregate error');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([paint, cleanup]);
    }
    expect(owner.phase).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the gate after failed finalization and preserves dirty', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    const batch = animation();
    batch.finish.mockImplementation(() => {
      throw new Error('finish');
    });
    owner.startAnimation(batch);
    owner.requestBalance();
    expect(() => frame(100)).toThrow('finish');
    expect(owner.phase).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('a failing balance does not spin or strand the scheduler', () => {
    const balance = vi.fn(() => {
      throw new Error('commit');
    });
    const owner = scheduler(balance);
    owner.requestBalance();
    expect(() => frame()).toThrow('commit');
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(0);
  });

  it.each([-1, NaN, Infinity, 2_147_483_648])(
    'rejects invalid lifetime %s before admission',
    (duration) => {
      const owner = scheduler();
      const batch = animation(duration);
      expect(() => owner.startAnimation(batch)).toThrow(RangeError);
      expect(owner.phase).toBe('idle');
      expect(batch.render).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('cancels an invalid batch returned by a committed balance', () => {
    const batch = animation(Infinity);
    const owner = scheduler(() => batch);
    owner.requestBalance();
    expect(() => frame()).toThrow(RangeError);
    expect(batch.cancel).toHaveBeenCalledOnce();
    expect(owner.phase).toBe('idle');
  });

  it('scroll interruption cannot finish or cancel the appearance gate', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    const batch = animation(200);
    owner.startAnimation(batch);
    const scroll = new SmoothScrollAnimator();
    let offset = 0;
    scroll.start({
      getCurrentTop: () => offset,
      setTop: (value) => {
        offset = value;
      },
      getTargetTop: () => 1000,
      getBounds: () => ({ min: 0, max: 2000 }),
    });
    frame(16);
    expect(offset).toBeGreaterThan(0);
    scroll.cancel();
    owner.requestBalance();
    frame(32);
    expect(owner.phase).toBe('animating');
    expect(balance).not.toHaveBeenCalled();
    expect(batch.cancel).not.toHaveBeenCalled();
    expect(batch.finish).not.toHaveBeenCalled();
    frame(200);
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });
});
