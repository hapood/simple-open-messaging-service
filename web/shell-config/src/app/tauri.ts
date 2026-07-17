/**
 * Trimmed Tauri bridge for the shell-config bootstrap. The bootstrap intentionally does NOT import the
 * main app's `runtime.ts` (which pulls in @tauri-apps/plugin-http, Angular signals, the SomsFcm /
 * SomsSecureStore global typings, installNativeFetch, eruda hooks, …). This ~30-line helper has only
 * what the bootstrap needs: isTauri, tauriInvoke, emitTauriEvent (the `init-ready` signal Rust gates the
 * window show on), and canonicalOrigin.
 *
 * `window.__TAURI__` is injected by Tauri v2 when `app.withGlobalTauri: true` (src-tauri/tauri.conf.json)
 * — into BOTH windows (init + main), so the bootstrap reaches it the same way the SPA does.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: {
      core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      event?: { emit: (event: string, payload?: unknown) => Promise<void> | void };
    };
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

/** Invoke a Rust command (only meaningful when isTauri()). Rejects with the command's Err(String). */
export function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = typeof window !== 'undefined' ? window.__TAURI__?.core?.invoke : undefined;
  if (!invoke) return Promise.reject(new Error('not in Tauri'));
  return invoke(cmd, args) as Promise<T>;
}

/** Emit a Tauri event the Rust side listens for (e.g. `init-ready` → show this window; `spa-ready` on the
 *  main SPA → Rust crossfades it in). No-op when not in the shell. */
export function emitTauriEvent(event: string, payload?: unknown): void {
  const emit = typeof window !== 'undefined' ? window.__TAURI__?.event?.emit : undefined;
  if (emit) emit(event, payload ?? null);
}

/** Canonicalize a backend origin: trim + strip trailing slash(es) so it is a safe path-concatenation
 *  base (a trailing slash doubles it into `//api/v1`, which Fastify 404s on). Mirrors Rust's
 *  validate_origin strip + the main app's canonicalOrigin. */
export function canonicalOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** The bootstrap's current origin is insecure (no TLS) — used to show the "not secure" warning live
 *  while editing, and to explain the cert step will be skipped. */
export function originIsInsecure(origin: string): boolean {
  const o = origin.trim();
  if (!o) return true;
  return !/^https:\/\//i.test(o);
}
