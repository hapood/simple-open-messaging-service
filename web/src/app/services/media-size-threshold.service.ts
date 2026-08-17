import { inject, Injectable, signal } from '@angular/core';
import { PreferenceStore } from './preference-store.service';

const KEY = 'soms.mediaSizeThreshold';
export type MediaLoadPolicy =
  | { readonly mode: 'unlimited' }
  | { readonly mode: 'limited'; readonly bytes: number };

export const MEDIA_LOAD_POLICY_OPTIONS: readonly MediaLoadPolicy[] = [
  { mode: 'limited', bytes: 512 * 1024 },
  { mode: 'limited', bytes: 1024 * 1024 },
  { mode: 'limited', bytes: 2048 * 1024 },
  { mode: 'unlimited' },
];

const DEFAULT_POLICY: MediaLoadPolicy = MEDIA_LOAD_POLICY_OPTIONS[1];

/**
 * User-adjustable image size threshold for size-tiered lazy loading in chat. IMAGE messages larger
 * than the threshold render as a "Tap to load · {size}" placeholder; the first click loads them (a
 * manual gate against auto-downloading big files on mobile data). At or below the threshold (and for
 * all VIDEO/AUDIO), media loads immediately as before. The unlimited mode disables the gate entirely.
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
  private readonly _policy = signal<MediaLoadPolicy>(DEFAULT_POLICY);
  /** Session-scoped manual-load grants. Keeping these above the row component means opening and closing
   * the gallery (which remounts virtual rows) cannot turn an already loaded thumbnail back into a gate. */
  private readonly loadedMedia = signal<ReadonlySet<string>>(new Set());

  readonly policy = this._policy.asReadonly();

  constructor() {
    void this.restore();
  }

  setPolicy(policy: MediaLoadPolicy): void {
    this.writeRevision++;
    this._policy.set(policy);
    void this.preferences.set('device', KEY, policy).catch(() => {});
  }

  shouldDefer(size: number): boolean {
    const policy = this._policy();
    return policy.mode === 'limited' && size > policy.bytes;
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
    const value = await this.preferences.get<MediaLoadPolicy>('device', KEY);
    if (revision !== this.writeRevision) return;
    if (isMediaLoadPolicy(value)) this._policy.set(value);
  }
}

function isMediaLoadPolicy(value: unknown): value is MediaLoadPolicy {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MediaLoadPolicy>;
  return (
    candidate.mode === 'unlimited' ||
    (candidate.mode === 'limited' &&
      typeof candidate.bytes === 'number' &&
      Number.isFinite(candidate.bytes) &&
      candidate.bytes > 0)
  );
}
