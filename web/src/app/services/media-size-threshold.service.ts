import { computed, Injectable, signal } from '@angular/core';

const KEY = 'soms.mediaSizeThreshold';
const DEFAULT_KB = 1024;

/** Threshold options offered in Settings (KB). 0 = unlimited (no tiering — every image loads at once). */
export const MEDIA_THRESHOLD_OPTIONS_KB = [512, 1024, 2048, 0] as const;

/**
 * User-adjustable image size threshold for size-tiered lazy loading in chat. IMAGE messages larger
 * than the threshold render as a "Tap to load · {size}" placeholder; the first click loads them (a
 * manual gate against auto-downloading big files on mobile data). At or below the threshold (and for
 * all VIDEO/AUDIO), media loads immediately as before. 0 disables the gate entirely.
 *
 * Mirrors {@link ThemeService}'s pattern: a signal restored from `localStorage` (the project's
 * `soms.*` prefix) with try/catch for private mode. The backend only provides `size` (added to the
 * IMAGE upload response + content in Phase 1); the threshold + the tap-to-load decision are pure
 * frontend, so changing it needs no API round-trip.
 */
@Injectable({ providedIn: 'root' })
export class MediaSizeThresholdService {
  private readonly _kb = signal<number>(this.readStored());

  /** The user's choice in KB (0 = unlimited). */
  readonly kb = this._kb.asReadonly();

  /** Threshold in bytes (0 = unlimited). Read this to decide placeholder vs immediate load. */
  readonly threshold = computed(() => {
    const kb = this._kb();
    return kb <= 0 ? 0 : kb * 1024;
  });

  setKb(kb: number): void {
    this._kb.set(kb);
    try {
      localStorage.setItem(KEY, String(kb));
    } catch {
      // localStorage disabled (private mode) — keep the in-memory signal only.
    }
  }

  private readStored(): number {
    try {
      const v = localStorage.getItem(KEY);
      if (v === null) return DEFAULT_KB;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_KB;
    } catch {
      return DEFAULT_KB;
    }
  }
}
