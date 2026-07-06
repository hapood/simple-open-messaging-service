import { describe, it, expect } from 'vitest';
import {
  parseFileContent,
  parseFileExt,
  resolveFileType,
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

describe('parseFileExt', () => {
  it('lowercases the extension and strips any directory component', () => {
    expect(parseFileExt('report.PDF')).toBe('pdf');
    expect(parseFileExt('a/b\\c/archive.ZIP')).toBe('zip');
  });

  it('returns "" for no extension, non-alpha extensions, or over-long extensions', () => {
    expect(parseFileExt('Makefile')).toBe('');
    expect(parseFileExt('weird.<x>')).toBe('');
    expect(parseFileExt('a.htaccess')).toBe('htaccess'); // alpha, <=16 → accepted (open model)
    expect(parseFileExt(`a.${'x'.repeat(17)}`)).toBe(''); // > 16 chars → dropped
  });
});

describe('resolveFileType', () => {
  it('derives ext from the filename and trusts a valid client-declared MIME for display', () => {
    expect(resolveFileType('doc.pdf', 'application/pdf')).toEqual({
      ext: 'pdf',
      mime: 'application/pdf',
    });
  });

  it('falls back to application/octet-stream when the declared MIME is absent or malformed', () => {
    // The common bug: browsers leave File.type empty for many extensions.
    expect(resolveFileType('data.docx', '')).toEqual({ ext: 'docx', mime: 'application/octet-stream' });
    expect(resolveFileType('data.docx', 'not a mime')).toEqual({ ext: 'docx', mime: 'application/octet-stream' });
  });

  it('accepts ANY extension (open model — no whitelist) and empty extensions', () => {
    expect(resolveFileType('weird.zzz', 'application/octet-stream')).toEqual({ ext: 'zzz', mime: 'application/octet-stream' });
    expect(resolveFileType('Makefile', '')).toEqual({ ext: '', mime: 'application/octet-stream' });
  });
});

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

  it('accepts any non-empty mimeType (open model — no whitelist)', () => {
    // The whitelist was removed: any type is admissible at the content layer (serving-side
    // headers carry the security). Only an EMPTY mimeType is rejected.
    expect(parseFileContent(ok({ mimeType: 'application/x-msdownload' }))).not.toBeNull();
    expect(parseFileContent(ok({ mimeType: 'application/octet-stream' }))).not.toBeNull();
    expect(parseFileContent(ok({ mimeType: 'weird/anything' }))).not.toBeNull();
    expect(parseFileContent(ok({ mimeType: '' }))).toBeNull();
  });

  it('accepts a URL with no extension (a file stored without a safe extension)', () => {
    expect(parseFileContent(ok({ url: '/uploads/1700000000000-abcdef012345' }))).not.toBeNull();
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
