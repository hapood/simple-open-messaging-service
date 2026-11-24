import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FederationPeerRuntimeService } from './federation-peer-runtime.service.js';
import { FederationCooldownError } from './federation-errors.js';
import {
  FEDERATION_NAMESPACE_PAUSED,
  FEDERATION_NAMESPACE_RESUMED,
} from './federation-peer.events.js';

function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const events = new EventEmitter2();
  const runtime = new FederationPeerRuntimeService(events);
  return { events, runtime };
}

afterEach(() => vi.useRealTimers());

describe('process-local namespace cooldown', () => {
  it.each([undefined, null, -1, '60', 1.5, Infinity, Number.MAX_SAFE_INTEGER])(
    'uses 15 minutes for absent or invalid retryAfter %s',
    async (retryAfter) => {
      const { runtime } = harness();
      await runtime.enterCooldown(7, 'paused', retryAfter);
      expect(runtime.getCooldown(7)).toEqual({
        until: 1_900_000,
        reason: 'paused',
      });
    },
  );

  it('closes admission before notifying cancellation and isolates namespaces', async () => {
    const { events, runtime } = harness();
    events.on(FEDERATION_NAMESPACE_PAUSED, ({ namespaceId }) => {
      expect(namespaceId).toBe(7);
      expect(() => runtime.assertBusinessAllowed(7)).toThrow(
        FederationCooldownError,
      );
    });
    await runtime.enterCooldown(7, 'limited', 60);
    expect(runtime.getCooldown(7)?.until).toBe(1_060_000);
    expect(() => runtime.assertBusinessAllowed(8)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never shortens a pause and rejects a stale in-flight Health observation', async () => {
    const { runtime, events } = harness();
    const resumed = vi.fn();
    events.on(FEDERATION_NAMESPACE_RESUMED, resumed);
    await runtime.enterCooldown(7, 'first', 60);
    const observed = runtime.getCooldown(7);
    await runtime.enterCooldown(7, 'second', 10);
    expect(runtime.getCooldown(7)?.until).toBe(observed?.until);
    vi.advanceTimersByTime(60_000);
    await runtime.completePeriodicHealth(7, observed, true);
    expect(resumed).not.toHaveBeenCalled();
    expect(runtime.getCooldown(7)).not.toBeNull();
  });

  it('expiry alone and unsuccessful Health never resume business work', async () => {
    const { runtime, events } = harness();
    const resumed = vi.fn();
    events.on(FEDERATION_NAMESPACE_RESUMED, resumed);
    await runtime.enterCooldown(7, 'limited', 60);
    const observed = runtime.getCooldown(7);
    await runtime.completePeriodicHealth(7, observed, true);
    expect(resumed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(() => runtime.assertBusinessAllowed(7)).toThrow(
      FederationCooldownError,
    );
    await runtime.completePeriodicHealth(7, observed, false);
    expect(resumed).not.toHaveBeenCalled();
    await runtime.completePeriodicHealth(7, observed, true);
    expect(resumed).toHaveBeenCalledExactlyOnceWith({ namespaceId: 7 });
    expect(runtime.getCooldown(7)).toBeNull();
    await runtime.completePeriodicHealth(7, observed, true);
    expect(resumed).toHaveBeenCalledOnce();
  });

  it('does not retain cooldown across process instances', async () => {
    const { runtime } = harness();
    await runtime.enterCooldown(7, 'limited', 0);
    const restarted = new FederationPeerRuntimeService(new EventEmitter2());
    expect(restarted.cooldownNamespaceIds()).toEqual([]);
  });
});
