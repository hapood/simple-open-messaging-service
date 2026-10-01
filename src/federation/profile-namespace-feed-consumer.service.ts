import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { ProfileNamespaceFeedService } from './profile-namespace-feed.service.js';

export interface ProfileNamespaceFeedItemInput {
  namespaceId: number;
  feedId: bigint;
}

export interface ProfileNamespaceItemEffect {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  /** The triggering feed position, carried for the post-commit refresh. */
  triggerFeedId: bigint;
  /** Whether any local cache row was expired by this item. Only matched rows
   *  schedule a refresh; the client changelog records every item. */
  expiredLocalRows: boolean;
  /** The client-changelog position allocated for this change; orchestrators
   *  broadcast a wake with it after commit. */
  clientChangeId: bigint;
}

/** Applies one pulled Profile Namespace Feed item inside the pull worker's
 *  transaction: expire matching cache rows (an expired row is a tomb until
 *  the refresh converges) and record the change in the client-facing
 *  changelog. */
@Injectable()
export class ProfileNamespaceFeedConsumerService {
  constructor(private readonly feed: ProfileNamespaceFeedService) {}

  async applyItemInTx(
    tx: DatabaseTransaction,
    publisherNamespaceId: number,
    item: ProfileNamespaceFeedItemInput,
  ): Promise<ProfileNamespaceItemEffect> {
    if (
      !Number.isSafeInteger(item.namespaceId) ||
      item.namespaceId < 0 ||
      item.feedId <= 0n
    )
      throw new Error('profile namespace feed item is malformed');
    const expired = await tx.execute<{ publisherNamespaceId: number }>(sql`
      UPDATE "ProfileNamespaceInfo"
      SET expired = true, "updatedAt" = now()
      WHERE "publisherNamespaceId" = ${publisherNamespaceId}
        AND "profileNamespaceId" = ${item.namespaceId}
        AND "updateFeedId" < ${item.feedId}
      RETURNING "publisherNamespaceId"
    `);
    // The changelog entry is unconditional: devices keep their namespace
    // caches independently of this server's ProfileNamespaceInfo rows.
    const clientChangeId = await this.feed.recordClientChangeInTx(tx, {
      publisherNamespaceId,
      profileNamespaceId: item.namespaceId,
    });
    return {
      publisherNamespaceId,
      profileNamespaceId: item.namespaceId,
      triggerFeedId: item.feedId,
      expiredLocalRows: expired.rows.length > 0,
      clientChangeId,
    };
  }
}
