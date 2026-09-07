import { Injectable, inject } from '@angular/core';
import {
  WebdbService,
  type ProfileSnapshot,
  type ProfileSelector,
  type ProfileWriteRecord,
} from './webdb.service';
import { AvatarRepository } from './avatar-cache.service';

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

  /** Cache a resolved message snapshot without changing any thread/self avatar selection. */
  async cacheProfile(
    snapshot: ProfileSnapshot,
    sourceServer: string,
  ): Promise<void> {
    try {
      await this.webdb.putProfile({ ...snapshot, sourceServer });
    } catch {
      // Cache unavailability does not prevent rendering the resolved message.
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
