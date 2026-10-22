import { Injectable } from '@nestjs/common';
import {
  ProfileNamespaceService,
  type ProfileNamespacePair,
  type ProfileNamespaceResolvedEntry,
} from './profile-namespace.service.js';
import { ProfileNamespaceRefreshService } from './profile-namespace-refresh.service.js';

export type ProfileNamespaceResolution =
  | { status: 'READY'; entry: ProfileNamespaceResolvedEntry }
  | { status: 'PENDING' };

/** Client demand orchestration. Cache contents and in-memory fetch work are
 * separate: a retained tomb never implies READY or an existing pending task. */
@Injectable()
export class ProfileNamespaceResolutionService {
  constructor(
    private readonly store: ProfileNamespaceService,
    private readonly refresh: ProfileNamespaceRefreshService,
  ) {}

  async resolveOne(
    pair: ProfileNamespacePair,
  ): Promise<ProfileNamespaceResolution> {
    const entry = await this.store.readOne(pair);
    if (
      entry &&
      (pair.publisherNamespaceId === 0 ||
        (!entry.expired &&
          entry.domain !== null &&
          entry.rootPublicKey !== null))
    )
      return { status: 'READY', entry };
    await this.refresh.fetch(pair);
    return { status: 'PENDING' };
  }
}
