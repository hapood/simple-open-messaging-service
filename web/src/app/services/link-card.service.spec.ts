import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
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
        provideHttpClient(withXhr()),
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
        hostname: 'douyin.com',
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
        hostname: 'douyin.com',
      },
    ]);
    expect(service.matchFirst('https://douyin.com.evil.example/a')).toBeNull();
  });

  it('extracts the first URL even when it is outside the automatic allowlist', () => {
    expect(
      service.firstUrl(
        'look https://outside.example/a, then https://youtube.com',
      ),
    ).toBe('https://outside.example/a');
  });
});
