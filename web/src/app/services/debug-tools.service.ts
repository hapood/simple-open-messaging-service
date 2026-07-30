import { Injectable, isDevMode, signal } from '@angular/core';
import { setFullConsoleLogging } from './log-buffer';
import { isTauri, tauriInvoke } from './runtime';

const STORAGE_KEY = 'soms-debug';
/** Number of quick taps on the app-version label that toggles the debug tools in production. */
const GESTURE_TAPS = 10;
/** Taps must land within this window to count as one gesture (resets otherwise). */
const GESTURE_WINDOW_MS = 2000;

/**
 * Runtime gate for the client-side debug surface (currently the 3-layer log panel). Not a build-time strip:
 * the panel is always compiled in, and this signal decides whether it renders — so production can turn it
 * on later without a rebuild.
 *
 * Enabled when EITHER holds:
 *  - the running bundle is a dev build (`isDevMode()` — auto-on for `ng serve` / dev), OR
 *  - the hidden entry flipped the persisted flag: tapping the app-version label `GESTURE_TAPS` times, or
 *    loading with `?debug=1` in the URL. Persisted in `localStorage` so it survives reloads.
 *
 * Dev builds read the flag as a no-op (always on); the
 * persisted flag is the only production path. Kept as a plain signal (no persistence effect) so reads are
 * synchronous — the FAB/overlay query `enabled()` directly in their templates.
 */
@Injectable({ providedIn: 'root' })
export class DebugToolsService {
  private readonly persisted = this.readPersisted();
  readonly enabled = signal<boolean>(this.isDevBuild() || this.persisted);

  private gestureCount = 0;
  private gestureResetAt = 0;

  constructor() {
    // `?debug=1` on the launch URL persists the flag (+ enables this session). Lets support staff enable
    // the panel by sharing a link, without a rebuild or a gesture.
    try {
      if (typeof URLSearchParams !== 'undefined') {
        const debug = new URLSearchParams(globalThis.location?.search ?? '').get('debug');
        if (debug === '1') this.setPersisted(true);
      }
    } catch {
      // Non-browser / no `location` (e.g. a worker) — nothing to do.
    }
    this.applyLogging(this.enabled());
  }

  /** Flip the persisted flag. Dev builds stay enabled regardless (the flag only governs production). */
  toggle(): void {
    this.setPersisted(!this.readPersisted());
  }

  /** Wire to the app-version label: `GESTURE_TAPS` taps within the window → toggle. */
  bumpGesture(): void {
    const now = Date.now();
    if (now - this.gestureResetAt > GESTURE_WINDOW_MS) {
      this.gestureCount = 0;
      this.gestureResetAt = now;
    }
    this.gestureCount++;
    if (this.gestureCount >= GESTURE_TAPS) {
      this.gestureCount = 0;
      this.toggle();
    }
  }

  private setPersisted(on: boolean): void {
    try {
      if (on) localStorage.setItem(STORAGE_KEY, '1');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode / storage disabled — the in-memory signal still flips for this session.
    }
    this.enabled.set(this.isDevBuild() || on);
    this.applyLogging(this.enabled());
  }

  /** Keep the web console sink and Tauri's native log facade on the same runtime tier. */
  private applyLogging(enabled: boolean): void {
    setFullConsoleLogging(enabled);
    window.SomsShell?.setDebugLogging?.(enabled);
    if (isTauri()) {
      void tauriInvoke('set_debug_logging', { enabled }).catch(() => undefined);
    }
  }

  private readPersisted(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private isDevBuild(): boolean {
    return isDevMode();
  }
}
