import { AppDataLifetime } from './app-data-lifetime.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  createSessionCacheDescriptor,
  SessionSupersededError,
} from './session/session-identity';

describe('SessionLifecycleService protocol facade', () => {
  it('publishes the authority identity without creating another cancellation scope', () => {
    const appData = new AppDataLifetime();
    const lifecycle = new SessionLifecycleService(appData);
    const publicWork = lifecycle.capture();
    const id = createSessionCacheDescriptor().id;
    lifecycle.publishIdentity(id);
    expect(lifecycle.capture().sessionId).toBe(id);
    expect(lifecycle.capture().signal).toBe(appData.workSignal);
    expect(publicWork.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(publicWork)).toBe(false);
    const admitted = lifecycle.capture();
    lifecycle.publishIdentity(id);
    expect(lifecycle.capture()).toBe(admitted);
  });

  it('delegates termination synchronously to the app owner before reset notifications', () => {
    const appData = new AppDataLifetime();
    const lifecycle = new SessionLifecycleService(appData);
    lifecycle.publishIdentity(createSessionCacheDescriptor().id);
    const scope = lifecycle.capture();
    const invalidated = vi.fn(() => {
      expect(appData.signal.aborted).toBe(true);
      expect(lifecycle.capture().sessionId).toBeNull();
      expect(lifecycle.isCurrent(scope)).toBe(false);
    });
    lifecycle.invalidated$.subscribe(invalidated);
    lifecycle.invalidateSession();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(() => lifecycle.assertCurrent(scope)).toThrow(
      SessionSupersededError,
    );
    expect(() =>
      lifecycle.publishIdentity(createSessionCacheDescriptor().id),
    ).toThrow(SessionSupersededError);
  });

  it('cannot revive even the same persistent UUID in an ended renderer', () => {
    const lifecycle = new SessionLifecycleService();
    const id = createSessionCacheDescriptor().id;
    lifecycle.publishIdentity(id);
    lifecycle.invalidateSession();
    expect(() => lifecycle.publishIdentity(id)).toThrow(SessionSupersededError);
    expect(lifecycle.capture().signal.aborted).toBe(true);
  });

  it('uses the app owner for cancellable pre-admission preparation', () => {
    const appData = new AppDataLifetime();
    const lifecycle = new SessionLifecycleService(appData);
    const first = lifecycle.capture();
    lifecycle.invalidateSession();
    expect(first.signal.aborted).toBe(true);
    expect(lifecycle.capture().signal).toBe(appData.workSignal);
    expect(appData.signal.aborted).toBe(false);
    lifecycle.publishIdentity(createSessionCacheDescriptor().id);
    appData.end();
    expect(lifecycle.isCurrent(lifecycle.capture())).toBe(false);
  });
});
