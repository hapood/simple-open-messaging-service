import { Injectable, inject } from '@angular/core';
import { Observable, filter, take, timeout } from 'rxjs';
import type {
  ProfileDemand,
  UnevidencedProfileDemand,
} from '../../../../shared/profile-demand';
export {
  unevidencedProfileDemand,
  type UnevidencedProfileDemand,
} from '../../../../shared/profile-demand';
import {
  ProfileWatchService,
  type ResolvedProfile,
} from './profile-watch.service';
export type { ResolvedProfile } from './profile-watch.service';

/** How long a PENDING demand suppresses re-requests before a prefetch gives
 *  up (the shared entry keeps its own wake window). */
const PENDING_TTL_MS = 30_000;

/** Resolves immutable profiles through the platform watch engine. The engine
 *  (browser IndexedDB executor or native IPC, selected by platform) owns
 *  deduplication, the main-thread or native LRU, request cancellation and
 *  wake handling; this repository is the value-shaped surface existing
 *  consumers use: the first non-null frame of the watch stream, once. */
@Injectable({ providedIn: 'root' })
export class ProfileRepository {
  private readonly profileWatch = inject(ProfileWatchService);

  /** Wait for the resolved snapshot addressed by one demand. Errors when the
   *  resolution fails (including an unevidenced cache miss). */
  resolve(
    demand: ProfileDemand | UnevidencedProfileDemand,
  ): Observable<ResolvedProfile> {
    return this.profileWatch.watchProfile(demand).pipe(
      // The watch stream's first frame is the local cache or null; value
      // consumers skip straight to the resolved snapshot.
      filter((profile): profile is ResolvedProfile => profile !== null),
      take(1),
    );
  }

  /** Watch the same demand as a stream: the first frame is the locally cached
   *  snapshot or `null` (render a fallback), the next frame — if any — is the
   *  resolved snapshot, then the stream ends. Unsubscribing cancels the
   *  underlying demand. */
  watch(
    demand: ProfileDemand | UnevidencedProfileDemand,
  ): Observable<ResolvedProfile | null> {
    return this.profileWatch.watchProfile(demand);
  }

  /** Optional warming through the same shared demand machinery. PENDING work
   *  stays subscribed for a bounded wake window; errors never escape into the
   *  caller's fact-processing flow. */
  prefetch(
    demand: ProfileDemand | UnevidencedProfileDemand,
    onReady?: (profile: ResolvedProfile) => void,
  ): void {
    this.resolve(demand)
      .pipe(take(1), timeout(PENDING_TTL_MS))
      .subscribe({
        next: onReady,
        error: (error) => console.warn('[profile] prefetch failed', error),
      });
  }
}
