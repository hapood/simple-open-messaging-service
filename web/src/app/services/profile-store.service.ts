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

interface ResolutionEntry {
  demandKey: string;
  demand: ProfileDemand;
  subject: ReplaySubject<ResolvedProfile>;
  observable: Observable<ResolvedProfile>;
  running: boolean;
  rerun: boolean;
  state: { kind: 'REQUESTING' } | { kind: 'PENDING'; key: string };
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

  /** Read only an already committed profile for message text presentation. */
  getProfile(demand: ProfileDemand): Promise<ProfileSnapshot | undefined> {
    return this.webdb.getProfile(demand);
  }

  /** Resolve one demand through the platform database executor. The main thread performs no HTTP. */
  resolve(demand: ProfileDemand): Observable<ResolvedProfile> {
    demand = normalizeDemand(demand);
    const demandKey = JSON.stringify(demand);
    const existing = this.resolutions.get(demandKey);
    if (existing) return existing.observable;
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
      state: { kind: 'REQUESTING' },
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
          entry.state = { kind: 'PENDING', key: profileKey(result.key) };
          const wake =
            this.demandWakes.get(entry.demandKey) ??
            this.wakes.get(entry.state.key);
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
        entry.state.kind === 'PENDING' &&
        (entry.state.key === key || entry.demandKey === demandKey)
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
    if (entry.state.kind === 'PENDING' && entry.state.key !== key) return;
    entry.state = { kind: 'REQUESTING' };
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
