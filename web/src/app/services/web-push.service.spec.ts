import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { PreferenceStore } from './preference-store.service';
import { ToastService } from './toast.service';
import { WebPushService } from './web-push.service';

describe('WebPushService device ID', () => {
  let service: WebPushService;
  let preferences: PreferenceStore;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: TranslocoService, useValue: { translate: () => '' } },
        { provide: ToastService, useValue: { warn: () => {} } },
      ],
    });
    preferences = TestBed.inject(PreferenceStore);
    await preferences.remove('device', 'device_id');
    service = TestBed.inject(WebPushService);
  });

  it('creates and persists one ID for concurrent registrations', async () => {
    const [first, second] = await Promise.all([
      service['clientDeviceId'](),
      service['clientDeviceId'](),
    ]);

    expect(first).toBe(second);
    expect(await preferences.get('device', 'device_id')).toBe(first);
  });

  it('reuses a stored device ID', async () => {
    await preferences.set('device', 'device_id', 'existing-device');

    expect(await service['clientDeviceId']()).toBe('existing-device');
  });
});
