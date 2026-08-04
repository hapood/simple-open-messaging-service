import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { LinkCardGenerationService } from './link-card-generation.service';

describe('LinkCardGenerationService', () => {
  let service: LinkCardGenerationService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
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

  it('stops after a polling error until the user explicitly retries', async () => {
    service.resume({
      generationId: 'generation-1',
      status: 'pending',
      expiresAt: Date.now() + 60_000,
    });

    await delay(0);
    const request = http.expectOne(
      '/api/v1/link-preview/generations/generation-1',
    );
    request.flush(
      { code: 1, message: 'temporary failure' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await delay(0);

    expect(service.snapshot('generation-1')).toEqual(
      jasmine.objectContaining({
        status: 'failed',
        polling: false,
        unavailable: true,
      }),
    );

    await delay(700);
    http.expectNone('/api/v1/link-preview/generations/generation-1');
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
