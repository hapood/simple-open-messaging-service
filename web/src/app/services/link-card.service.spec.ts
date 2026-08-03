import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { LinkCardService } from './link-card.service';

describe('LinkCardService', () => {
  let service: LinkCardService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(LinkCardService);
    http = TestBed.inject(HttpTestingController);
    void service.loadRules();
    http
      .expectOne('/api/v1/link-card-rules')
      .flush({ code: 0, message: 'ok', data: [] });
  });

  afterEach(() => http.verify());

  it('chooses the first URL in text that matches an enabled hostname rule', () => {
    service.rules.set([
      {
        id: 7,
        matchUrl: 'https://douyin.com',
        hostname: 'douyin.com',
        displayName: 'Douyin',
        includeSubdomains: true,
      },
    ]);
    const match = service.matchFirst(
      'skip https://example.com，看 https://v.douyin.com/a?x=1。 later https://douyin.com/b',
    );
    expect(match?.rule.id).toBe(7);
    expect(match?.url).toBe('https://v.douyin.com/a?x=1');
  });

  it('does not accept lookalike hostnames', () => {
    service.rules.set([
      {
        id: 7,
        matchUrl: 'https://douyin.com',
        hostname: 'douyin.com',
        displayName: 'Douyin',
        includeSubdomains: true,
      },
    ]);
    expect(service.matchFirst('https://douyin.com.evil.example/a')).toBeNull();
  });

  it('shares one favicon request and caches the returned CAS URL', async () => {
    const first = service.faviconUrl(7);
    const second = service.faviconUrl(7);
    http.expectOne('/api/v1/link-card-rules/7/favicon').flush({
      code: 0,
      message: 'ok',
      data: { url: '/uploads/link-favicons/abc.webp' },
    });
    await expectAsync(first).toBeResolvedTo('/uploads/link-favicons/abc.webp');
    await expectAsync(second).toBeResolvedTo('/uploads/link-favicons/abc.webp');
    expect(await service.faviconUrl(7)).toBe('/uploads/link-favicons/abc.webp');
  });
});
