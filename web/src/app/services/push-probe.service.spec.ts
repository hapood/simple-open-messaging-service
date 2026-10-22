import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { vi } from 'vitest';
import { PushProbeService } from './push-probe.service';

describe('PushProbeService', () => {
  let service: PushProbeService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(PushProbeService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
      vi.useRealTimers();
    }
  });

  it('uses only the authenticated session, without uploading a target token', async () => {
    const result = service.create();
    const request = http.expectOne('/api/v1/devices/push-probes');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    request.flush({
      code: 0,
      data: { probeId: 'p', stage: 'provider_accepted' },
    });
    expect(await result).toMatchObject({
      probeId: 'p',
      stage: 'provider_accepted',
    });
  });

  it('surfaces API envelope failures for inline diagnostics', async () => {
    const result = service.create();
    const assertion = expect(result).rejects.toThrow('Not registered');
    http
      .expectOne('/api/v1/devices/push-probes')
      .flush({ code: 1, message: 'Not registered' });
    await assertion;
  });

  it('bounds slow status requests by the remaining receipt deadline', async () => {
    vi.useFakeTimers();
    const result = service.get('p', 1500);
    const assertion = expect(result).rejects.toThrow();
    const request = http.expectOne('/api/v1/devices/push-probes/p');
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    expect(request.cancelled).toBe(true);
  });
});
