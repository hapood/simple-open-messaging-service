import {
  assetUrl,
  canonicalOrigin,
  chatThumbnailUrl,
  nativeVideoThumbnailUrl,
  videoCasDigest,
} from './runtime';

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

describe('assetUrl', () => {
  const originalTauriInternals = window.__TAURI_INTERNALS__;
  const originalUserAgent = navigator.userAgent;

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
  });

  function setRuntime(tauri: boolean, userAgent: string): void {
    window.__TAURI_INTERNALS__ = tauri ? {} : undefined;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: userAgent,
    });
  }

  it('uses the Android HTTP custom-protocol mapping', () => {
    setRuntime(true, 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36');
    expect(assetUrl('/uploads/cas/a.png')).toBe(
      'http://media.localhost/uploads/cas/a.png',
    );
  });

  it('uses the Windows HTTP custom-protocol mapping', () => {
    setRuntime(true, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(assetUrl('/uploads/cas/a.png')).toBe(
      'http://media.localhost/uploads/cas/a.png',
    );
  });

  it('keeps the native scheme on other Tauri platforms', () => {
    setRuntime(true, 'Mozilla/5.0 (X11; Linux x86_64)');
    expect(assetUrl('/uploads/cas/a.png')).toBe(
      'media://localhost/uploads/cas/a.png',
    );
  });

  it('keeps relative paths unchanged in the browser', () => {
    setRuntime(false, 'Mozilla/5.0 (Linux; Android 15)');
    expect(assetUrl('/uploads/cas/a.png')).toBe('/uploads/cas/a.png');
  });

  it('maps a native chat image onto the thumbnail protocol path', () => {
    setRuntime(true, 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36');
    expect(chatThumbnailUrl('/uploads/cas/aa/bb/photo.jpg')).toBe(
      'http://media.localhost/chat-thumbnails/uploads/cas/aa/bb/photo.jpg',
    );
  });

  it('keeps browser and optimistic image URLs unchanged', () => {
    setRuntime(false, 'Mozilla/5.0 (Linux; Android 15)');
    expect(chatThumbnailUrl('/uploads/cas/aa/bb/photo.jpg')).toBe(
      '/uploads/cas/aa/bb/photo.jpg',
    );
    expect(chatThumbnailUrl('blob:test')).toBe('blob:test');
  });

  it('extracts only a canonical CAS digest and builds the Android local-thumbnail URL', () => {
    setRuntime(true, 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36');
    const digest = 'ab'.repeat(32);
    const path = `/uploads/cas/ab/cd/${digest}`;
    expect(videoCasDigest(path)).toBe(digest);
    expect(nativeVideoThumbnailUrl(path, 2)).toBe(
      `http://media.localhost/video-thumbnails${path}?v=2`,
    );
  });

  it('does not invent an identity for a non-CAS video URL', () => {
    setRuntime(true, 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36');
    expect(videoCasDigest('https://cdn.example/video.mp4')).toBeNull();
    expect(nativeVideoThumbnailUrl('https://cdn.example/video.mp4')).toBe('');
  });
});
