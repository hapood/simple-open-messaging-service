import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, ReplaySubject } from 'rxjs';
import type { ProfileSelector as ProfileEvidence } from '../../../../shared/profile-selector';
import {
  WebdbService,
  type ProfileWake,
  type ProfileSelector,
  type ProfileSnapshot,
} from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';

export interface ResolvedProfile {
  namespaceId: number;
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarDigest: string | null;
  avatarBlob: Blob | null;
}

interface ResolutionEntry {
  evidenceKey: string;
  selector: ProfileEvidence;
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
  private readonly evidenceKeys = new Map<string, string>();
  private readonly wakes = new Map<string, ProfileWake>();
  private readonly evidenceWakes = new Map<string, ProfileWake>();

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
        this.evidenceKeys.clear();
        this.wakes.clear();
        this.evidenceWakes.clear();
      });
  }

  /** Read only an already committed profile for message text presentation. */
  getProfile(selector: ProfileSelector): Promise<ProfileSnapshot | undefined> {
    return this.webdb.getProfile(selector);
  }

  /** Resolve one evidence through the platform database executor. The main thread performs no HTTP. */
  resolve(selector: ProfileEvidence): Observable<ResolvedProfile> {
    selector = normalizeEvidence(selector);
    const evidenceKey = JSON.stringify(selector);
    const existing = this.resolutions.get(evidenceKey);
    if (existing) return existing.observable;
    const cachedKey = this.evidenceKeys.get(evidenceKey);
    if (cachedKey) {
      const cached = this.lru.get(cachedKey);
      if (cached)
        return new Observable((subscriber) => {
          this.lru.delete(cachedKey);
          this.lru.set(cachedKey, cached);
          subscriber.next(cached);
          subscriber.complete();
        });
      this.evidenceKeys.delete(evidenceKey);
    }
    const subject = new ReplaySubject<ResolvedProfile>(1);
    const entry: ResolutionEntry = {
      evidenceKey,
      selector,
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
          this.resolutions.get(entry.evidenceKey) === entry
        )
          this.resolutions.delete(entry.evidenceKey);
      };
    });
    this.resolutions.set(evidenceKey, entry);
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
      .resolveProfileEvidence(entry.selector)
      .then(async (result) => {
        if (result.status === 'PENDING') {
          entry.state = { kind: 'PENDING', key: profileKey(result.key) };
          const wake =
            this.evidenceWakes.get(entry.evidenceKey) ??
            this.wakes.get(entry.state.key);
          if (wake) this.consumeWake(entry, wake);
          return;
        }
        await this.commitReady(entry, result.profile);
      })
      .catch((error) => {
        entry.subject.error(error);
        this.resolutions.delete(entry.evidenceKey);
      })
      .finally(() => {
        entry.running = false;
        if (entry.rerun && this.resolutions.get(entry.evidenceKey) === entry)
          this.run(entry);
      });
  }

  private async commitReady(entry: ResolutionEntry, snapshot: ProfileSnapshot): Promise<void> {
        const avatarBlob = snapshot.avatarDigest
          ? await this.webdb.getProfileAvatarBlob(snapshot.avatarDigest)
          : null;
        if (snapshot.avatarDigest && !avatarBlob)
          throw new Error('resolved profile avatar bytes are missing');
        const profile: ResolvedProfile = {
          namespaceId: snapshot.namespaceId,
          account: snapshot.account,
          domain: snapshot.domain,
          rev: snapshot.profileRev,
          name: snapshot.name,
          bio: snapshot.bio,
          avatarDigest: snapshot.avatarDigest,
          avatarBlob: avatarBlob ?? null,
        };
        const key = JSON.stringify([
          profile.namespaceId,
          profile.account,
          profile.domain,
          profile.rev,
        ]);
        this.lru.delete(key);
        this.lru.set(key, profile);
        this.evidenceKeys.delete(entry.evidenceKey);
        this.evidenceKeys.set(entry.evidenceKey, key);
        while (this.lru.size > 1000) {
          const evicted = this.lru.keys().next().value!;
          this.lru.delete(evicted);
          for (const [candidate, profileKey] of this.evidenceKeys)
            if (profileKey === evicted) this.evidenceKeys.delete(candidate);
        }
        while (this.evidenceKeys.size > 1000)
          this.evidenceKeys.delete(this.evidenceKeys.keys().next().value!);
        if (this.resolutions.get(entry.evidenceKey) !== entry) return;
        entry.subject.next(profile);
        entry.subject.complete();
        this.resolutions.delete(entry.evidenceKey);
  }

  private onWake(wake: ProfileWake): void {
    const key = profileKey(wake.key);
    this.wakes.delete(key);
    this.wakes.set(key, wake);
    while (this.wakes.size > 1000)
      this.wakes.delete(this.wakes.keys().next().value!);
    const evidenceKey = wake.event === 'PROFILE_AVAILABLE' && wake.evidence
      ? JSON.stringify(normalizeEvidence(wake.evidence)) : undefined;
    if (evidenceKey) {
      this.evidenceWakes.set(evidenceKey, wake);
      while (this.evidenceWakes.size > 1000)
        this.evidenceWakes.delete(this.evidenceWakes.keys().next().value!);
    }
    for (const entry of this.resolutions.values())
      if (
        entry.state.kind === 'PENDING' &&
        (entry.state.key === key || entry.evidenceKey === evidenceKey)
      ) this.consumeWake(entry, wake);
  }

  private consumeWake(entry: ResolutionEntry, wake: ProfileWake): void {
    const key = profileKey(wake.key);
    this.wakes.delete(key);
    this.evidenceWakes.delete(entry.evidenceKey);
    if (wake.event === 'PROFILE_UNAVAILABLE') {
      entry.subject.error(new Error(wake.reason));
      this.resolutions.delete(entry.evidenceKey);
      return;
    }
    if (entry.state.kind === 'PENDING' && entry.state.key !== key) {
      // Group Meta can publish a newer revision than the requested fact. The
      // invoking evidence (not a different subscriber's key) owns this wake.
      if (entry.selector.type !== 'GROUP_META' ||
          !wake.evidence ||
          JSON.stringify(normalizeEvidence(wake.evidence)) !== entry.evidenceKey)
        return;
      entry.state = { kind: 'REQUESTING' };
      void this.webdb.getProfile({
        publisherNamespaceId: wake.key.publisherNamespaceId,
        account: wake.key.account,
        domain: wake.key.domain,
        profileNamespaceId: wake.key.profileNamespaceId,
        profileRev: wake.key.rev,
      }).then((snapshot) => {
        if (!snapshot) throw new Error('resolved Group Meta revision is missing locally');
        return this.commitReady(entry, snapshot);
      }).catch((error) => {
        if (this.resolutions.get(entry.evidenceKey) !== entry) return;
        entry.subject.error(error);
        this.resolutions.delete(entry.evidenceKey);
      });
      return;
    }
    entry.state = { kind: 'REQUESTING' };
    this.run(entry);
  }

}

function normalizeEvidence(selector: ProfileEvidence): ProfileEvidence {
  if (selector.type === 'EXACT')
    return {
      ...selector,
      account: selector.account.trim().toLowerCase(),
      domain: selector.domain.trim().toLowerCase(),
    };
  if (selector.type === 'GROUP_META' && selector.subject.type === 'MEMBER')
    return {
      ...selector,
      subject: {
        ...selector.subject,
        account: selector.subject.account.trim().toLowerCase(),
        domain: selector.subject.domain.trim().toLowerCase(),
      },
    };
  return { ...selector };
}

function profileKey(key: {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  account: string;
  domain: string;
  rev: number;
}): string {
  return JSON.stringify([
    key.publisherNamespaceId,
    key.profileNamespaceId,
    key.account.toLowerCase(),
    key.domain.toLowerCase(),
    key.rev,
  ]);
}
