import { inject, Injectable, isDevMode, signal } from '@angular/core';
import { setFullConsoleLogging } from './log-buffer';
import { isTauri, tauriInvoke } from './runtime';
import { PreferenceStore } from './preference-store.service';

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
  private readonly preferences = inject(PreferenceStore);
  private persisted = false;
  private writeRevision = 0;
  readonly enabled = signal<boolean>(this.isDevBuild());

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
    void this.restore();
  }

  /** Flip the persisted flag. Dev builds stay enabled regardless (the flag only governs production). */
  toggle(): void {
    this.setPersisted(!this.persisted);
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
    this.writeRevision++;
    this.persisted = on;
    const write = on
      ? this.preferences.set('device', STORAGE_KEY, true)
      : this.preferences.remove('device', STORAGE_KEY);
    void write.catch(() => {});
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

  private async restore(): Promise<void> {
    const revision = this.writeRevision;
    const stored = await this.preferences.get<boolean>('device', STORAGE_KEY);
    if (revision !== this.writeRevision || stored !== true) return;
    this.persisted = true;
    this.enabled.set(true);
    this.applyLogging(true);
  }

  private isDevBuild(): boolean {
    return isDevMode();
  }
}
