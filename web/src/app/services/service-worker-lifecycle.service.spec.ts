import { registrationDouble } from './service-worker-test-doubles';
import { TestBed } from '@angular/core/testing';
import { SwUpdate } from '@angular/service-worker';
import { UpdateService } from './update.service';
import { ServiceWorkerLifecycleService } from './service-worker-lifecycle.service';

describe('service worker lifecycle', () => {
  const checkForUpdate = vi.fn();
  const update = vi.fn();
  let service: ServiceWorkerLifecycleService;

  beforeEach(() => {
    checkForUpdate.mockReset().mockResolvedValue(false);
    update.mockReset().mockResolvedValue(undefined);
    vi.spyOn(navigator.serviceWorker, 'getRegistration').mockResolvedValue(registrationDouble({
      scope: new URL('/push/', location.href).href,
      update,
    }));
    TestBed.configureTestingModule({ providers: [
      { provide: SwUpdate, useValue: { isEnabled: true, checkForUpdate } },
      { provide: UpdateService, useValue: {} },
    ] });
    service = TestBed.inject(ServiceWorkerLifecycleService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts both checks without awaiting authentication and starts only once', async () => {
    service.start();
    service.start();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });

  it('does not update ngsw through the push registration fallback', async () => {
    vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(registrationDouble({
      scope: new URL('/', location.href).href,
      update,
    }));
    service.start();
    await vi.waitFor(() => expect(checkForUpdate).toHaveBeenCalledOnce());
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps push checks independent of a pending app check', async () => {
    checkForUpdate.mockReturnValue(new Promise(() => {}));
    service.start();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    service.checkForUpdates();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });

  it('retries failed checks on the next poll and stops on destruction', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    update.mockRejectedValueOnce(new Error('offline'));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(2);
    service.ngOnDestroy();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
