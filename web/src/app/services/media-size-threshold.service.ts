import { computed, inject, Injectable, signal } from '@angular/core';
import { PreferenceStore } from './preference-store.service';

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
  private readonly preferences = inject(PreferenceStore);
  private writeRevision = 0;
  private readonly _kb = signal<number>(DEFAULT_KB);
  /** Session-scoped manual-load grants. Keeping these above the row component means opening and closing
   * the gallery (which remounts virtual rows) cannot turn an already loaded thumbnail back into a gate. */
  private readonly loadedMedia = signal<ReadonlySet<string>>(new Set());

  /** The user's choice in KB (0 = unlimited). */
  readonly kb = this._kb.asReadonly();

  /** Threshold in bytes (0 = unlimited). Read this to decide placeholder vs immediate load. */
  readonly threshold = computed(() => {
    const kb = this._kb();
    return kb <= 0 ? 0 : kb * 1024;
  });

  constructor() {
    void this.restore();
  }

  setKb(kb: number): void {
    this.writeRevision++;
    this._kb.set(kb);
    void this.preferences.set('device', KEY, kb).catch(() => {});
  }

  isLoaded(key: string): boolean {
    return this.loadedMedia().has(key);
  }

  markLoaded(key: string): void {
    if (this.loadedMedia().has(key)) return;
    this.loadedMedia.update((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  private async restore(): Promise<void> {
    const revision = this.writeRevision;
    const value = await this.preferences.get<number>('device', KEY);
    if (revision !== this.writeRevision) return;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) this._kb.set(value);
  }
}
