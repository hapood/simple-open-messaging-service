import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
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
        scope: threadAudience.scope,
      })
      .from(threadAudience)
      .where(
        and(
          eq(threadAudience.threadId, messageRow.threadId),
          isNull(threadAudience.deliverThroughChangeId),
          or(
            eq(threadAudience.scope, 'THREAD'),
            and(
              eq(threadAudience.scope, 'CREATOR'),
              eq(threadAudience.creatorUserId, messageRow.creator),
            ),
          ),
        ),
      )
      .orderBy(
        asc(threadAudience.targetDomain),
        asc(threadAudience.localUserId),
        desc(threadAudience.scope),
      );

    // CREATOR sorts before THREAD and wins when both authorize the same target/message. This keeps
    // the change attached to the drainable creator grant if the current THREAD subscription is later
    // deleted. There is still exactly one change per target/message.
    const selectedAudiences: typeof audiences = [];
    const selectedTargets = new Set<string>();
    for (const audience of audiences) {
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
