/**
 * Runtime detection + URL rewriting for the Tauri desktop shell.
 *
 * The Angular app is built once and runs in two contexts:
 *  - Browser: served same-origin by NestJS; all URLs relative; media authenticated by the
 *    httpOnly `media_token` cookie set on login.
 *  - Tauri desktop webview: loaded from local assets at a non-HTTP origin (tauri://localhost on
 *    macOS, https://tauri.localhost on Windows, http://tauri.localhost on Linux). The shell
 *    injects `window.__SOMS_API_ORIGIN__` (the absolute backend origin) via an initialization
 *    script that runs before any page script, so API/SSE URLs resolve cross-origin. Media can't
 *    use the cookie (SameSite=Strict suppresses it cross-origin) and a bare `<img src>` / CSS
 *    `url()` can't carry an Authorization header, so `/uploads/*` is rewritten to a
 *    `media://localhost` custom URI scheme handled by a Rust-side proxy that injects the header.
 *
 * Browser behavior is bit-for-bit unchanged when the globals are absent: every helper falls back
 * to the same-origin relative path.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __SOMS_API_ORIGIN__?: string;
    /** Exposed by Tauri v2 when `app.withGlobalTauri` is true (see src-tauri/tauri.conf.json). Used
     *  instead of the `@tauri-apps/api` npm package so the browser build has zero extra deps and the
     *  Tauri surface is unreachable outside the shell. */
    __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  }
}

/** True when running inside the Tauri desktop webview. Detected via the IPC global Tauri injects
 *  before page scripts run — no SDK import needed. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

/** Invoke a Tauri command (only meaningful when `isTauri()`). Resolves the command's return value;
 *  rejects if not in Tauri or the command errors. Callers MUST guard with `isTauri()` and swallow
 *  errors for non-critical handoffs (e.g. token sync to the media proxy). */
export function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = typeof window !== 'undefined' ? window.__TAURI__?.core?.invoke : undefined;
  if (!invoke) return Promise.reject(new Error('not in Tauri'));
  return invoke(cmd, args) as Promise<T>;
}

/** Absolute backend origin for cross-origin clients (Tauri shell), or `''` for same-origin
 *  (browser). Read once at module load; the Tauri initialization script runs before any module is
 *  evaluated, so this is always populated under Tauri and always empty in the browser. */
const API_ORIGIN: string =
  typeof window !== 'undefined' && typeof window.__SOMS_API_ORIGIN__ === 'string'
    ? window.__SOMS_API_ORIGIN__
    : '';

export { API_ORIGIN as apiOrigin };

/** Custom URI scheme the Tauri Rust side registers (see `src-tauri/src/lib.rs`) to proxy
 *  `/uploads/*` media with a Bearer header. */
export const MEDIA_SCHEME = 'media';
const MEDIA_HOST = 'localhost';

/**
 * Rewrite a server-relative media URL for the current runtime.
 *  - Browser → the bare path (same-origin; the httpOnly `media_token` cookie authenticates it).
 *  - Tauri   → `media://localhost<path>`, served by the Rust URI-scheme proxy, which forwards to
 *              `${apiOrigin}${path}` with `Authorization: Bearer` (the cookie can't cross origins
 *              and a bare `<img src>`/CSS `url()` can't set headers).
 * Already-absolute URLs (`data:`, `blob:`, `http:`, `https:`) pass through unchanged.
 */
export function assetUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (!path.startsWith('/')) return path; // absolute (data:/blob:/http(s):) — leave as-is
  if (!isTauri()) return path;
  return `${MEDIA_SCHEME}://${MEDIA_HOST}${path}`;
}
