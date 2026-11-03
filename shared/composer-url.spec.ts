import { describe, expect, it } from 'vitest';
import { detectComposerUrls } from './composer-url';

describe('native-compatible composer URL detection', () => {
  it.each([
    ['abchttps://x', 'https://x', 3],
    ['HTTP://x', 'HTTP://x', 0],
    ['--Https://x', 'Https://x', 2],
    ['https://example.com', 'https://example.com', 0],
    ['😀https://example.com', 'https://example.com', 2],
  ])('detects %s without trailing whitespace', (text, href, start) => {
    expect(detectComposerUrls(text)).toEqual([
      { href, start, end: text.length },
    ]);
  });

  it('ends runs at whitespace and recognizes multiple URLs', () => {
    expect(
      detectComposerUrls('https://a\u00a0HTTP://b\nhttps://c').map(
        (x) => x.href,
      ),
    ).toEqual(['https://a', 'HTTP://b', 'https://c']);
  });

  it('matches native first-scheme and punctuation behavior', () => {
    expect(detectComposerUrls('(https://a),https://b')[0].href).toBe(
      'https://a),https://b',
    );
  });

  it('does not recognize incomplete schemes or bare domains', () => {
    expect(detectComposerUrls('https:/ example.com ftp://example.com')).toEqual(
      [],
    );
    expect(detectComposerUrls('')).toEqual([]);
  });
});
