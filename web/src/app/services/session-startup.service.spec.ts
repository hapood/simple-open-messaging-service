import { SessionStartupService } from './session-startup.service';

describe('session startup gate', () => {
  it('keeps routed UI closed until restoration settles', async () => {
    const service = new SessionStartupService();
    let complete!: () => void;
    const pending = service.run(() => new Promise<void>((resolve) => { complete = resolve; }));
    expect(service.restoring()).toBe(true);
    complete();
    await pending;
    expect(service.restoring()).toBe(false);
  });

  it('releases retry timers and callbacks on destruction', () => {
    vi.useFakeTimers();
    try {
      const service = new SessionStartupService();
      const retry = vi.fn();
      service.offerRetry(5000, retry);
      service.ngOnDestroy();
      service.retryNow();
      expect(retry).not.toHaveBeenCalled();
      expect(service.retryIn()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('fails closed on unexpected errors', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const service = new SessionStartupService();
      await service.run(async () => { throw new Error('failed'); });
      expect(service.restoring()).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
