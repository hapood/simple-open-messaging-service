import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OffsetScrollMotion } from './offset-scroll-motion';

describe('OffsetScrollMotion', () => {
  let now = 0;
  let nextRafId = 0;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    now = 0;
    nextRafId = 0;
    frames = new Map();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextRafId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function frame(dtMs = 16): void {
    now += dtMs;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }

  function flush(): void {
    for (let i = 0; i < 2000 && frames.size > 0; i++) frame();
    expect(frames.size).toBe(0);
  }

  function create(initial = 0) {
    let offset = initial;
    const setOffset = vi.fn((value: number) => {
      expect(Number.isFinite(value)).toBe(true);
      offset = value;
    });
    const getOffset = vi.fn(() => offset);
    const onFinish = vi.fn();
    const motion = new OffsetScrollMotion({
      getOffset,
      setOffset,
      onFinish,
    });
    return {
      motion,
      getOffset,
      setOffset,
      onFinish,
      get offset() {
        return offset;
      },
      set offset(value: number) {
        offset = value;
      },
    };
  }

  it.each([10000.25, -10000.25])(
    'accelerates, cruises and decelerates to an exact unbounded target %s',
    (target) => {
      const state = create();
      const { motion } = state;
      motion.setTarget(target);
      const speeds: number[] = [];
      let previous = 0;
      for (let i = 0; i < 1000 && motion.isRunning; i++) {
        frame();
        expect(
          Math.sign(target) * (state.offset - previous),
        ).toBeGreaterThanOrEqual(0);
        expect(Math.abs(state.offset)).toBeLessThanOrEqual(Math.abs(target));
        speeds.push(Math.abs(motion.currentVelocity));
        previous = state.offset;
      }
      expect(speeds[0]).toBeGreaterThan(0);
      expect(speeds[1]).toBeGreaterThan(speeds[0]);
      expect(speeds.filter((speed) => speed === 2800).length).toBeGreaterThan(
        2,
      );
      expect(
        speeds.some((speed, i) => i > 0 && speed < speeds[i - 1] && speed > 0),
      ).toBe(true);
      expect(state.offset).toBe(target);
      expect(motion.targetOffset).toBe(target);
      expect(motion.currentVelocity).toBe(0);
      expect(motion.isRunning).toBe(false);
      expect(state.onFinish).toHaveBeenCalledTimes(1);
      expect(frames.size).toBe(0);
    },
  );

  it.each([0, 0.000001, -0.000001, 0.25, -0.25, 8, -8])(
    'settles small or zero distance %s exactly',
    (target) => {
      const state = create();
      state.motion.setTarget(target);
      flush();
      expect(state.offset).toBe(target);
      expect(state.onFinish).toHaveBeenCalledTimes(1);
    },
  );

  it.each([4, 1000 / 144, 1000 / 30, 50])(
    'settles with a frame interval of %s ms',
    (dt) => {
      const state = create(-25.5);
      state.motion.setTarget(1793.125);
      for (let i = 0; i < 2000 && state.motion.isRunning; i++) frame(dt);
      expect(state.offset).toBe(1793.125);
      expect(state.motion.currentVelocity).toBe(0);
      expect(state.onFinish).toHaveBeenCalledTimes(1);
      expect(frames.size).toBe(0);
    },
  );

  it('ignores a stale frame after cancellation and restart', () => {
    const state = create();
    state.motion.setTarget(1000);
    const staleFrame = [...frames.values()][0];
    state.motion.cancel();
    state.motion.setTarget(-1000);
    staleFrame(16);
    expect(state.offset).toBe(0);
    expect(state.motion.currentVelocity).toBe(0);
    expect(frames.size).toBe(1);
    flush();
    expect(state.offset).toBe(-1000);
    expect(state.onFinish).toHaveBeenCalledTimes(1);
  });

  it('preserves velocity, offset and one pending frame when retargeting forward', () => {
    const state = create(-400);
    state.motion.setTarget(2000);
    for (let i = 0; i < 8; i++) frame();
    const velocity = state.motion.currentVelocity;
    const offset = state.offset;
    state.motion.setTarget(4000.125);
    expect(state.motion.currentVelocity).toBe(velocity);
    expect(state.offset).toBe(offset);
    expect(frames.size).toBe(1);
    expect(state.onFinish).not.toHaveBeenCalled();
    flush();
    expect(state.offset).toBe(4000.125);
    expect(state.onFinish).toHaveBeenCalledTimes(1);
  });

  it.each([1, -1])(
    'brakes and travels in its old direction before reversing (%s)',
    (sign) => {
      const state = create();
      state.motion.setTarget(sign * 4000);
      for (let i = 0; i < 10; i++) frame();
      const offset = state.offset;
      const velocity = state.motion.currentVelocity;
      state.motion.setTarget(-sign * 500);
      expect(state.motion.currentVelocity).toBe(velocity);
      frame();
      expect(sign * (state.offset - offset)).toBeGreaterThan(0);
      expect(sign * state.motion.currentVelocity).toBeGreaterThan(0);
      expect(Math.abs(state.motion.currentVelocity)).toBeLessThan(
        Math.abs(velocity),
      );
      expect(state.offset - offset).toBeCloseTo(
        velocity * 0.016 - (sign * 5500 * 0.016 ** 2) / 2,
      );
      expect(state.onFinish).not.toHaveBeenCalled();
      let previous = state.offset;
      while (sign * state.motion.currentVelocity > 5500 * 0.016) {
        frame();
        expect(sign * (state.offset - previous)).toBeGreaterThan(0);
        previous = state.offset;
      }
      flush();
      expect(state.offset).toBe(-sign * 500);
      expect(state.onFinish).toHaveBeenCalledTimes(1);
    },
  );

  it('integrates the old-direction travel even when braking reaches zero within a frame', () => {
    const state = create();
    state.motion.setTarget(1000);
    frame(1);
    const offset = state.offset;
    const velocity = state.motion.currentVelocity;
    state.motion.setTarget(-1000);
    frame(2);
    const brakingTime = velocity / 5500;
    const returnTime = 0.002 - brakingTime;
    expect(state.offset).toBeCloseTo(
      offset + velocity ** 2 / (2 * 5500) - (9000 * returnTime ** 2) / 2,
    );
    expect(state.offset).toBeGreaterThan(offset);
    expect(state.motion.currentVelocity).toBeLessThan(0);
    flush();
    expect(state.offset).toBe(-1000);
  });

  it.each([0, 1])(
    'does not snap to a target inside the current stopping distance (%s)',
    (distance) => {
      const state = create();
      state.motion.setTarget(5000);
      for (let i = 0; i < 15; i++) frame();
      const target = state.offset + distance;
      state.motion.setTarget(target);
      frame();
      expect(state.offset).toBeGreaterThan(target);
      expect(state.motion.currentVelocity).toBeGreaterThan(0);
      expect(state.onFinish).not.toHaveBeenCalled();
      flush();
      expect(state.offset).toBe(target);
      expect(state.onFinish).toHaveBeenCalledTimes(1);
    },
  );

  it('cancel resets without writing or finishing, and a restart begins at rest', () => {
    const state = create();
    state.motion.setTarget(2000);
    frame();
    const offset = state.offset;
    const writes = state.setOffset.mock.calls.length;
    state.motion.cancel();
    state.motion.cancel();
    expect(state.motion.isRunning).toBe(false);
    expect(state.motion.currentVelocity).toBe(0);
    expect(state.motion.targetOffset).toBeNull();
    expect(frames.size).toBe(0);
    frame();
    expect(state.offset).toBe(offset);
    expect(state.setOffset).toHaveBeenCalledTimes(writes);
    expect(state.onFinish).not.toHaveBeenCalled();
    state.motion.setTarget(-2000);
    expect(state.motion.currentVelocity).toBe(0);
    flush();
    expect(state.offset).toBe(-2000);
  });

  it('cancels a pending rAF whose ID is zero', () => {
    const state = create();
    state.motion.setTarget(100);
    expect(frames.has(0)).toBe(true);
    state.motion.cancel();
    expect(frames.size).toBe(0);
  });

  it('snap stops motion, writes exactly and completes synchronously', () => {
    const state = create();
    state.motion.setTarget(2000);
    frame();
    state.motion.snap(-120.75);
    expect(state.offset).toBe(-120.75);
    expect(state.motion.currentVelocity).toBe(0);
    expect(state.motion.isRunning).toBe(false);
    expect(state.motion.targetOffset).toBe(-120.75);
    expect(state.onFinish).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    frame();
    expect(state.onFinish).toHaveBeenCalledTimes(1);
  });

  it.each([700, -700])(
    'rebase shifts only the target, preserving relative motion (%s)',
    (delta) => {
      const state = create();
      const reference = create();
      state.motion.setTarget(2000);
      reference.motion.setTarget(2000);
      for (let i = 0; i < 8; i++) frame();
      const velocity = state.motion.currentVelocity;
      const writes = state.setOffset.mock.calls.length;
      state.offset += delta;
      state.motion.rebase(delta);
      expect(state.motion.targetOffset).toBe(2000 + delta);
      expect(state.motion.currentVelocity).toBe(velocity);
      expect(state.setOffset).toHaveBeenCalledTimes(writes);
      expect(state.onFinish).not.toHaveBeenCalled();
      for (let i = 0; i < 8; i++) {
        frame();
        expect(state.offset - reference.offset).toBeCloseTo(delta);
        expect(state.motion.currentVelocity).toBeCloseTo(
          reference.motion.currentVelocity,
        );
      }
      flush();
      expect(state.offset).toBe(2000 + delta);
      expect(state.onFinish).toHaveBeenCalledTimes(1);
      state.motion.rebase(delta);
      expect(state.motion.targetOffset).toBe(2000 + 2 * delta);
      expect(frames.size).toBe(0);
      state.motion.cancel();
      state.motion.rebase(delta);
      expect(state.motion.targetOffset).toBeNull();
    },
  );

  it('caps long frames and ignores duplicate, backwards and nonfinite timestamps', () => {
    const state = create();
    state.motion.setTarget(10000);
    frame(10000);
    expect(state.motion.currentVelocity).toBeCloseTo(9000 * 0.05);
    expect(state.offset).toBeCloseTo((9000 * 0.05 ** 2) / 2);
    const offset = state.offset;
    const velocity = state.motion.currentVelocity;
    for (const timestamp of [now, now - 1, NaN, Infinity]) {
      const callback = [...frames.values()][0];
      frames.clear();
      callback(timestamp);
      expect(state.offset).toBe(offset);
      expect(state.motion.currentVelocity).toBe(velocity);
      expect(frames.size).toBe(1);
    }
    flush();
    expect(state.offset).toBe(10000);
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite requests without changing active motion (%s)',
    (value) => {
      const state = create();
      state.motion.setTarget(1000);
      frame();
      const velocity = state.motion.currentVelocity;
      expect(() => state.motion.setTarget(value)).toThrow(RangeError);
      expect(() => state.motion.snap(value)).toThrow(RangeError);
      expect(() => state.motion.rebase(value)).toThrow(RangeError);
      expect(state.motion.targetOffset).toBe(1000);
      expect(state.motion.currentVelocity).toBe(velocity);
      expect(frames.size).toBe(1);
      flush();
    },
  );

  it('silently cancels if the current coordinate becomes nonfinite', () => {
    const state = create();
    state.motion.setTarget(1000);
    state.offset = NaN;
    frame();
    expect(state.motion.isRunning).toBe(false);
    expect(state.motion.targetOffset).toBeNull();
    expect(state.setOffset).not.toHaveBeenCalled();
    expect(state.onFinish).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it('does not publish or change velocity after the getter cancels', () => {
    const state = create(100);
    state.motion.setTarget(1000);
    state.getOffset.mockImplementationOnce(() => {
      state.motion.cancel();
      return state.offset;
    });
    frame();
    expect(state.offset).toBe(100);
    expect(state.setOffset).not.toHaveBeenCalled();
    expect(state.motion.currentVelocity).toBe(0);
    expect(state.motion.isRunning).toBe(false);
    expect(state.motion.targetOffset).toBeNull();
    expect(state.onFinish).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it.each([0, NaN])(
    'leaves exactly one fresh trip when the getter restarts and returns %s',
    (staleOffset) => {
      const state = create();
      state.motion.setTarget(1000);
      state.getOffset.mockImplementationOnce(() => {
        state.motion.cancel();
        state.motion.setTarget(-100);
        return staleOffset;
      });
      frame();
      expect(state.setOffset).not.toHaveBeenCalled();
      expect(state.motion.currentVelocity).toBe(0);
      expect(state.motion.targetOffset).toBe(-100);
      expect(state.motion.isRunning).toBe(true);
      expect(frames.size).toBe(1);
      expect(state.onFinish).not.toHaveBeenCalled();
      flush();
      expect(state.offset).toBe(-100);
      expect(state.onFinish).toHaveBeenCalledTimes(1);
    },
  );

  it('does not overwrite a snap performed by the getter', () => {
    const state = create();
    state.motion.setTarget(1000);
    state.getOffset.mockImplementationOnce(() => {
      state.motion.snap(-100);
      return 0;
    });
    frame();
    expect(state.offset).toBe(-100);
    expect(state.setOffset).toHaveBeenCalledExactlyOnceWith(-100);
    expect(state.motion.targetOffset).toBe(-100);
    expect(state.motion.currentVelocity).toBe(0);
    expect(state.motion.isRunning).toBe(false);
    expect(state.onFinish).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  describe.each(['arrival', 'snap'] as const)(
    'reentrant setter during %s',
    (completion) => {
      function complete(motion: OffsetScrollMotion): void {
        if (completion === 'snap') {
          motion.snap(0);
        } else {
          motion.setTarget(0);
          frame();
        }
      }

      it('suppresses completion when the setter cancels', () => {
        const state = create();
        state.setOffset.mockImplementationOnce((offset) => {
          state.offset = offset;
          state.motion.cancel();
        });
        complete(state.motion);
        expect(state.onFinish).not.toHaveBeenCalled();
        expect(state.motion.targetOffset).toBeNull();
        expect(state.motion.currentVelocity).toBe(0);
        expect(state.motion.isRunning).toBe(false);
        expect(frames.size).toBe(0);
      });

      it.each([false, true])(
        'does not finish the old trip when the setter starts a new one (cancel first: %s)',
        (cancelFirst) => {
          const state = create();
          state.setOffset.mockImplementationOnce((offset) => {
            state.offset = offset;
            if (cancelFirst) state.motion.cancel();
            state.motion.setTarget(-100);
          });
          complete(state.motion);
          expect(state.onFinish).not.toHaveBeenCalled();
          expect(state.motion.targetOffset).toBe(-100);
          expect(state.motion.currentVelocity).toBe(0);
          expect(state.motion.isRunning).toBe(true);
          expect(frames.size).toBe(1);
          flush();
          expect(state.offset).toBe(-100);
          expect(state.onFinish).toHaveBeenCalledTimes(1);
        },
      );

      it('only finishes the nested snap when the setter snaps', () => {
        const state = create();
        state.setOffset.mockImplementationOnce((offset) => {
          state.offset = offset;
          state.motion.snap(-100);
        });
        complete(state.motion);
        expect(state.offset).toBe(-100);
        expect(state.motion.targetOffset).toBe(-100);
        expect(state.motion.currentVelocity).toBe(0);
        expect(state.motion.isRunning).toBe(false);
        expect(state.onFinish).toHaveBeenCalledTimes(1);
        expect(frames.size).toBe(0);
      });
    },
  );

  it('allows onFinish to start a new trip without losing its frame', () => {
    const state = create();
    state.onFinish.mockImplementationOnce(() => state.motion.setTarget(-100));
    state.motion.setTarget(100);
    flush();
    expect(state.offset).toBe(-100);
    expect(state.onFinish).toHaveBeenCalledTimes(2);
  });

  it('does not schedule extra frames when the setter cancels and restarts', () => {
    const state = create();
    state.setOffset.mockImplementationOnce((offset) => {
      state.offset = offset;
      state.motion.cancel();
      state.motion.setTarget(-100);
    });
    state.motion.setTarget(1000);
    frame();
    expect(frames.size).toBe(1);
    flush();
    expect(state.offset).toBe(-100);
    expect(state.onFinish).toHaveBeenCalledTimes(1);
  });
});
