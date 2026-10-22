// Pre-paint bootstrap, loaded synchronously from <head> BEFORE the stylesheet and Angular boot, so the
// very first frame follows the OS theme + browser language with no flash (FOUC). Persisted preferences live
// in async IndexedDB/SQLite and are applied by Angular immediately after bootstrap.
// 'self' script (not inline) so the somsapp:// CSP `script-src 'self'` admits it without a nonce or
// 'unsafe-inline' — an inline <script> here is blocked by that policy. Classic (no defer/type=module) so
// it executes during head parsing, before <body> paints. Angular's ThemeService / LanguageService
// re-assert and own these attributes at runtime after boot.
(function () {
  var dark = window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#11161b' : '#f3f3f1');
})();

(function () {
  var lang = navigator.language && navigator.language.toLowerCase().indexOf('zh') === 0
    ? 'zh-CN'
    : 'en';
  document.documentElement.setAttribute('lang', lang);
})();
