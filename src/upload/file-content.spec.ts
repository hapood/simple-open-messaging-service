import { describe, it, expect } from 'vitest';
import {
  parseFileContent,
  FILE_MIME_EXT,
  MAX_FILE_BYTES,
} from './file-content.js';

/** A content blob as the client forwards it (verbatim from POST /upload/file). */
function ok(over: Partial<{ url: string; name: string; size: number; mimeType: string }> = {}) {
  return JSON.stringify({
    url: '/uploads/1700000000000-abcdef012345.pdf',
    name: 'report.pdf',
    size: 12345,
    mimeType: 'application/pdf',
    ...over,
  });
}

describe('parseFileContent', () => {
  it('accepts a well-formed FILE content blob', () => {
    expect(parseFileContent(ok())).toEqual({
      url: '/uploads/1700000000000-abcdef012345.pdf',
      name: 'report.pdf',
      size: 12345,
      mimeType: 'application/pdf',
    });
  });

  it('rejects non-JSON / non-object content', () => {
    expect(parseFileContent('not json')).toBeNull();
    expect(parseFileContent('"a string"')).toBeNull();
    expect(parseFileContent('123')).toBeNull();
    expect(parseFileContent('null')).toBeNull();
  });

  it('rejects a wrong-typed field', () => {
    expect(parseFileContent(ok({ url: 5 } as never))).toBeNull();
    expect(parseFileContent(ok({ size: '12' } as never))).toBeNull();
    expect(parseFileContent(ok({ name: 7 } as never))).toBeNull();
  });

  // Defense against forging a dangerous URL into the rendered download link.
  it('rejects non-upload / external / traversal / javascript URLs', () => {
    expect(parseFileContent(ok({ url: 'https://evil.example/x.pdf' }))).toBeNull();
    expect(parseFileContent(ok({ url: 'javascript:alert(1)' }))).toBeNull();
    expect(parseFileContent(ok({ url: '/uploads/../secret' }))).toBeNull();
    expect(parseFileContent(ok({ url: '/uploads/a/b.pdf' }))).toBeNull(); // extra slash → traversal vector
    expect(parseFileContent(ok({ url: '/uploads/x.pdf?disposition=inline' }))).toBeNull();
    expect(parseFileContent(ok({ url: '/other/x.pdf' }))).toBeNull();
  });

  it('rejects a mimetype outside the whitelist (e.g. an executable)', () => {
    expect(parseFileContent(ok({ mimeType: 'application/x-msdownload' }))).toBeNull();
    expect(parseFileContent(ok({ mimeType: 'image/png' }))).toBeNull(); // images are not FILEs
  });

  it('every whitelist key round-trips as a valid mimeType', () => {
    for (const mime of Object.keys(FILE_MIME_EXT)) {
      expect(parseFileContent(ok({ mimeType: mime }))).not.toBeNull();
    }
  });

  it('rejects non-positive, non-finite, or over-capacity sizes', () => {
    expect(parseFileContent(ok({ size: 0 }))).toBeNull();
    expect(parseFileContent(ok({ size: -1 }))).toBeNull();
    expect(parseFileContent(ok({ size: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseFileContent(ok({ size: MAX_FILE_BYTES + 1 }))).toBeNull();
    expect(parseFileContent(ok({ size: MAX_FILE_BYTES }))).not.toBeNull(); // boundary inclusive
  });

  it('rejects an empty or over-long display name', () => {
    expect(parseFileContent(ok({ name: '' }))).toBeNull();
    expect(parseFileContent(ok({ name: 'x'.repeat(101) }))).toBeNull();
    expect(parseFileContent(ok({ name: 'x'.repeat(100) }))).not.toBeNull(); // boundary inclusive
  });
});
