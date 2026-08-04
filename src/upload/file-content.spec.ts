import { describe, it, expect } from 'vitest';
import {
  parseFileContent,
  parseFileExt,
  parseLinkContent,
  resolveFileType,
  MAX_FILE_BYTES,
} from './file-content.js';

/** A content blob as the client forwards it (verbatim from POST /upload/file). */
function ok(
  over: Partial<{
    url: string;
    name: string;
    size: number;
    mimeType: string;
  }> = {},
) {
  return JSON.stringify({
    url: '/uploads/msg-assets/01/23/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
    expect(resolveFileType('data.docx', '')).toEqual({
      ext: 'docx',
      mime: 'application/octet-stream',
    });
    expect(resolveFileType('data.docx', 'not a mime')).toEqual({
      ext: 'docx',
      mime: 'application/octet-stream',
    });
  });

  it('accepts ANY extension (open model — no whitelist) and empty extensions', () => {
    expect(resolveFileType('weird.zzz', 'application/octet-stream')).toEqual({
      ext: 'zzz',
      mime: 'application/octet-stream',
    });
    expect(resolveFileType('Makefile', '')).toEqual({
      ext: '',
      mime: 'application/octet-stream',
    });
  });
});

describe('parseFileContent', () => {
  it('accepts a well-formed FILE content blob', () => {
    expect(parseFileContent(ok())).toEqual({
      url: '/uploads/msg-assets/01/23/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
    expect(
      parseFileContent(ok({ url: 'https://evil.example/x.pdf' })),
    ).toBeNull();
    expect(parseFileContent(ok({ url: 'javascript:alert(1)' }))).toBeNull();
    expect(parseFileContent(ok({ url: '/uploads/../secret' }))).toBeNull();
    expect(parseFileContent(ok({ url: '/uploads/a/b.pdf' }))).toBeNull(); // extra slash → traversal vector
    expect(
      parseFileContent(ok({ url: '/uploads/x.pdf?disposition=inline' })),
    ).toBeNull();
    expect(parseFileContent(ok({ url: '/other/x.pdf' }))).toBeNull();
  });

  it('accepts any non-empty mimeType (open model — no whitelist)', () => {
    // The whitelist was removed: any type is admissible at the content layer (serving-side
    // headers carry the security). Only an EMPTY mimeType is rejected.
    expect(
      parseFileContent(ok({ mimeType: 'application/x-msdownload' })),
    ).not.toBeNull();
    expect(
      parseFileContent(ok({ mimeType: 'application/octet-stream' })),
    ).not.toBeNull();
    expect(parseFileContent(ok({ mimeType: 'weird/anything' }))).not.toBeNull();
    expect(parseFileContent(ok({ mimeType: '' }))).toBeNull();
  });

  it('rejects a legacy flat (pre-CAS) upload URL — a CAS shard URL is the only accepted shape', () => {
    expect(
      parseFileContent(ok({ url: '/uploads/1700000000000-abcdef012345.pdf' })),
    ).toBeNull();
    expect(
      parseFileContent(ok({ url: '/uploads/1700000000000-abcdef012345' })),
    ).toBeNull();
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

describe('parseLinkContent', () => {
  // The thumbnail's sha256 digest (64 hex) — the form stored in the DB; the wire inlines base64.
  const DIGEST = '0'.repeat(64);

  it('requires title and description, while allowing both to be empty', () => {
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://example.com',
          title: '',
          description: '',
        }),
      ),
    ).toEqual({
      url: 'https://example.com',
      title: '',
      description: '',
    });
    expect(
      parseLinkContent(JSON.stringify({ url: 'https://example.com' })),
    ).toBeNull();
  });

  it('accepts a full card with message-asset URLs', () => {
    const card = {
      url: 'https://example.com/p',
      title: 'T',
      description: 'D',
      image: `/uploads/msg-assets/00/00/${DIGEST}`,
      favicon: `/uploads/msg-assets/11/11/${'1'.repeat(64)}`,
    };
    expect(parseLinkContent(JSON.stringify(card))).toEqual(card);
  });

  it('rejects non-JSON / non-object content', () => {
    expect(parseLinkContent('not json')).toBeNull();
    expect(parseLinkContent('"s"')).toBeNull();
    expect(parseLinkContent('12')).toBeNull();
    expect(parseLinkContent('null')).toBeNull();
  });

  it('rejects a non-http(s) url (the SSRF/integrity form check)', () => {
    expect(
      parseLinkContent(JSON.stringify({ url: 'javascript:alert(1)' })),
    ).toBeNull();
    expect(
      parseLinkContent(JSON.stringify({ url: 'ftp://example.com' })),
    ).toBeNull();
    expect(
      parseLinkContent(JSON.stringify({ url: 'data:text/html,x' })),
    ).toBeNull();
    expect(
      parseLinkContent(JSON.stringify({ url: '//example.com' })),
    ).toBeNull(); // scheme-relative
  });

  it('rejects an image outside the message-asset URL namespace', () => {
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: '',
          description: '',
          image: 'https://evil/x.jpg',
        }),
      ),
    ).toBeNull();
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: '',
          description: '',
          image: 'javascript:alert(1)',
        }),
      ),
    ).toBeNull();
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: '',
          description: '',
          image: '/uploads/../secret',
        }),
      ),
    ).toBeNull();
    // Old paths and filename suffixes are not valid message-asset URLs.
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: '',
          description: '',
          image: `/uploads/cas/00/00/${DIGEST}.webp`,
        }),
      ),
    ).toBeNull();
    // A base64 data URI is the WIRE form, not the STORED form → rejected at store-time.
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: '',
          description: '',
          image: 'data:image/webp;base64,AAAA',
        }),
      ),
    ).toBeNull();
  });

  it('rejects over-long display fields', () => {
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: 'x'.repeat(301),
          description: '',
        }),
      ),
    ).toBeNull();
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: '',
          description: 'x'.repeat(501),
        }),
      ),
    ).toBeNull();
  });

  it('accepts boundary-length display fields', () => {
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: 'x'.repeat(300),
          description: '',
        }),
      ),
    ).not.toBeNull();
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: '',
          description: 'x'.repeat(500),
        }),
      ),
    ).not.toBeNull();
  });

  it('rejects wrong-typed fields', () => {
    expect(parseLinkContent(JSON.stringify({ url: 5 }))).toBeNull();
    expect(
      parseLinkContent(
        JSON.stringify({ url: 'https://x.com', title: 5, description: '' }),
      ),
    ).toBeNull();
    expect(
      parseLinkContent(
        JSON.stringify({
          url: 'https://x.com',
          title: '',
          description: '',
          image: 5,
        }),
      ),
    ).toBeNull();
  });

  it('rejects legacy and unknown fields', () => {
    const base = { url: 'https://x.com', title: '', description: '' };
    expect(
      parseLinkContent(JSON.stringify({ ...base, siteName: 'X' })),
    ).toBeNull();
    expect(
      parseLinkContent(JSON.stringify({ ...base, version: 1 })),
    ).toBeNull();
  });

  it('validates favicon as a message-asset URL', () => {
    const base = { url: 'https://x.com', title: '', description: '' };
    expect(
      parseLinkContent(
        JSON.stringify({
          ...base,
          favicon: `/uploads/msg-assets/00/00/${DIGEST}`,
        }),
      ),
    ).not.toBeNull();
    expect(
      parseLinkContent(
        JSON.stringify({ ...base, favicon: 'https://x.com/favicon.ico' }),
      ),
    ).toBeNull();
  });
});
