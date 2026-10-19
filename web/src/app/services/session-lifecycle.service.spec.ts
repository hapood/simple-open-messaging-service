import { SessionLifecycleService } from './session-lifecycle.service';
import {
  createSessionCacheDescriptor,
  SessionSupersededError,
} from './session/session-identity';

describe('SessionLifecycleService renderer mirror', () => {
  it('publishes only the identity supplied by the session authority', () => {
    const lifecycle = new SessionLifecycleService();
    const publicWork = lifecycle.capture();
    expect(publicWork.sessionId).toBeNull();
    const id = createSessionCacheDescriptor().id;
    const invalidated = vi.fn();
    lifecycle.invalidated$.subscribe(invalidated);
    lifecycle.bindSession(id);
    expect(lifecycle.capture().sessionId).toBe(id);
    expect(publicWork.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(publicWork)).toBe(false);
    expect(invalidated).not.toHaveBeenCalled();
  });

  it('preserves a bound UUID and lease on duplicate publication', () => {
    const lifecycle = new SessionLifecycleService();
    const id = createSessionCacheDescriptor().id;
    lifecycle.bindSession(id);
    const scope = lifecycle.capture();
    lifecycle.bindSession(id);
    expect(lifecycle.capture()).toBe(scope);
    expect(scope.signal.aborted).toBe(false);
  });

  it('invalidates synchronously before notifying reset consumers', () => {
    const lifecycle = new SessionLifecycleService();
    lifecycle.bindSession(createSessionCacheDescriptor().id);
    const scope = lifecycle.capture();
    const invalidated = vi.fn(() => {
      expect(scope.signal.aborted).toBe(true);
      expect(lifecycle.capture().sessionId).toBeNull();
      expect(lifecycle.isCurrent(scope)).toBe(false);
    });
    lifecycle.invalidated$.subscribe(invalidated);
    lifecycle.invalidateSession();
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(() => lifecycle.assertCurrent(scope)).toThrow(
      SessionSupersededError,
    );
  });

  it('never revives old work even when the same persistent UUID is restored', () => {
    const lifecycle = new SessionLifecycleService();
    const id = createSessionCacheDescriptor().id;
    lifecycle.bindSession(id);
    const old = lifecycle.capture();
    lifecycle.invalidateSession();
    lifecycle.bindSession(id);
    expect(lifecycle.capture().sessionId).toBe(id);
    expect(lifecycle.isCurrent(old)).toBe(false);
    expect(lifecycle.isCurrent(lifecycle.capture())).toBe(true);
  });

  it('separates cancellation of signed-out work and in-memory end notifications', () => {
    const lifecycle = new SessionLifecycleService();
    const first = lifecycle.capture();
    const ended = vi.fn();
    lifecycle.ended$.subscribe(ended);
    lifecycle.invalidateSession();
    const second = lifecycle.capture();
    lifecycle.invalidateSession();
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.isCurrent(second)).toBe(false);
    expect(ended).not.toHaveBeenCalled();
    lifecycle.endSession();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('makes the old lease stale before synchronous abort callbacks run', () => {
    const lifecycle = new SessionLifecycleService();
    const previous = lifecycle.capture();
    const onAbort = vi.fn(() =>
      expect(lifecycle.isCurrent(previous)).toBe(false),
    );
    previous.signal.addEventListener('abort', onAbort);
    lifecycle.bindSession(createSessionCacheDescriptor().id);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});
