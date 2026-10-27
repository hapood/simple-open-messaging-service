import { Injectable, inject } from '@angular/core';
import { Observable, filter, take, timeout } from 'rxjs';
import { ProfileWatchService } from './profile-watch.service';
import type {
  ProfileNamespaceBinding,
  ProfileNamespacePairKey,
} from './webdb-storage';

/** How long a PENDING pair suppresses re-requests before a prefetch gives
 *  up (the shared entry keeps its own wake window). */
const PENDING_TTL_MS = 30_000;

/** Client-side profile-namespace binding stream. The platform watch engine
 *  (browser IndexedDB executor or native IPC) owns the entry machinery, the
 *  bounded LRU and the dual-coordinate cache guard; this repository is the
 *  value-shaped surface existing consumers use. `resolve` emits the current
 *  binding and stays open — namespace bindings are mutable (expired flips,
 *  domain rebinds, status transitions), so a wake re-emits updated values. */
@Injectable({ providedIn: 'root' })
export class ProfileNamespaceRepository {
  private readonly profileWatch = inject(ProfileWatchService);

  /** Observe one pair's binding. The first frame is skipped when nothing is
   *  cached yet (the watch stream's null frame); every following frame is a
   *  guarded binding update, for as long as the subscription is held. */
  resolve(pair: ProfileNamespacePairKey): Observable<ProfileNamespaceBinding> {
    return this.profileWatch
      .watchNamespace(pair)
      .pipe(
        filter(
          (binding): binding is ProfileNamespaceBinding => binding !== null,
        ),
      );
  }

  /** Watch the raw stream: the first frame is the cached binding or `null`
   *  (render without a federated domain), later frames are guarded updates. */
  watch(
    pair: ProfileNamespacePairKey,
  ): Observable<ProfileNamespaceBinding | null> {
    return this.profileWatch.watchNamespace(pair);
  }

  /** Best-effort warmup through the same shared entry machinery, bounded by
   *  the PENDING window. */
  prefetch(pair: ProfileNamespacePairKey): void {
    this.resolve(pair)
      .pipe(take(1), timeout({ first: PENDING_TTL_MS }))
      .subscribe({
        error: (error) =>
          console.warn('[profile-namespace] prefetch failed', pair, error),
      });
  }
}
