import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, ReplaySubject } from 'rxjs';
import type { ProfileDemand } from '../../../../shared/profile-demand';
import {
  WebdbService,
  type ProfileWake,
  type ProfileSnapshot,
} from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';

export interface ResolvedProfile {
  namespaceId: number;
  account: string;
  rev: number;
  name: string;
  bio: string;
  avatarDigest: string | null;
  avatarBlob: Blob | null;
}

/** How long a PENDING demand suppresses re-requests. The server scheduled a
 *  wake; the deadline covers a lost wake — the next resolve() after it
 *  expires retries. */
const PENDING_TTL_MS = 30_000;

interface ResolutionEntry {
  demandKey: string;
  demand: ProfileDemand;
  subject: ReplaySubject<ResolvedProfile>;
  observable: Observable<ResolvedProfile>;
  running: boolean;
  rerun: boolean;
  /** PENDING state: the server returned a key and scheduled a wake.
   *  undefined means not pending (requesting or already resolved). The
   *  deadline suppresses re-requests; a lost wake lets it expire and the
   *  next resolve() retries. */
  pending: { key: string; deadline: number } | undefined;
  subscribers: number;
}

/** Resolves immutable profiles through the platform runtime and shares pending subscriptions. */
@Injectable({ providedIn: 'root' })
export class ProfileRepository {
  private readonly webdb = inject(WebdbService);
  private readonly resolutions = new Map<string, ResolutionEntry>();
  private readonly lru = new Map<string, ResolvedProfile>();
  private readonly demandKeys = new Map<string, string>();
  private readonly wakes = new Map<string, ProfileWake>();
  private readonly demandWakes = new Map<string, ProfileWake>();

  constructor() {
    this.webdb.profileWake$
      .pipe(takeUntilDestroyed())
      .subscribe((wake) => this.onWake(wake));
    inject(SessionLifecycleService)
      .ended$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        for (const entry of this.resolutions.values()) entry.subject.complete();
        this.resolutions.clear();
        this.lru.clear();
        this.demandKeys.clear();
        this.wakes.clear();
        this.demandWakes.clear();
      });
  }

  /** Resolve one demand through the platform database executor. The main thread performs no HTTP. */
  resolve(demand: ProfileDemand): Observable<ResolvedProfile> {
    demand = normalizeDemand(demand);
    const demandKey = JSON.stringify(demand);
    const existing = this.resolutions.get(demandKey);
    if (existing) {
      // A PENDING demand whose TTL expired retries on the next resolve().
      if (existing.pending && existing.pending.deadline <= Date.now()) {
        existing.pending = undefined;
        this.run(existing);
      }
      return existing.observable;
    }
    const cachedKey = this.demandKeys.get(demandKey);
    if (cachedKey) {
      const cached = this.lru.get(cachedKey);
      if (cached)
        return new Observable((subscriber) => {
          this.lru.delete(cachedKey);
          this.lru.set(cachedKey, cached);
          subscriber.next(cached);
          subscriber.complete();
        });
      this.demandKeys.delete(demandKey);
    }
    const subject = new ReplaySubject<ResolvedProfile>(1);
    const entry: ResolutionEntry = {
      demandKey,
      demand,
      subject,
      observable: undefined as unknown as Observable<ResolvedProfile>,
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
          this.resolutions.get(entry.demandKey) === entry
        )
          this.resolutions.delete(entry.demandKey);
      };
    });
    this.resolutions.set(demandKey, entry);
    this.run(entry);
    return entry.observable;
  }

  private run(entry: ResolutionEntry): void {
    if (entry.running) {
      entry.rerun = true;
      return;
    }
    entry.running = true;
    entry.rerun = false;
    void this.webdb
      .resolveProfileDemand(entry.demand)
      .then(async (result) => {
        if (result.status === 'PENDING') {
          entry.pending = {
            key: profileKey(result.key),
            deadline: Date.now() + PENDING_TTL_MS,
          };
          const wake =
            this.demandWakes.get(entry.demandKey) ??
            this.wakes.get(entry.pending.key);
          if (wake) this.consumeWake(entry, wake);
          return;
        }
        await this.commitReady(entry, result.profile);
      })
      .catch((error) => {
        entry.subject.error(error);
        this.resolutions.delete(entry.demandKey);
      })
      .finally(() => {
        entry.running = false;
        if (entry.rerun && this.resolutions.get(entry.demandKey) === entry)
          this.run(entry);
      });
  }

  private async commitReady(
    entry: ResolutionEntry,
    snapshot: ProfileSnapshot,
  ): Promise<void> {
    const avatarBlob = snapshot.avatarDigest
      ? await this.webdb.getProfileAvatarBlob(snapshot.avatarDigest)
      : null;
    if (snapshot.avatarDigest && !avatarBlob)
      throw new Error('resolved profile avatar bytes are missing');
    const profile: ResolvedProfile = {
      namespaceId: snapshot.profileNamespaceId,
      account: snapshot.account,
      rev: snapshot.profileRev,
      name: snapshot.name,
      bio: snapshot.bio,
      avatarDigest: snapshot.avatarDigest,
      avatarBlob: avatarBlob ?? null,
    };
    const key = JSON.stringify([
      profile.namespaceId,
      profile.account,
      profile.rev,
    ]);
    this.lru.delete(key);
    this.lru.set(key, profile);
    this.demandKeys.delete(entry.demandKey);
    this.demandKeys.set(entry.demandKey, key);
    while (this.lru.size > 1000) {
      const evicted = this.lru.keys().next().value!;
      this.lru.delete(evicted);
      for (const [candidate, profileKey] of this.demandKeys)
        if (profileKey === evicted) this.demandKeys.delete(candidate);
    }
    while (this.demandKeys.size > 1000)
      this.demandKeys.delete(this.demandKeys.keys().next().value!);
    if (this.resolutions.get(entry.demandKey) !== entry) return;
    entry.subject.next(profile);
    entry.subject.complete();
    this.resolutions.delete(entry.demandKey);
  }

  private onWake(wake: ProfileWake): void {
    const key = profileKey(wake.key);
    this.wakes.delete(key);
    this.wakes.set(key, wake);
    while (this.wakes.size > 1000)
      this.wakes.delete(this.wakes.keys().next().value!);
    const demandKey =
      wake.event === 'PROFILE_AVAILABLE' && wake.demand
        ? JSON.stringify(normalizeDemand(wake.demand))
        : undefined;
    if (demandKey) {
      this.demandWakes.set(demandKey, wake);
      while (this.demandWakes.size > 1000)
        this.demandWakes.delete(this.demandWakes.keys().next().value!);
    }
    for (const entry of this.resolutions.values())
      if (
        entry.pending &&
        (entry.pending.key === key || entry.demandKey === demandKey)
      )
        this.consumeWake(entry, wake);
  }

  private consumeWake(entry: ResolutionEntry, wake: ProfileWake): void {
    const key = profileKey(wake.key);
    this.wakes.delete(key);
    this.demandWakes.delete(entry.demandKey);
    if (wake.event === 'PROFILE_UNAVAILABLE') {
      entry.subject.error(new Error(wake.reason));
      this.resolutions.delete(entry.demandKey);
      return;
    }
    if (entry.pending && entry.pending.key !== key) return;
    entry.pending = undefined;
    this.run(entry);
  }
}

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
