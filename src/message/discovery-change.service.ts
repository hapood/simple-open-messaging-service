import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  discoveryChange,
  discoveryTarget,
  message,
  threadAudience,
} from '../database/schema.js';

export interface DiscoveryHwm {
  targetDomain: string;
  localUserId: number | null;
  allocatedThrough: bigint;
}

/**
 * Writes the durable, lightweight discovery feed in the caller's message transaction. It does not
 * send SSE/S2S traffic and never copies message bodies. Per-target row locks make change ids
 * transactional and commit-ordered without serializing unrelated users or federation peers.
 */
@Injectable()
export class DiscoveryChangeService {
  async recordMessageInTx(
    tx: DatabaseTransaction,
    messageId: bigint,
    excludeTargetDomains: readonly string[] = [],
  ): Promise<DiscoveryHwm[]> {
    const [messageRow] = await tx
      .select({ threadId: message.threadId, creator: message.creator })
      .from(message)
      .where(eq(message.id, messageId))
      .limit(1);
    if (!messageRow) throw new Error(`message ${messageId} does not exist`);

    // Canonical order prevents two cross-thread writes involving the same targets from acquiring
    // their target-row locks in opposite orders.
    const audiences = await tx
      .select({
        id: threadAudience.id,
        targetDomain: threadAudience.targetDomain,
        localUserId: threadAudience.localUserId,
      })
      .from(threadAudience)
      .where(
        and(
          eq(threadAudience.threadId, messageRow.threadId),
          isNull(threadAudience.deliverThroughChangeId),
        ),
      )
      .orderBy(
        asc(threadAudience.targetDomain),
        asc(threadAudience.localUserId),
      )
      // Serialize allocation with audience freeze/revocation. If allocation wins, the closing
      // transaction includes its new change in the boundary; if closing wins, PostgreSQL rechecks
      // the active-row predicate after the lock wait and this message is not allocated.
      .for('update');

    const selectedAudiences: typeof audiences = [];
    const selectedTargets = new Set<string>();
    const excludedDomains = new Set(excludeTargetDomains);
    for (const audience of audiences) {
      // An inbound federated message must never be reflected to the server it was fetched from. Local
      // recipients and any other authorized group audiences still receive their own change.
      if (excludedDomains.has(audience.targetDomain)) continue;
      const key = `${audience.targetDomain}\u0000${audience.localUserId ?? ''}`;
      if (selectedTargets.has(key)) continue;
      selectedTargets.add(key);
      selectedAudiences.push(audience);
    }

    const result: DiscoveryHwm[] = [];
    for (const audience of selectedAudiences) {
      await tx
        .insert(discoveryTarget)
        .values({
          targetDomain: audience.targetDomain,
          localUserId: audience.localUserId,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      const [target] = await tx
        .update(discoveryTarget)
        .set({
          allocatedThrough: sql`${discoveryTarget.allocatedThrough} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(discoveryTarget.targetDomain, audience.targetDomain),
            audience.localUserId === null
              ? isNull(discoveryTarget.localUserId)
              : eq(discoveryTarget.localUserId, audience.localUserId),
          ),
        )
        .returning({
          id: discoveryTarget.id,
          allocatedThrough: discoveryTarget.allocatedThrough,
        });
      if (!target) {
        throw new Error('discovery target could not be created or locked');
      }

      await tx.insert(discoveryChange).values({
        targetId: target.id,
        changeId: target.allocatedThrough,
        audienceId: audience.id,
        threadId: messageRow.threadId,
        messageId,
      });
      result.push({
        targetDomain: audience.targetDomain,
        localUserId: audience.localUserId,
        allocatedThrough: target.allocatedThrough,
      });
    }
    return result;
  }
}
