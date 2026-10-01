import { Injectable, Logger } from '@nestjs/common';
import {
  ProfileLookup,
  type ProfileEvidenceProjection,
} from './profile-resolution-demand.js';
import { normalizeAccount } from '../common/account.js';
import { requireThreadContentLockInTx } from '../common/locks/thread-content-lock.js';
import { DatabaseService } from '../database/database.service.js';
import { SseService } from '../gateway/sse.service.js';
import { publishMemberMessageProfileInTx } from '../group/meta/publish-member-message-profile-in-tx.js';
import { projectP2PMessageProfileInTx } from '../message/project-p2p-message-profile-in-tx.js';

interface PendingEvidenceProjection {
  projection: ProfileEvidenceProjection;
  trailing?: ProfileEvidenceProjection;
  state: 'QUEUED' | 'ACTIVE';
}

/** Local post-fetch evidence projection queue. It never fetches profiles. */
@Injectable()
export class ProfileEvidenceProjectionService {
  private static readonly CAPACITY = 1000;
  private readonly logger = new Logger(ProfileEvidenceProjectionService.name);
  private readonly pending = new Map<string, PendingEvidenceProjection>();
  private readonly queue: string[] = [];
  private readonly cache = new Map<string, number>();

  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
  ) {}

  async resolve(projection: ProfileEvidenceProjection): Promise<void> {
    if (
      projection.profile.rev < 1 ||
      projection.profile.profileNamespaceId === 0
    )
      return;
    const key = evidenceSlotKeyString(projection);
    const evidenceValue = projection.projection.messageSeq;
    const cachedValue = this.cache.get(key);
    if (cachedValue !== undefined) {
      this.touch(key, Math.max(cachedValue, evidenceValue));
      if (cachedValue >= evidenceValue) return;
    }
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.state === 'QUEUED') {
        if (pending.projection.projection.messageSeq < evidenceValue)
          pending.projection = projection;
      } else if (
        (pending.trailing?.projection.messageSeq ??
          pending.projection.projection.messageSeq) < evidenceValue
      ) {
        pending.trailing = projection;
      }
      return;
    }
    if (this.pending.size >= ProfileEvidenceProjectionService.CAPACITY) {
      this.logger.warn(
        'profile evidence projection queue is full; skipping evidence update',
      );
      return;
    }
    this.pending.set(key, { projection, state: 'QUEUED' });
    this.queue.push(key);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const key = this.queue.shift();
      if (!key) return;
      const item = this.pending.get(key);
      if (!item || item.state !== 'QUEUED') continue;
      item.state = 'ACTIVE';
      void this.execute(key, item).finally(() => this.drain());
      return;
    }
  }

  private async execute(
    key: string,
    item: PendingEvidenceProjection,
  ): Promise<void> {
    if (this.pending.get(key) !== item) return;
    const projection = item.projection;
    try {
      const updated = await this.project(projection);
      if (updated) this.touch(key, projection.projection.messageSeq);
      if (item.trailing) {
        item.projection = item.trailing;
        item.trailing = undefined;
        item.state = 'QUEUED';
        this.queue.push(key);
        return;
      }
      this.pending.delete(key);
    } catch (error) {
      this.pending.delete(key);
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      this.logger.warn(`profile evidence projection failed: ${detail}`);
    }
  }

  private async project(
    projection: ProfileEvidenceProjection,
  ): Promise<boolean> {
    const p2pChanges = await this.database.db.transaction(async (tx) => {
      const threadLock = await requireThreadContentLockInTx(
        tx,
        projection.projection.threadId,
      );
      if (projection.lookup === ProfileLookup.ACCOUNT_PROFILE) {
        return projectP2PMessageProfileInTx(tx, {
          threadLock,
          account: normalizeAccount(projection.profile.account),
          publisherNamespaceId: projection.profile.publisherNamespaceId,
          namespaceId: projection.profile.profileNamespaceId,
          messageSeq: projection.projection.messageSeq,
          profileRev: projection.profile.rev,
        });
      }
      return (await publishMemberMessageProfileInTx(tx, {
        threadLock,
        account: normalizeAccount(projection.profile.account),
        publisherNamespaceId: projection.profile.publisherNamespaceId,
        namespaceId: projection.profile.profileNamespaceId,
        messageSeq: projection.projection.messageSeq,
        profileRev: projection.profile.rev,
      }))
        ? true
        : [];
    });
    if (p2pChanges === true) return true;
    for (const change of p2pChanges)
      this.sse.onThreadFeedUpdated(change.accountId, {
        threadFeedEndId: change.threadFeedId,
        notificationRelevant: false,
      });
    return p2pChanges.length > 0;
  }

  private touch(key: string, evidenceValue: number): void {
    const previous = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, Math.max(previous ?? 0, evidenceValue));
    while (this.cache.size > ProfileEvidenceProjectionService.CAPACITY)
      this.cache.delete(this.cache.keys().next().value!);
  }
}

function evidenceSlotKeyString(projection: ProfileEvidenceProjection): string {
  return JSON.stringify([
    projection.lookup,
    projection.profile.publisherNamespaceId,
    projection.profile.profileNamespaceId,
    projection.profile.account,
    projection.projection.threadId,
    projection.lookup === ProfileLookup.GROUP_MEMBER_PROFILE
      ? projection.groupAccount
      : null,
  ]);
}
