import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { LinkCardGenerationService } from './link-card-generation.service';

describe('LinkCardGenerationService', () => {
  let service: LinkCardGenerationService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(LinkCardGenerationService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('starts a generation with URL and description fallback text', () => {
    service.start('https://example.com', 'hello').subscribe();

    const request = http.expectOne('/api/v1/link-preview/generations');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      url: 'https://example.com',
      text: 'hello',
    });
    request.flush({ code: 0, message: 'ok', data: {} });
  });

  it('offers the current generation id to the server on a user retry', () => {
    service.start('https://example.com', 'hello', 'current-id').subscribe();

    const request = http.expectOne('/api/v1/link-preview/generations');
    expect(request.request.body).toEqual({
      url: 'https://example.com',
      text: 'hello',
      generationId: 'current-id',
    });
    request.flush({ code: 0, message: 'ok', data: {} });
  });

  it('encodes the generation id when polling', () => {
    service.get('id/with space').subscribe();

    const request = http.expectOne(
      '/api/v1/link-preview/generations/id%2Fwith%20space',
    );
    expect(request.request.method).toBe('GET');
    request.flush({ code: 0, message: 'ok', data: {} });
  });

  it('cancels a pending start on unsubscribe without publishing state', () => {
    const next = vi.fn();
    const subscription = service.begin$('https://example.com').subscribe(next);
    const request = http.expectOne('/api/v1/link-preview/generations');
    subscription.unsubscribe();
    expect(request.cancelled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['pause', 'forget'] as const)(
    '%s cancels in-flight polling without restarting it',
    async (action) => {
      vi.useFakeTimers();
      try {
        service.resume({
          generationId: 'cancel-me',
          status: 'pending',
          expiresAt: Date.now() + 60000,
        });
        await vi.advanceTimersByTimeAsync(0);
        const request = http.expectOne(
          '/api/v1/link-preview/generations/cancel-me',
        );
        service[action]('cancel-me');
        expect(request.cancelled).toBe(true);
        if (action === 'forget')
          expect(service.snapshot('cancel-me')).toBeUndefined();
        else
          expect(service.snapshot('cancel-me')).toMatchObject({
            status: 'pending',
            polling: false,
          });
        await vi.advanceTimersByTimeAsync(30000);
        http.expectNone('/api/v1/link-preview/generations/cancel-me');
        service.resume({
          generationId: 'cancel-me',
          status: 'pending',
          expiresAt: Date.now() + 60000,
        });
        await vi.advanceTimersByTimeAsync(0);
        http.expectOne('/api/v1/link-preview/generations/cancel-me').flush({
          data: {
            generationId: 'cancel-me',
            status: 'succeeded',
            expiresAt: Date.now() + 60000,
          },
        });
        expect(service.snapshot('cancel-me')).toMatchObject({
          status: 'succeeded',
          polling: false,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not create parallel polling when resumed during an in-flight request', async () => {
    vi.useFakeTimers();
    try {
      const generation = {
        generationId: 'single',
        status: 'pending' as const,
        expiresAt: Date.now() + 60000,
      };
      service.resume(generation);
      await vi.advanceTimersByTimeAsync(0);
      const request = http.expectOne('/api/v1/link-preview/generations/single');
      service.resume(generation);
      await vi.advanceTimersByTimeAsync(1000);
      http.expectNone('/api/v1/link-preview/generations/single');
      request.flush({ data: generation });
      await vi.advanceTimersByTimeAsync(600);
      const next = http.expectOne('/api/v1/link-preview/generations/single');
      service.pause('single');
      expect(next.cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses the scheduled next poll before another HTTP request starts', async () => {
    vi.useFakeTimers();
    try {
      const generation = {
        generationId: 'scheduled',
        status: 'pending' as const,
        expiresAt: Date.now() + 60000,
      };
      service.resume(generation);
      await vi.advanceTimersByTimeAsync(0);
      http
        .expectOne('/api/v1/link-preview/generations/scheduled')
        .flush({ data: generation });
      service.pause('scheduled');
      await vi.advanceTimersByTimeAsync(30000);
      http.expectNone('/api/v1/link-preview/generations/scheduled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after a polling error until the user explicitly retries', async () => {
    service.resume({
      generationId: 'generation-1',
      status: 'pending',
      expiresAt: Date.now() + 60000,
    });

    const request = await vi.waitFor(() =>
      http.expectOne('/api/v1/link-preview/generations/generation-1'),
    );
    request.flush(
      { code: 1, message: 'temporary failure' },
      { status: 503, statusText: 'Service Unavailable' },
    );

    await vi.waitFor(() =>
      expect(service.snapshot('generation-1')).toEqual(
        expect.objectContaining({
          status: 'failed',
          polling: false,
          unavailable: true,
        }),
      ),
    );

    // Deterministic negative: sweep a generous virtual window on the fake clock — the poll loop
    // schedules its next tick via setTimeout, so any would-be retry would fire here.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      vi.useRealTimers();
    }
    http.expectNone('/api/v1/link-preview/generations/generation-1');
  });
});
