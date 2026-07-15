import { canonicalOrigin } from './runtime';

/**
 * canonicalOrigin unit tests — the //api/v1 prevention.
 *
 * The apiOrigin signal is a path-concatenation BASE: every request URL is built as
 * `${apiOrigin()}/api/v1/...` (and the Rust media proxy as `${origin}/uploads/...`). A trailing slash on
 * the origin doubles into `//api/v1`, which Fastify 404s — and users DO type a trailing slash in the
 * server-config form. canonicalOrigin is the single guarantee that the signal never carries one: it is
 * applied at the seed (so even an older build's persisted trailing-slash value is normalized) and the
 * Rust `validate_origin` strips on save. These cases pin that contract directly. Pure: no Angular
 * surface (mirrors biz-code / merge-items specs).
 */
describe('canonicalOrigin', () => {
  it('strips a single trailing slash (the regression this guards)', () => {
    expect(canonicalOrigin('https://soms.example.com:7667/')).toBe('https://soms.example.com:7667');
  });

  it('strips multiple trailing slashes', () => {
    expect(canonicalOrigin('https://soms.example.com:7667///')).toBe('https://soms.example.com:7667');
  });

  it('leaves a slash-free origin unchanged', () => {
    expect(canonicalOrigin('https://soms.example.com:7667')).toBe('https://soms.example.com:7667');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalOrigin('  https://soms.example.com:7667/  ')).toBe('https://soms.example.com:7667');
  });

  it('only strips the tail — an embedded path is otherwise preserved', () => {
    expect(canonicalOrigin('https://host/sub/path/')).toBe('https://host/sub/path');
  });

  it('empty stays empty (unconfigured origin)', () => {
    expect(canonicalOrigin('')).toBe('');
  });

  it('whitespace-only collapses to empty', () => {
    expect(canonicalOrigin('   ')).toBe('');
  });

  it('produces no "//api" when concatenated onto an api/v1 path', () => {
    const origin = canonicalOrigin('https://soms.example.com:7667/');
    const url = `${origin}/api/v1/auth/login`;
    // Exact equality is the guard: if canonicalOrigin failed to strip the trailing slash, `url` would be
    // "...7667//api/v1/auth/login" and would not match. (Asserting `.not.toContain('//')` directly is a
    // trap — every https URL contains "//" in its scheme.)
    expect(url).toBe('https://soms.example.com:7667/api/v1/auth/login');
  });
});
