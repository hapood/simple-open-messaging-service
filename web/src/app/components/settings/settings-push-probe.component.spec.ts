import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { SettingsPushProbeComponent } from './settings-push-probe.component';
import {
  PushProbeService,
  type PushProbeStatus,
} from '../../services/push-probe.service';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';

describe('Shared settings push probe', () => {
  const accepted: PushProbeStatus = {
    probeId: 'probe',
    stage: 'provider_accepted',
    createdAt: 1,
  };
  let component: SettingsPushProbeComponent;
  let probes: {
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    probes = {
      create: vi.fn().mockResolvedValue(accepted),
      get: vi
        .fn()
        .mockResolvedValue({
          ...accepted,
          stage: 'device_received',
          latencyMs: 12,
        }),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: PushProbeService, useValue: probes }],
    });
    component = TestBed.runInInjectionContext(
      () => new SettingsPushProbeComponent(),
    );
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('shares the accepted-to-received flow and blocks repeated clicks during cooldown', async () => {
    const run = component.run();
    await Promise.resolve();
    expect(component.stage()).toBe('provider_accepted');
    await component.run();
    expect(probes.create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(component.stage()).toBe('device_received');
    expect(component.latencyMs()).toBe(12);
    expect(component.checking()).toBe(false);
    await component.run();
    expect(probes.create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29000);
    expect(component.cooldownRemaining()).toBe(0);
  });

  it('stops polling after the receipt deadline', async () => {
    probes.get.mockResolvedValue(accepted);
    const run = component.run();
    await vi.advanceTimersByTimeAsync(15000);
    await run;
    expect(component.stage()).toBe('timeout');
    const count = probes.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(probes.get).toHaveBeenCalledTimes(count);
  });

  it('does not poll when the receipt beats the create response', async () => {
    probes.create.mockResolvedValue({ ...accepted, stage: 'device_received' });
    await component.run();
    expect(component.stage()).toBe('device_received');
    expect(probes.get).not.toHaveBeenCalled();
  });

  it('shows failure detail and allows retry after cooldown', async () => {
    probes.create.mockRejectedValue(new Error('Not registered'));
    await component.run();
    expect(component.stage()).toBe('failed');
    expect(component.error()).toBe('Not registered');
    await vi.advanceTimersByTimeAsync(30000);
    probes.create.mockResolvedValue({ ...accepted, stage: 'device_received' });
    await component.run();
    expect(component.stage()).toBe('device_received');
  });

  it('cancels a pending poll on logout', async () => {
    const run = component.run();
    await Promise.resolve();
    TestBed.inject(SessionLifecycleService).invalidateSession();
    await run;
    await vi.advanceTimersByTimeAsync(30000);
    expect(probes.get).not.toHaveBeenCalled();
    expect(component.stage()).toBeNull();
  });

  it('ignores a create response arriving after the session changed', async () => {
    let resolve!: (value: PushProbeStatus) => void;
    probes.create.mockReturnValue(
      new Promise<PushProbeStatus>((done) => {
        resolve = done;
      }),
    );
    const run = component.run();
    TestBed.inject(SessionLifecycleService).invalidateSession();
    resolve(accepted);
    await run;
    expect(component.stage()).toBeNull();
    expect(probes.get).not.toHaveBeenCalled();
  });
});
