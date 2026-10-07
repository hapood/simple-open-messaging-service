import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, ReplaySubject } from 'rxjs';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService } from './webdb.service';
import type {
  ProfileNamespaceBinding,
  ProfileNamespacePairKey,
} from './webdb-storage';
import { isTauri } from './runtime';

/** Cache capacity; profile resolution uses 1000, namespace bindings are far
 *  fewer (one per identity pair actually rendered). */
const LRU_CAPACITY = 100;

/** How long a PENDING pair suppresses re-requests. The server planted a tomb
 *  and scheduled a refresh; a wake delivers the converged row. The timeout
 *  covers a lost wake. */
const PENDING_TTL_MS = 30_000;

function pairKey(pair: ProfileNamespacePairKey): string {
  return `${pair.publisherNamespaceId}:${pair.profileNamespaceId}`;
}

interface ResolutionEntry {
  pairKey: string;
  pair: ProfileNamespacePairKey;
  subject: ReplaySubject<ProfileNamespaceBinding>;
  observable: Observable<ProfileNamespaceBinding>;
  running: boolean;
  rerun: boolean;
  /** PENDING state: the server returned PENDING and scheduled a wake.
   *  undefined means not pending (requesting or already resolved). The
   *  deadline suppresses re-requests; a lost wake lets it expire and the
   *  next resolve() retries. */
  pending: { deadline: number } | undefined;
  subscribers: number;
}

/** Client-side profile-namespace binding cache.
 *
 *  Single API: `resolve(pair)` returns a shared Observable that emits the
 *  current binding and stays open — namespace bindings are mutable (expired
 *  flips, domain rebinds, status transitions), so a wake re-reads the IDB
 *  row and re-emits without completing the subject. There is no read-only
 *  cache path: callers always subscribe and always follow updates.
 *
 *  Race discipline — the DB is always written first, the cache second, and
 *  every cache write passes the dual-coordinate guard: an incoming row may
 *  replace the cached one only when its `changeSeq` (change-feed coordinate)
 *  and `updateFeedId` (publisher feed coordinate) are both greater than or
 *  equal to the cached values. Expiry events advance only `changeSeq`; resolve
 *  answers advance only `updateFeedId`; equal coordinates allow the write so
 *  the `expired` flag can flip in either direction at the same position. */
@Injectable({ providedIn: 'root' })
export class ProfileNamespaceRepository {
  private readonly webdb = inject(WebdbService);
  private readonly resolutions = new Map<string, ResolutionEntry>();
  private readonly lru = new Map<string, ProfileNamespaceBinding>();

  constructor() {
    this.webdb.profileNamespaceWake$
      .pipe(takeUntilDestroyed())
      .subscribe((pairs) => this.onWake(pairs));
    inject(SessionLifecycleService)
      .ended$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        for (const entry of this.resolutions.values()) entry.subject.complete();
        this.resolutions.clear();
        this.lru.clear();
      });
  }

  /** Resolve one pair through the platform database executor. The Observable
   *  emits the current binding and stays open for wake-driven updates.
   *  Namespace bindings are mutable (expired flips, status transitions,
   *  domain rebinds), so unlike profile resolution the stream never
   *  short-circuits to a one-shot cached snapshot — it always registers a
   *  ResolutionEntry so a wake can re-emit. */
  resolve(pair: ProfileNamespacePairKey): Observable<ProfileNamespaceBinding> {
    const key = pairKey(pair);
    const existing = this.resolutions.get(key);
    if (existing) {
      // A PENDING pair whose TTL expired retries on the next resolve().
      if (existing.pending && existing.pending.deadline <= Date.now()) {
        existing.pending = undefined;
        this.run(existing);
      }
      return existing.observable;
    }
    const subject = new ReplaySubject<ProfileNamespaceBinding>(1);
    const entry: ResolutionEntry = {
      pairKey: key,
      pair,
      subject,
      observable: undefined as unknown as Observable<ProfileNamespaceBinding>,
      running: false,
      rerun: false,
      pending: undefined,
      subscribers: 0,
    };
    entry.observable = new Observable((subscriber) => {
      entry.subscribers++;
      const subscription = subject.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        entry.subscribers--;
        if (
          entry.subscribers === 0 &&
          this.resolutions.get(entry.pairKey) === entry
        )
          this.resolutions.delete(entry.pairKey);
      };
    });
    this.resolutions.set(key, entry);
    this.run(entry);
    return entry.observable;
  }

  private run(entry: ResolutionEntry): void {
    if (isTauri()) return; // native: no executor wired yet — degrade
    if (entry.running) {
      entry.rerun = true;
      return;
    }
    entry.running = true;
    entry.rerun = false;
    void this.webdb
      .getProfileNamespaceBindings([entry.pair])
      .then(async (rows) => {
        const row = rows[0];
        if (row && !row.expired) {
          this.commitReady(entry, row);
          return;
        }
        // Missing or expired — resolve through the server. The round
        // coordinate is the row's changeSeq at read time (0 when absent):
        // a wake landing mid-flight advances the row past this value and
        // the commit guard drops the answer.
        const roundEnd = row?.changeSeq ?? 0;
        const result = await this.webdb.resolveProfileNamespacePairs(
          [entry.pair],
          roundEnd,
        );
        if (result.unrecoverable.length > 0) {
          // Tomb already written by webdb — the binding is permanently lost.
          entry.subject.error(new Error('namespace binding unrecoverable'));
          this.resolutions.delete(entry.pairKey);
          return;
        }
        if (result.pending.length > 0) {
          entry.pending = { deadline: Date.now() + PENDING_TTL_MS };
          return;
        }
        // READY — re-read the committed row.
        const committed = await this.webdb.getProfileNamespaceBindings([
          entry.pair,
        ]);
        if (committed[0]) {
          this.commitReady(entry, committed[0]);
        } else if (result.failed.length > 0) {
          entry.subject.error(new Error('namespace resolve failed'));
          this.resolutions.delete(entry.pairKey);
        }
      })
      .catch((error) => {
        entry.subject.error(error);
        this.resolutions.delete(entry.pairKey);
      })
      .finally(() => {
        entry.running = false;
        if (entry.rerun && this.resolutions.get(entry.pairKey) === entry)
          this.run(entry);
      });
  }

  /** Guarded cache write + emit. Does NOT complete the subject — bindings
   *  are mutable and a wake may re-emit with updated expired/status/domain. */
  private commitReady(
    entry: ResolutionEntry,
    binding: ProfileNamespaceBinding,
  ): void {
    const key = entry.pairKey;
    const cached = this.lru.get(key);
    if (
      cached &&
      (binding.changeSeq < cached.changeSeq ||
        binding.updateFeedId < cached.updateFeedId)
    )
      return; // stale — coordinates regressed
    this.lru.delete(key);
    this.lru.set(key, binding);
    while (this.lru.size > LRU_CAPACITY)
      this.lru.delete(this.lru.keys().next().value!);
    if (this.resolutions.get(entry.pairKey) !== entry) return;
    entry.subject.next(binding);
  }

  /** Wake handler: the change-feed drain already committed the DB rows —
   *  re-run each touched pair's resolution so it re-reads the updated row
   *  and re-emits to subscribers. */
  private onWake(pairs: readonly ProfileNamespacePairKey[]): void {
    if (pairs.length === 0) return;
    const touched = new Set(pairs.map(pairKey));
    for (const entry of this.resolutions.values()) {
      if (touched.has(entry.pairKey)) {
        entry.pending = undefined;
        this.run(entry);
      }
    }
  }
}
