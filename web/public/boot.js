// Pre-paint bootstrap, loaded synchronously from <head> BEFORE the stylesheet and Angular boot, so the
// very first frame carries the persisted theme + language with no flash (FOUC). Kept as an EXTERNAL
// 'self' script (not inline) so the somsapp:// CSP `script-src 'self'` admits it without a nonce or
// 'unsafe-inline' — an inline <script> here is blocked by that policy. Classic (no defer/type=module) so
// it executes during head parsing, before <body> paints. Angular's ThemeService / LanguageService
// re-assert and own these attributes at runtime after boot.
(function () {
  try {
    var stored = localStorage.getItem('soms.theme');
    var mode = (stored === 'light' || stored === 'dark') ? stored : 'system';
    var dark = mode === 'dark' ||
      (mode === 'system' && window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b141a' : '#2196f3');
  } catch (e) { /* localStorage disabled — ThemeService applies the default */ }
})();

(function () {
  try {
    var stored = localStorage.getItem('soms.lang');
    var lang = (stored === 'en' || stored === 'zh-CN')
      ? stored
      : (navigator.language && navigator.language.toLowerCase().indexOf('zh') === 0 ? 'zh-CN' : 'en');
    document.documentElement.setAttribute('lang', lang);
  } catch (e) { /* localStorage disabled — LanguageService applies the default */ }
})();
