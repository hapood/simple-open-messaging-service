import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CbLayoutScheduler } from './cb-layout-scheduler';

describe('CbLayoutScheduler', () => {
  let nextId: number;
  let frames: Map<number, FrameRequestCallback>;
  let schedulers: CbLayoutScheduler[];

  beforeEach(() => {
    nextId = 0;
    frames = new Map();
    schedulers = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function scheduler(balance: () => void = vi.fn()) {
    const result = new CbLayoutScheduler(balance);
    schedulers.push(result);
    return result;
  }

  function frame() {
    const pending = [...frames.entries()];
    for (const [id, callback] of pending) {
      if (!frames.delete(id)) continue;
      callback(0);
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
  });

  it('does not recursively drain immediately ready work', () => {
    let depth = 0;
    let passes = 0;
    const owner = scheduler(() => {
      expect(++depth).toBe(1);
      expect(owner.phase).toBe('balancing');
      if (++passes < 3) {
        owner.requestBalance();
        owner.requestBalance();
      }
      depth--;
    });
    owner.requestBalance();
    frame();
    expect(passes).toBe(1);
    expect(frames.size).toBe(1);
    frame();
    expect(passes).toBe(2);
    frame();
    expect(passes).toBe(3);
    expect(frames.size).toBe(0);
  });

  it('resizing blocks balance and flushes coalesced dirty work on leave', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.enterResizing();
    owner.enterResizing();
    expect(owner.phase).toBe('resizing');
    owner.requestBalance();
    owner.requestBalance();
    expect(frames.size).toBe(0);
    expect(balance).not.toHaveBeenCalled();

    owner.leaveResizing();
    owner.leaveResizing();
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(1);
    frame();
    expect(balance).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it('resize settling does not request balance by itself', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.enterResizing();
    owner.leaveResizing();
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(0);
    expect(balance).not.toHaveBeenCalled();
  });

  it('revokes a pending balance frame during resize without losing dirty', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.requestBalance();
    const stale = [...frames.values()][0];
    owner.enterResizing();
    expect(frames.size).toBe(0);
    owner.leaveResizing();
    stale(16);
    expect(balance).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('preserves resize settling entered synchronously during balance', () => {
    const balance = vi.fn(() => {
      if (balance.mock.calls.length !== 1) return;
      owner.requestBalance();
      owner.enterResizing();
    });
    const owner = scheduler(balance);
    owner.requestBalance();
    frame();
    expect(owner.phase).toBe('resizing');
    expect(frames.size).toBe(0);
    owner.leaveResizing();
    frame();
    expect(balance).toHaveBeenCalledTimes(2);
    expect(owner.phase).toBe('idle');
  });

  it('cancels pending work without revoking the window or admitting stale frames', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.requestBalance();
    const stale = [...frames.values()][0];
    owner.cancelPending();
    owner.cancelPending();
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(0);
    owner.requestBalance();
    stale(16);
    expect(balance).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('cancelPending clears dirty work without leaving resize settling', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.enterResizing();
    owner.requestBalance();
    owner.cancelPending();
    expect(owner.phase).toBe('resizing');
    owner.leaveResizing();
    expect(frames.size).toBe(0);
    owner.requestBalance();
    frame();
    expect(balance).toHaveBeenCalledOnce();
  });

  it('allows a balance callback to cancel its requested follow-up pass', () => {
    const balance = vi.fn(() => {
      owner.requestBalance();
      owner.cancelPending();
      owner.leaveResizing();
      expect(owner.phase).toBe('balancing');
    });
    const owner = scheduler(balance);
    owner.requestBalance();
    frame();
    expect(balance).toHaveBeenCalledOnce();
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(0);
  });

  it('disposes pending work immediately and rejects stale window callbacks', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.requestBalance();
    const stale = [...frames.values()][0];
    owner.dispose();
    owner.dispose();
    owner.requestBalance();
    owner.enterResizing();
    owner.leaveResizing();
    owner.cancelPending();
    expect(owner.phase).toBe('destroyed');
    expect(frames.size).toBe(0);

    const nextBalance = vi.fn();
    const successor = scheduler(nextBalance);
    successor.requestBalance();
    stale(16);
    expect(balance).not.toHaveBeenCalled();
    expect(nextBalance).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    frame();
    expect(nextBalance).toHaveBeenCalledOnce();
  });

  it('does not revive a window disposed synchronously during balance', () => {
    const owner = scheduler(() => {
      owner.requestBalance();
      owner.dispose();
      owner.requestBalance();
    });
    owner.requestBalance();
    frame();
    expect(owner.phase).toBe('destroyed');
    expect(frames.size).toBe(0);
  });

  it('disposes dirty resize work without rescheduling on leave', () => {
    const balance = vi.fn();
    const owner = scheduler(balance);
    owner.enterResizing();
    owner.requestBalance();
    owner.dispose();
    owner.leaveResizing();
    expect(owner.phase).toBe('destroyed');
    expect(frames.size).toBe(0);
    expect(balance).not.toHaveBeenCalled();
  });

  it('a failing balance does not spin or strand the scheduler', () => {
    const balance = vi.fn((): void => {
      throw new Error('commit');
    });
    const owner = scheduler(balance);
    owner.requestBalance();
    expect(() => frame()).toThrow('commit');
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(0);

    balance.mockImplementation(() => {});
    owner.requestBalance();
    frame();
    expect(balance).toHaveBeenCalledTimes(2);
  });

  it('preserves an explicitly requested follow-up after a failing balance', () => {
    const balance = vi.fn(() => {
      if (balance.mock.calls.length !== 1) return;
      owner.requestBalance();
      throw new Error('commit');
    });
    const owner = scheduler(balance);
    owner.requestBalance();
    expect(() => frame()).toThrow('commit');
    expect(owner.phase).toBe('idle');
    expect(frames.size).toBe(1);
    frame();
    expect(balance).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });
});
