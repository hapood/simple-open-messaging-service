import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  profileNamespaceFeedHead,
  profileNamespaceChangeFeed,
  profileNamespaceChangeFeedHead,
  profileNamespaceFeed,
} from '../database/schema.js';

/** Singleton key of the independent publisher feed allocator. */
const LOCAL_NAMESPACE_ID = 0;

/** Leaf persistence store for Profile Namespace feed change recording. This
 *  service deliberately depends on nothing but the database so that both the
 *  feed service and the local key-lifecycle owner (KeypairService) can record
 *  changes inside their own transactions without an import cycle. Callers
 *  MUST run these methods in the same transaction as the mutation they
 *  publish, and must already hold every business lock — the single-row head
 *  is a terminal lock. */
@Injectable()
export class ProfileNamespaceChangeStore {
  constructor(private readonly database: DatabaseService) {}

  /** Publishes one binding change of `namespaceId` by allocating the next
   *  feed position from the row-0 allocator and upserting the nsid's
   *  compacted item. Returns the allocated position. */
  async recordNamespaceChangeInTx(
    tx: DatabaseTransaction,
    namespaceId: number,
  ): Promise<bigint> {
    if (
      !Number.isSafeInteger(namespaceId) ||
      namespaceId < LOCAL_NAMESPACE_ID
    ) {
      throw new Error('namespace id must be a non-negative safe integer');
    }
    const [allocated] = await tx
      .update(profileNamespaceFeedHead)
      .set({
        endId: sql`${profileNamespaceFeedHead.endId} + 1`,
      })
      .where(eq(profileNamespaceFeedHead.id, LOCAL_NAMESPACE_ID))
      .returning({ feedId: profileNamespaceFeedHead.endId });
    if (!allocated) {
      throw new Error('local namespace sentinel row is missing');
    }
    await tx
      .insert(profileNamespaceFeed)
      .values({ namespaceId, feedId: allocated.feedId })
      .onConflictDoUpdate({
        target: profileNamespaceFeed.namespaceId,
        set: { feedId: allocated.feedId, updatedAt: sql`CURRENT_TIMESTAMP` },
      });
    return allocated.feedId;
  }

  /** A missing publisher allocator is an invariant failure, not an empty feed. */
  async readFeedEndId(): Promise<bigint> {
    const [row] = await this.database.db
      .select({ feedEndId: profileNamespaceFeedHead.endId })
      .from(profileNamespaceFeedHead)
      .where(eq(profileNamespaceFeedHead.id, LOCAL_NAMESPACE_ID))
      .limit(1);
    if (!row) throw new Error('local namespace sentinel row is missing');
    return row.feedEndId;
  }

  /** Records one client-visible binding change: allocates the next change
   *  position from the single-row head and upserts the pair's compacted
   *  item. MUST run in the same transaction as the ProfileNamespace /
   *  IdentityNamespace mutation it publishes, and callers must already hold
   *  every business lock (the head row is a terminal lock). Returns the
   *  allocated position so orchestrators can broadcast a wake after commit. */
  async recordClientChangeInTx(
    tx: DatabaseTransaction,
    pair: { publisherNamespaceId: number; profileNamespaceId: number },
  ): Promise<bigint> {
    const [head] = await tx
      .select({ endId: profileNamespaceChangeFeedHead.endId })
      .from(profileNamespaceChangeFeedHead)
      .where(eq(profileNamespaceChangeFeedHead.id, 0))
      .for('update')
      .limit(1);
    if (!head) throw new Error('profile namespace change head row is missing');
    const changeId = head.endId + 1n;
    await tx
      .insert(profileNamespaceChangeFeedHead)
      .values({ id: 0, endId: changeId })
      .onConflictDoUpdate({
        target: profileNamespaceChangeFeedHead.id,
        set: { endId: changeId },
      });
    await tx
      .insert(profileNamespaceChangeFeed)
      .values({
        publisherNamespaceId: pair.publisherNamespaceId,
        profileNamespaceId: pair.profileNamespaceId,
        changeId,
      })
      .onConflictDoUpdate({
        target: [
          profileNamespaceChangeFeed.publisherNamespaceId,
          profileNamespaceChangeFeed.profileNamespaceId,
        ],
        set: { changeId, updatedAt: sql`now()` },
      });
    return changeId;
  }
}
