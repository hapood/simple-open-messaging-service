import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LinkCardService } from './link-card.service';

describe('LinkCardService', () => {
  let service: LinkCardService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    service = TestBed.inject(LinkCardService);
  });

  it('chooses the first HTTP URL in text', () => {
    const match = service.matchFirst(
      'skip https://example.com，看 https://v.douyin.com/a?x=1。 later https://douyin.com/b',
    );
    expect(match?.url).toBe('https://example.com');
  });

  it('rejects unsupported URL protocols', () => {
    expect(service.matchFirst('ftp://example.com/a')).toBeNull();
  });

  it('extracts the first URL', () => {
    expect(
      service.firstUrl(
        'look https://outside.example/a, then https://youtube.com',
      ),
    ).toBe('https://outside.example/a');
  });
});
