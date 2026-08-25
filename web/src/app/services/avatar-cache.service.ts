import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { WebdbService } from './webdb.service';
import { assetUrl } from './runtime';

/**
 * The DB-layer repository for avatar blobs — the read half of the strict 3-tier (UI ↔ repos ↔ backend)
 * for the avatar domain. The UI ({@link UserAvatarComponent}) reads avatar bytes ONLY through here.
 *
 * The blob store is keyed by **stable identity** (`u<userId>` / `g<groupId>`) — NEVER by URL. `path` is
 * only the fetch location used on a cache miss (and stored opaquely for the GC), not a cache key. So no
 * "content addressing / URL versioning": the backend's `<base>` changing is incidental. Freshness is
 * driven by the profile layer (Phase 2), which calls {@link refresh} when it detects an avatar-path
 * change for an identity.
 *
 * The DB is the single read path: on a hit the bytes come from IDB; on a miss the fetch is cached
 * first, then served. All IDB errors (prerender / no user) degrade to a graceful miss (undefined),
 * never throwing to the caller.
 */
@Injectable({ providedIn: 'root' })
export class AvatarRepository {
  private readonly http = inject(HttpClient);
  private readonly webdb = inject(WebdbService);

  /** Per-identity counter bumped each time the blob is refreshed, so a mounted
   *  {@link UserAvatarComponent} re-resolves (reads the new IDB bytes) without comparing URLs. */
  private readonly _refreshTick = signal<ReadonlyMap<string, number>>(new Map());

  /** The refresh counter for `identity` — read inside a component effect to track refreshes
   *  (signal-driven freshness; the component never compares URLs). */
  refreshTick(identity: string): number {
    return this._refreshTick().get(identity) ?? 0;
  }

  /**
   * Resolve an avatar blob by identity. Cache hit → return the stored bytes. Miss → fetch `path`,
   * cache the result under the identity, return it. Returns undefined when there is no blob / IDB is
   * unavailable. `identity` is the key; `path` is only the miss-fetch location.
   */
  async getBlob(identity: string, path: string): Promise<Blob | undefined> {
    try {
      const rec = await this.webdb.getAvatar(identity);
      if (rec) return rec.blob;
    } catch {
      return undefined; // IDB unavailable (prerender / no user) → graceful miss
    }
    const blob = await this.fetchBlob(path);
    if (blob) {
      void this.webdb.putAvatar({ identity, blob, path, lastRender: Date.now() }).catch(() => {});
    }
    return blob;
  }

  /**
   * Re-fetch the avatar for `identity` from `path` and overwrite the cached blob. Called by the profile
   * layer (Phase 2) when it detects the identity's avatar path changed — the signal-driven freshness
   * path (NOT URL versioning).
   */
  async refresh(identity: string, path: string): Promise<void> {
    const blob = await this.fetchBlob(path);
    if (!blob) return;
    try {
      await this.webdb.putAvatar({ identity, blob, path, lastRender: Date.now() });
      // Bump AFTER the IDB write lands so a re-resolve reads the new bytes.
      this._refreshTick.update((m) => {
        const n = new Map(m);
        n.set(identity, (n.get(identity) ?? 0) + 1);
        return n;
      });
    } catch {
      /* IDB unavailable — nothing to cache; the next miss will re-fetch */
    }
  }

  /** Fetch avatar bytes from a server path (cookie-auth browser / Bearer Tauri via assetUrl). */
  private async fetchBlob(path: string): Promise<Blob | undefined> {
    try {
      return await firstValueFrom(this.http.get(assetUrl(path), { responseType: 'blob' }));
    } catch {
      return undefined;
    }
  }
}
