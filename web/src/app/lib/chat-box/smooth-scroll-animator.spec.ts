import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmoothScrollAnimator } from './smooth-scroll-animator';

describe('SmoothScrollAnimator', () => {
  let now = 0;
  let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let nextRafId = 1;

  beforeEach(() => {
    now = 0;
    rafQueue = [];
    nextRafId = 1;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafQueue.push({ id, cb });
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafQueue = rafQueue.filter((item) => item.id !== id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function flushFrames(steps: number, dtMs = 16): void {
    for (let i = 0; i < steps && rafQueue.length > 0; i++) {
      now += dtMs;
      const item = rafQueue.shift()!;
      item.cb(now);
    }
  }

  it('animates to target and invokes onComplete', () => {
    const animator = new SmoothScrollAnimator();
    let top = 0;
    const onComplete = vi.fn();

    animator.start({
      getTargetTop: () => 500,
      getCurrentTop: () => top,
      setTop: (v) => {
        top = v;
      },
      getBounds: () => ({ min: 0, max: 2000 }),
      onComplete,
    });

    expect(animator.isRunning).toBe(true);
    flushFrames(120);
    expect(animator.isRunning).toBe(false);
    expect(top).toBe(500);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on cancel and invokes onCancel', () => {
    const animator = new SmoothScrollAnimator();
    let top = 0;
    const onComplete = vi.fn();
    const onCancel = vi.fn();

    animator.start({
      getTargetTop: () => 1000,
      getCurrentTop: () => top,
      setTop: (v) => {
        top = v;
      },
      getBounds: () => ({ min: 0, max: 2000 }),
      onComplete,
      onCancel,
    });

    flushFrames(5);
    const midTop = top;
    expect(midTop).toBeGreaterThan(0);

    animator.cancel();
    expect(animator.isRunning).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    flushFrames(10);
    expect(top).toBe(midTop);
  });

  it('switches target mid-flight without firing old onComplete', () => {
    const animator = new SmoothScrollAnimator();
    let top = 0;
    const oldComplete = vi.fn();
    const newComplete = vi.fn();

    animator.start({
      getTargetTop: () => 400,
      getCurrentTop: () => top,
      setTop: (v) => {
        top = v;
      },
      getBounds: () => ({ min: 0, max: 2000 }),
      onComplete: oldComplete,
    });

    flushFrames(6);
    expect(animator.isRunning).toBe(true);

    animator.start({
      getTargetTop: () => 1200,
      getCurrentTop: () => top,
      setTop: (v) => {
        top = v;
      },
      getBounds: () => ({ min: 0, max: 2000 }),
      onComplete: newComplete,
    });

    flushFrames(150);
    expect(animator.isRunning).toBe(false);
    expect(top).toBe(1200);
    expect(oldComplete).not.toHaveBeenCalled();
    expect(newComplete).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when clamped at boundary', () => {
    const animator = new SmoothScrollAnimator();
    let top = 100;
    const onComplete = vi.fn();

    animator.start({
      getTargetTop: () => -200,
      getCurrentTop: () => top,
      setTop: (v) => {
        top = v;
      },
      getBounds: () => ({ min: 0, max: 2000 }),
      onComplete,
    });

    flushFrames(100);
    expect(animator.isRunning).toBe(false);
    expect(top).toBe(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
