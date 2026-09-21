import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, ReplaySubject } from 'rxjs';
import type { ProfileSelector as ProfileEvidence } from '../../../../shared/profile-selector';
import {
  WebdbService,
  type ProfileWake,
  type ProfileSnapshot,
  type ProfileSelector,
  type ProfileWriteRecord,
} from './webdb.service';
import { AvatarRepository } from './avatar-cache.service';
import { SessionLifecycleService } from './session-lifecycle.service';

export interface ResolvedProfile {
  namespaceId: number;
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
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

/** Profile fields written through the store (mapped from a User / Group by the caller). */
export interface ProfileData {
  id: number;
  name: string;
  account: string;
  /** Avatar path (the version tag — a change here drives {@link AvatarRepository.refresh}). */
  avatar: string;
  bio: string;
  domain: string;
  sourceServer: string;
  namespaceId: number;
  profileRev: number;
}

/**
 * The DB-layer repository for profiles (self + peer + group) — the read/write half of the strict 3-tier
 * for the profile domain. Profiles are cached by account, domain, namespace, and exact revision
 * so the UI can render last-known profile data instantly (offline / before refresh).
 *
 * Owns avatar-refresh signalling: on every {@link putProfile}, if the avatar path differs from the
 * previously-stored one, it fires {@link AvatarRepository.refresh} so the cached avatar blob stays
 * fresh. This is the signal-driven freshness path (push / SWR / reconnect deliver the new path) — NEVER
 * URL versioning. Callers (UserService.ensureProfile for self; ConversationListService for peer/group)
 * route every fresh profile through here.
 */
@Injectable({ providedIn: 'root' })
export class ProfileRepository {
  private readonly webdb = inject(WebdbService);
  private readonly avatarRepo = inject(AvatarRepository);
  private readonly resolutions = new Map<string, ResolutionEntry>();
  private readonly lru = new Map<string, ResolvedProfile>();
  private readonly evidenceKeys = new Map<string, string>();
  private readonly wakes = new Map<string, ProfileWake>();

  constructor() {
    this.webdb.profileWake$.pipe(takeUntilDestroyed()).subscribe((wake) =>
      this.onWake(wake),
    );
    inject(SessionLifecycleService)
      .ended$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        for (const entry of this.resolutions.values()) entry.subject.complete();
        this.resolutions.clear();
        this.lru.clear();
        this.evidenceKeys.clear();
        this.wakes.clear();
      });
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
      .then((result) => {
        if (result.status === 'PENDING') {
          entry.state = { kind: 'PENDING', key: profileKey(result.key) };
          const wake = this.wakes.get(entry.state.key);
          if (wake) this.consumeWake(entry, wake);
          return;
        }
        const snapshot = result.profile;
        const profile: ResolvedProfile = {
          namespaceId: snapshot.namespaceId,
          account: snapshot.account,
          domain: snapshot.domain,
          rev: snapshot.profileRev,
          name: snapshot.name,
          bio: snapshot.bio,
          avatarBase64: snapshot.avatar.startsWith('data:image/webp;base64,')
            ? snapshot.avatar.slice('data:image/webp;base64,'.length)
            : null,
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
        entry.subject.next(profile);
        entry.subject.complete();
        this.resolutions.delete(entry.evidenceKey);
      })
      .catch((error) => {
        entry.subject.error(error);
        this.resolutions.delete(entry.evidenceKey);
      })
      .finally(() => {
        entry.running = false;
        if (
          entry.rerun &&
          this.resolutions.get(entry.evidenceKey) === entry
        )
          this.run(entry);
      });
  }

  private onWake(wake: ProfileWake): void {
    const key = profileKey(wake.key);
    this.wakes.delete(key);
    this.wakes.set(key, wake);
    while (this.wakes.size > 1000)
      this.wakes.delete(this.wakes.keys().next().value!);
    for (const entry of this.resolutions.values())
      if (entry.state.kind === 'PENDING' && entry.state.key === key)
        this.consumeWake(entry, wake);
  }

  private consumeWake(entry: ResolutionEntry, wake: ProfileWake): void {
    const key = profileKey(wake.key);
    this.wakes.delete(key);
    if (wake.event === 'PROFILE_UNAVAILABLE') {
      entry.subject.error(new Error(wake.reason));
      this.resolutions.delete(entry.evidenceKey);
      return;
    }
    entry.state = { kind: 'REQUESTING' };
    this.run(entry);
  }

  /**
   * Write-through a profile. Detects an avatar-path change vs the previously-stored record and fires
   * {@link AvatarRepository.refresh} for that identity. Graceful no-op when IDB is unavailable
   * (prerender / no user) — a later miss re-fetches.
   */
  async putProfile(
    identity: string,
    kind: 'user' | 'group',
    data: ProfileData,
  ): Promise<void> {
    try {
      const prev = await this.webdb.getProfile(data);
      const record: ProfileWriteRecord = {
        identity,
        id: data.id,
        kind,
        name: data.name,
        account: data.account,
        avatar: data.avatar,
        bio: data.bio,
        domain: data.domain,
        sourceServer: data.sourceServer,
        namespaceId: data.namespaceId,
        profileRev: data.profileRev,
      };
      const written = await this.webdb.putProfile(record);
      if (written && record.avatar && record.avatar !== prev?.avatar) {
        void this.avatarRepo.refresh(identity, record.avatar).catch(() => {});
      }
    } catch {
      // IDB unavailable / closed — nothing to cache; the avatar misses + re-fetches on next render.
    }
  }

  async getProfile(
    selector: ProfileSelector,
  ): Promise<ProfileSnapshot | undefined> {
    try {
      return await this.webdb.getProfile(selector);
    } catch {
      return undefined;
    }
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
  namespaceId: number;
  account: string;
  domain: string;
  rev: number;
}): string {
  return JSON.stringify([
    key.namespaceId,
    key.account.toLowerCase(),
    key.domain.toLowerCase(),
    key.rev,
  ]);
}
