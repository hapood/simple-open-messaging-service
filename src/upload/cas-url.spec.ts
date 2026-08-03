import { describe, expect, it } from 'vitest';
import { contextualCasUrl, contextualizeCasUrls } from './cas-url.js';

const digest = 'ab'.repeat(32);
const bare = `/uploads/cas/ab/ab/${digest}`;

describe('contextual CAS URLs', () => {
  it('binds a bare URL to its carrier message', () => {
    expect(contextualCasUrl(digest, 12, 0)).toBe(`${bare}?threadId=12&seq=0`);
    expect(
      contextualizeCasUrls(JSON.stringify({ url: bare }), 12, 7),
    ).toContain(`${bare}?threadId=12&seq=7`);
  });

  it('rebinds a forwarded URL to the destination carrier', () => {
    const source = `${bare}?threadId=3&seq=9`;
    expect(contextualizeCasUrls(source, 44, 18)).toBe(
      `${bare}?threadId=44&seq=18`,
    );
  });
});
