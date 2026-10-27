import { Injectable, InjectionToken, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import type {
  ProfileDemand,
  ProfileRequest,
} from '../../../../shared/profile-demand';
import { SessionLifecycleService } from './session-lifecycle.service';
import { isTauri } from './runtime';
import { NativeProfileWatchEngine } from './native-watch';
import {
  WebdbService,
  type ProfileNamespaceBinding,
  type ProfileNamespacePairKey,
  type ProfileResolutionAttempt,
  type ProfileSnapshot,
  type ProfileWake,
} from './webdb.service';

/** One resolved immutable profile snapshot with its avatar bytes attached. */
export interface ResolvedProfile {
  /** Home publisher of the resolved identity — the demand's
   *  `publisherNamespaceId`. */
  publisherNamespaceId: number;
  namespaceId: number;
  account: string;
  rev: number;
  name: string;
  bio: string;
  avatarDigest: string | null;
  avatarBlob: Blob | null;
}

/** Push sink shared by both engines. The first `next` arrives quickly — a
 *  locally cached value, or `null` when nothing is cached yet — so consumers
 *  can render a fallback immediately and update when a fresh value lands. */
export interface ProfileWatchSink {
  next(profile: ResolvedProfile | null): void;
  error(error: unknown): void;
  complete(): void;
}

export interface NamespaceWatchSink {
  next(binding: ProfileNamespaceBinding | null): void;
  error(error: unknown): void;
  complete(): void;
}

/** Platform watch engine. `subscribe*` registers one consumer; the returned
 *  cancel function releases it. Dropping the last consumer cancels the
 *  underlying demand, including its in-flight request. */
export abstract class ProfileWatchEngine {
  abstract subscribeProfile(
    request: ProfileRequest,
    sink: ProfileWatchSink,
  ): () => void;
  abstract subscribeNamespace(
    pair: ProfileNamespacePairKey,
    sink: NamespaceWatchSink,
  ): () => void;
}

/** How long a PENDING demand suppresses re-requests. The server scheduled a
 *  wake; the deadline covers a lost wake — the next subscribe after it expires
 *  retries. */
const PENDING_TTL_MS = 30_000;
/** Main-thread LRU capacities, mirroring the native watch cores. */
const PROFILE_LRU_CAPACITY = 1000;
const NAMESPACE_LRU_CAPACITY = 100;

function normalizeDemand(demand: ProfileDemand): ProfileDemand {
  return {
    ...demand,
    target: {
      ...demand.target,
      account: demand.target.account.trim().toLowerCase(),
    },
  };
}

function profileKey(key: {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  account: string;
  rev: number;
}): string {
  return JSON.stringify([
    key.publisherNamespaceId,
    key.profileNamespaceId,
    key.account.toLowerCase(),
    key.rev,
  ]);
}

function namespacePairKey(pair: ProfileNamespacePairKey): string {
  return `${pair.publisherNamespaceId}:${pair.profileNamespaceId}`;
}

interface ProfileEntry {
  demandKey: string;
  demand: ProfileDemand;
  /** Executor strategy fixed by whichever request form created the entry.
   *  Cache-only (unevidenced form) resolves from local + server caches, never
   *  schedules remote work, and errors on a miss. A request of the other form
   *  attaches to a live entry of the same demand — cross-form dedup never
   *  causes new remote work, and an errored cache-only entry is removed, so a
   *  later authorized attempt always starts fresh. */
  cacheOnly: boolean;
  sinks: Set<ProfileWatchSink>;
  running: boolean;
  rerun: boolean;
  /** PENDING state: the server returned a key and scheduled a wake.
   *  undefined means not pending (requesting or already resolved). */
  pending: { key: string; deadline: number } | undefined;
  cancellation: AbortController;
}

interface NamespaceEntry {
  pairKey: string;
  pair: ProfileNamespacePairKey;
  sinks: Set<NamespaceWatchSink>;
  running: boolean;
  rerun: boolean;
  /** PENDING state: the server planted a tomb and scheduled a refresh. */
  pending: { deadline: number } | undefined;
}

/** Browser engine: IndexedDB through the platform database executor, plus
 *  main-thread LRU caches and wake-driven updates. A peer implementation runs
 *  inside the native runtime; the two never mix. */
@Injectable()
export class BrowserProfileWatchEngine extends ProfileWatchEngine {
  private readonly webdb = inject(WebdbService);
  private readonly profileEntries = new Map<string, ProfileEntry>();
  private readonly profileLru = new Map<string, ResolvedProfile>();
  private readonly demandKeys = new Map<string, string>();
  private readonly wakes = new Map<string, ProfileWake>();
  private readonly demandWakes = new Map<string, ProfileWake>();
  private readonly namespaceEntries = new Map<string, NamespaceEntry>();
  private readonly namespaceLru = new Map<string, ProfileNamespaceBinding>();
  private readonly background = new Set<() => void>();

  constructor() {
    super();
    this.webdb.profileWake$
      .pipe(takeUntilDestroyed())
      .subscribe((wake) => this.onProfileWake(wake));
    this.webdb.profileNamespaceWake$
      .pipe(takeUntilDestroyed())
      .subscribe((pairs) => this.onNamespaceWake(pairs));
    inject(SessionLifecycleService)
      .ended$.pipe(takeUntilDestroyed())
      .subscribe(() => this.clear());
  }

  subscribeProfile(
    request: ProfileRequest,
    sink: ProfileWatchSink,
  ): () => void {
    const demand = normalizeDemand(
      'demand' in request ? request.demand : request,
    );
    const cacheOnly = 'demand' in request;
    const demandKey = JSON.stringify(demand);
    // Main-thread LRU fast path: one synchronous frame, no executor round.
    const cachedKey = this.demandKeys.get(demandKey);
    if (cachedKey) {
      const cached = this.profileLru.get(cachedKey);
      if (cached) {
        this.profileLru.delete(cachedKey);
        this.profileLru.set(cachedKey, cached);
        sink.next(cached);
        sink.complete();
        return () => undefined;
      }
      this.demandKeys.delete(demandKey);
    }
    const existing = this.profileEntries.get(demandKey);
    const entry = existing ?? {
      demandKey,
      demand,
      cacheOnly,
      sinks: new Set<ProfileWatchSink>(),
      running: false,
      rerun: false,
      pending: undefined,
      cancellation: new AbortController(),
    };
    this.profileEntries.set(demandKey, entry);
    // A PENDING demand whose TTL expired retries on the next subscribe.
    if (entry.pending && entry.pending.deadline <= Date.now())
      entry.pending = undefined;
    entry.sinks.add(sink);
    // Empty first frame: nothing is cached locally yet, so consumers can
    // render a fallback before any durable or network round completes.
    sink.next(null);
    if (!entry.running && !entry.pending) this.runProfile(entry);
    return () => {
      entry.sinks.delete(sink);
      if (
        entry.sinks.size === 0 &&
        this.profileEntries.get(entry.demandKey) === entry
      ) {
        this.profileEntries.delete(entry.demandKey);
        entry.cancellation.abort();
      }
    };
  }

  subscribeNamespace(
    pair: ProfileNamespacePairKey,
    sink: NamespaceWatchSink,
  ): () => void {
    const pairKey = namespacePairKey(pair);
    const existing = this.namespaceEntries.get(pairKey);
    const entry = existing ?? {
      pairKey,
      pair,
      sinks: new Set<NamespaceWatchSink>(),
      running: false,
      rerun: false,
      pending: undefined,
    };
    this.namespaceEntries.set(pairKey, entry);
    if (entry.pending && entry.pending.deadline <= Date.now())
      entry.pending = undefined;
    entry.sinks.add(sink);
    // First frame from the main-thread LRU, or empty — the durable read and
    // possible resolve round follow immediately behind it.
    const cached = this.namespaceLru.get(pairKey);
    sink.next(cached && !cached.expired ? cached : null);
    if (!entry.running && !entry.pending) this.runNamespace(entry);
    return () => {
      entry.sinks.delete(sink);
      if (
        entry.sinks.size === 0 &&
        this.namespaceEntries.get(entry.pairKey) === entry
      )
        this.namespaceEntries.delete(entry.pairKey);
    };
  }

  /** Best-effort warmup through the same shared entry machinery, bounded by
   *  the PENDING window. Used for undemanded wake convergence. */
  warmNamespace(pair: ProfileNamespacePairKey): void {
    let finished = false;
    let cancel!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.background.delete(finish);
      cancel();
    };
    cancel = this.subscribeNamespace(pair, {
      next: (binding) => {
        // Like the legacy prefetch: the first real binding releases the
        // warm subscription; `null` frames keep it waiting.
        if (binding !== null) finish();
      },
      error: (error) => {
        console.warn('[profile-namespace] warmup failed', pair, error);
        finish();
      },
      complete: finish,
    });
    timer = setTimeout(finish, PENDING_TTL_MS);
    this.background.add(finish);
  }

  private runProfile(entry: ProfileEntry): void {
    if (entry.running) {
      entry.rerun = true;
      return;
    }
    entry.running = true;
    entry.rerun = false;
    // Cache-only attempts carry an explicit null evidence so the server serves
    // durable-cache snapshots without authorizing remote resolution; they can
    // never return PENDING, so the wake machinery stays evidenced-only.
    const attempt = entry.cacheOnly
      ? this.webdb
          .resolveProfileDemand(entry.demand, {
            evidence: null,
            signal: entry.cancellation.signal,
          })
          .then((result) => {
            if (result.status !== 'READY')
              throw new Error(
                'unevidenced profile lookup must not return PENDING',
              );
            return result;
          })
      : this.webdb.resolveProfileDemand(entry.demand, {
          signal: entry.cancellation.signal,
        });
    void attempt
      .then(async (result: ProfileResolutionAttempt) => {
        if (
          this.profileEntries.get(entry.demandKey) !== entry ||
          entry.cancellation.signal.aborted
        )
          return;
        if (result.status === 'PENDING') {
          entry.pending = {
            key: profileKey(result.key),
            deadline: Date.now() + PENDING_TTL_MS,
          };
          const wake =
            this.demandWakes.get(entry.demandKey) ??
            this.wakes.get(entry.pending.key);
          if (wake) this.consumeProfileWake(entry, wake);
          return;
        }
        await this.commitProfileReady(entry, result.profile);
      })
      .catch((error: unknown) => {
        if (
          this.profileEntries.get(entry.demandKey) !== entry ||
          entry.cancellation.signal.aborted
        )
          return;
        // Remove before notifying consumers, which can synchronously retry.
        this.profileEntries.delete(entry.demandKey);
        const sinks = [...entry.sinks];
        entry.sinks.clear();
        for (const sink of sinks) sink.error(error);
      })
      .finally(() => {
        entry.running = false;
        if (entry.rerun && this.profileEntries.get(entry.demandKey) === entry)
          this.runProfile(entry);
      });
  }

  private async readResolvedProfile(
    snapshot: ProfileSnapshot,
  ): Promise<ResolvedProfile> {
    const avatarBlob = snapshot.avatarDigest
      ? await this.webdb.getProfileAvatarBlob(snapshot.avatarDigest)
      : null;
    if (snapshot.avatarDigest && !avatarBlob)
      throw new Error('resolved profile avatar bytes are missing');
    return {
      publisherNamespaceId: snapshot.publisherNamespaceId,
      namespaceId: snapshot.profileNamespaceId,
      account: snapshot.account,
      rev: snapshot.profileRev,
      name: snapshot.name,
      bio: snapshot.bio,
      avatarDigest: snapshot.avatarDigest,
      avatarBlob: avatarBlob ?? null,
    };
  }

  private async commitProfileReady(
    entry: ProfileEntry,
    snapshot: ProfileSnapshot,
  ): Promise<void> {
    const profile = await this.readResolvedProfile(snapshot);
    // An avatar read can outlive its subscription or account session. Check
    // ownership before populating either shared cache, not only before delivery.
    if (this.profileEntries.get(entry.demandKey) !== entry) return;
    const key = profileKey({
      publisherNamespaceId: snapshot.publisherNamespaceId,
      profileNamespaceId: profile.namespaceId,
      account: profile.account,
      rev: profile.rev,
    });
    this.profileLru.delete(key);
    this.profileLru.set(key, profile);
    this.demandKeys.delete(entry.demandKey);
    this.demandKeys.set(entry.demandKey, key);
    while (this.profileLru.size > PROFILE_LRU_CAPACITY) {
      const evicted = this.profileLru.keys().next().value!;
      this.profileLru.delete(evicted);
      for (const [candidate, candidateKey] of this.demandKeys)
        if (candidateKey === evicted) this.demandKeys.delete(candidate);
    }
    while (this.demandKeys.size > PROFILE_LRU_CAPACITY)
      this.demandKeys.delete(this.demandKeys.keys().next().value!);
    if (this.profileEntries.get(entry.demandKey) !== entry) return;
    // An immutable snapshot ends its stream: deliver and complete.
    this.profileEntries.delete(entry.demandKey);
    const sinks = [...entry.sinks];
    entry.sinks.clear();
    for (const sink of sinks) {
      sink.next(profile);
      sink.complete();
    }
  }

  private onProfileWake(wake: ProfileWake): void {
    const key = profileKey(wake.key);
    this.wakes.delete(key);
    this.wakes.set(key, wake);
    while (this.wakes.size > PROFILE_LRU_CAPACITY)
      this.wakes.delete(this.wakes.keys().next().value!);
    const demandKey =
      wake.event === 'PROFILE_AVAILABLE' && wake.demand
        ? JSON.stringify(normalizeDemand(wake.demand))
        : undefined;
    if (demandKey) {
      this.demandWakes.set(demandKey, wake);
      while (this.demandWakes.size > PROFILE_LRU_CAPACITY)
        this.demandWakes.delete(this.demandWakes.keys().next().value!);
    }
    for (const entry of this.profileEntries.values())
      if (
        entry.pending &&
        (entry.pending.key === key || entry.demandKey === demandKey)
      )
        this.consumeProfileWake(entry, wake);
  }

  private consumeProfileWake(entry: ProfileEntry, wake: ProfileWake): void {
    const key = profileKey(wake.key);
    this.wakes.delete(key);
    this.demandWakes.delete(entry.demandKey);
    if (wake.event === 'PROFILE_UNAVAILABLE') {
      this.profileEntries.delete(entry.demandKey);
      entry.cancellation.abort();
      const sinks = [...entry.sinks];
      entry.sinks.clear();
      for (const sink of sinks) sink.error(new Error(wake.reason));
      return;
    }
    if (entry.pending && entry.pending.key !== key) return;
    entry.pending = undefined;
    this.runProfile(entry);
  }

  private runNamespace(entry: NamespaceEntry): void {
    if (entry.running) {
      entry.rerun = true;
      return;
    }
    entry.running = true;
    entry.rerun = false;
    void this.webdb
      .getProfileNamespaceBindings([entry.pair])
      .then(async (rows) => {
        if (this.namespaceEntries.get(entry.pairKey) !== entry) return;
        const row = rows[0];
        if (row && !row.expired) {
          this.commitNamespaceReady(entry, row);
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
        if (this.namespaceEntries.get(entry.pairKey) !== entry) return;
        if (result.unrecoverable.length > 0) {
          this.failNamespace(entry, 'namespace binding unrecoverable');
          return;
        }
        if (result.pending.length > 0) {
          entry.pending = { deadline: Date.now() + PENDING_TTL_MS };
          return;
        }
        if (result.failed.length > 0) {
          this.failNamespace(entry, 'namespace resolve failed');
          return;
        }
        // READY — re-read the committed row.
        const committed = await this.webdb.getProfileNamespaceBindings([
          entry.pair,
        ]);
        if (this.namespaceEntries.get(entry.pairKey) !== entry) return;
        if (committed[0]) this.commitNamespaceReady(entry, committed[0]);
      })
      .catch((error: unknown) => {
        if (this.namespaceEntries.get(entry.pairKey) !== entry) return;
        this.failNamespace(entry, error);
      })
      .finally(() => {
        entry.running = false;
        if (entry.rerun && this.namespaceEntries.get(entry.pairKey) === entry)
          this.runNamespace(entry);
      });
  }

  private failNamespace(entry: NamespaceEntry, error: unknown): void {
    this.namespaceEntries.delete(entry.pairKey);
    const sinks = [...entry.sinks];
    entry.sinks.clear();
    for (const sink of sinks) sink.error(error);
  }

  /** Guarded cache write + emit. Does NOT complete the sinks — bindings are
   *  mutable and a wake may re-emit with updated expired/status/domain. */
  private commitNamespaceReady(
    entry: NamespaceEntry,
    binding: ProfileNamespaceBinding,
  ): void {
    if (this.namespaceEntries.get(entry.pairKey) !== entry) return;
    const cached = this.namespaceLru.get(entry.pairKey);
    if (
      cached &&
      (binding.changeSeq < cached.changeSeq ||
        binding.updateFeedId < cached.updateFeedId)
    )
      return; // stale — coordinates regressed
    this.namespaceLru.delete(entry.pairKey);
    this.namespaceLru.set(entry.pairKey, binding);
    while (this.namespaceLru.size > NAMESPACE_LRU_CAPACITY)
      this.namespaceLru.delete(this.namespaceLru.keys().next().value!);
    for (const sink of entry.sinks) sink.next(binding);
  }

  /** Wake handler: the change-feed drain already committed the DB rows —
   *  re-run demanded pairs and warm undemanded pairs. */
  private onNamespaceWake(pairs: readonly ProfileNamespacePairKey[]): void {
    if (pairs.length === 0) return;
    for (const pair of pairs) {
      const entry = this.namespaceEntries.get(namespacePairKey(pair));
      if (entry && entry.sinks.size > 0) {
        entry.pending = undefined;
        this.runNamespace(entry);
      } else {
        this.warmNamespace(pair);
      }
    }
  }

  private clear(): void {
    for (const cancel of this.background) cancel();
    this.background.clear();
    const profileEntries = [...this.profileEntries.values()];
    this.profileEntries.clear();
    this.profileLru.clear();
    this.demandKeys.clear();
    this.wakes.clear();
    this.demandWakes.clear();
    const namespaceEntries = [...this.namespaceEntries.values()];
    this.namespaceEntries.clear();
    this.namespaceLru.clear();
    for (const entry of profileEntries) {
      entry.cancellation.abort();
      const sinks = [...entry.sinks];
      entry.sinks.clear();
      for (const sink of sinks) sink.complete();
    }
    for (const entry of namespaceEntries) {
      const sinks = [...entry.sinks];
      entry.sinks.clear();
      for (const sink of sinks) sink.complete();
    }
  }
}

export const PROFILE_WATCH_ENGINE = new InjectionToken<ProfileWatchEngine>(
  'ProfileWatchEngine',
  {
    providedIn: 'root',
    factory: () =>
      isTauri()
        ? new NativeProfileWatchEngine(inject(WebdbService))
        : new BrowserProfileWatchEngine(),
  },
);

/** Unified subscription surface for profiles and namespace bindings.
 *  `watchProfile` emits `null` (or a cached snapshot) immediately, then the
 *  resolved snapshot when it lands, and ends; `watchNamespace` keeps emitting
 *  guarded updates for as long as it is subscribed. Unsubscribing cancels the
 *  underlying demand. */
@Injectable({ providedIn: 'root' })
export class ProfileWatchService {
  private readonly engine = inject(PROFILE_WATCH_ENGINE);

  watchProfile(request: ProfileRequest): Observable<ResolvedProfile | null> {
    return new Observable((subscriber) =>
      this.engine.subscribeProfile(request, {
        next: (profile) => subscriber.next(profile),
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      }),
    );
  }

  watchNamespace(
    pair: ProfileNamespacePairKey,
  ): Observable<ProfileNamespaceBinding | null> {
    return new Observable((subscriber) =>
      this.engine.subscribeNamespace(pair, {
        next: (binding) => subscriber.next(binding),
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      }),
    );
  }
}
